// YouTube içerik uygulaması: altyazı → çeviri → seslendirme → senkron çalma.

import { getSettings, setSettings, onSettingsChanged, chooseVoice, toneFor, voiceGender, genderVoice } from '../common/settings.js';
import { styleSpeed } from '../engines/tts/styles.js';
import { DEFAULT_VOICE } from '../engines/tts/voices.js';
import {
  GenderTracker, estimateF0, predictGender, turnGender, EARLY_VOICED, CLEAR_MALE_HZ, CLEAR_FEMALE_HZ,
  SpeakerClusters, sentenceGender, SPK_JOIN,
} from './gender.js';
import { OriginalCapture, toMono16k } from './capture.js';
import { decodePcmBase64ToInt16, encodePcmBase64, int16ToWav, trimSilenceInt16 } from '../common/pcm.js';
import { loadTranscriptEntry, saveTranscript } from '../common/transcript-store.js';
import { applyGlossary, glossaryCompiler } from '../common/glossary.js';
import { pageVideo, findPlayer, findVideo } from '../common/page.js';
import { logError } from '../common/errlog.js';
import { ProgressMarks } from './progressmarks.js';
import { VoiceAssigner } from '../common/voice-match.js';
import { pickTrack, buildJson3Url, mergeTimedTextParams, parseJson3, mergeSentences } from './captions.js';
import {
  slotSec, chooseSynthSpeed, fitRate, activeIndex, nextDue, lastPlayedAfterSeek, windowIndices, estimateSpeechSec,
  prepStatus, shouldHold, trBatchSize, HOLD_MAX_MS,
} from './timing.js';
import { callMain, sendBg } from './bridge.js';
import { Overlay, ensureToggleButton } from './overlay.js';
import { Panel } from './panel.js';
import { DubAudio, SystemVoice, Ducker, resumeAudio, videoAnalyser } from './player.js';
import { SeparatedAudio, disposeSeparation } from './separation.js';

const LOG = '[yt-tr-dub]';
const TICK_MS = 100;
const KEEP_BEHIND_SEC = 90;
const KEEP_AHEAD_EXTRA_SEC = 120;
const CACHE_VIDEOS = 5;
const PERSIST_MS = 15000;
const KEEPALIVE_MS = 60000; // oynarken motorları canlı tut (offscreen boşta bırakma: common/idle.js)
const PITCH_MS = 50;
const PEEK_SEC = 1.5; // konuşmacı tanıma: çalan cümlenin bu kadarı duyulunca en yakın kümeye bakılır

let settings = null;
let session = null;
let panel = null; // oynatıcı paneli (content/panel.js); dublaj kapalıyken de durur
const transcriptCache = new Map(); // videoId → { sentences:[{start,end,text,tr,speaker?}], trKey, kind }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class UserError extends Error {}

// İzleme sayfası, Shorts ve gömülü oynatıcı (common/page.js).
function currentVideoId() {
  return pageVideo(location)?.videoId ?? null;
}

const pageKind = () => pageVideo(location)?.kind ?? 'watch';

// Altyazı adresini bu sayfanın kökenine çevirir (youtube-nocookie gömülüsünde aynı köken isteği).
function sameOrigin(url) {
  const u = new URL(url, location.origin);
  if (/(^|\.)youtube(-nocookie)?\.com$/.test(u.hostname)) u.host = location.host;
  return u.toString();
}

// Çeviri önbelleği anahtarı: motor + (otomatik altyazıda) noktalama düzeltmesi açık mı.
function trKey(s) {
  return `${s.engineMode}|${s.mtBackend || ''}${s.fixAsrPunct ? '|p' : ''}`;
}
function audioKey(s) {
  const speakers = s.speakerVoices ? `${s.speakerCount}:${s.voice2 || ''}:${s.voice3 || ''}:${s.voice4 || ''}` : '';
  return `${s.engineMode}|${s.voice || ''}|${s.ttsSpeed}|${s.systemVoiceName || ''}|${speakers}` +
    `|${s.glossaryMt}|${s.glossaryTts}` +
    // üslup/perde/kalite/karıştırma sistem sesinde etkisizdir; yalnızca motor sesinde üretilmiş sesleri geçersiz kılar
    (s.voice === 'system' ? '' : `|${s.style}|${s.pitch}|${s.quality}|${s.voiceBlend ? `${s.voiceBlend.with}:${s.voiceBlend.amount}` : ''}` +
      `|${s.genderVoices ? 'g' : ''}${s.matchVoices ? 'm' : ''}|${JSON.stringify(s.favFemale)}|${JSON.stringify(s.favMale)}`);
}


// Çeviri ham olarak saklanır; sözlük kullanımda uygulanır (sözlük değişince yeniden çeviri gerekmez).
const mtRules = glossaryCompiler();
const ttsRules = glossaryCompiler();
const shownText = (s) => applyGlossary(s.tr, mtRules(settings.glossaryMt));
const spokenText = (s) => applyGlossary(shownText(s), ttsRules(settings.glossaryTts));

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 200, alive = () => true } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs && alive()) {
    const v = fn();
    if (v) return v;
    await sleep(intervalMs);
  }
  return null;
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return '';
    return (await res.text()).trim();
  } catch (e) {
    logError('altyazı indirme', e);
    return '';
  }
}

// ---------------------------------------------------------------------------

class Session {
  constructor(videoId) {
    this.videoId = videoId;
    this.tag = `${videoId}:${Date.now().toString(36)}`;
    this.alive = true;
    this.sentences = [];
    this.lastPlayed = -1;
    this.playingIdx = -1;
    this.enginesReady = false; // iki motorun başlatılması bitti (düğme/ilerleme durumu)
    this.mtReady = false; // çeviri döngüsü çalışabilir
    this.ttsReady = false; // seslendirme döngüsü çalışabilir
    this.ttsBroken = false;
    this.waitingApproval = false;
    this.firstBatchDone = false;
    this.audioGen = 0;
    this.trGen = 0;
    this.inAd = false;
    this._wakers = new Set();
    // başlangıç süreleri (ms, oturum başından): altyazı, motorlar, ilk çeviri, ilk ses, aktif
    this.timing = { t0: performance.now() };
    // [tanılama] ana iş parçacığı takılmaları: 50 ms'yi aşan uzun görevler (video takılmasının sayfa tarafı nedenleri için)
    this.longTasks = { n: 0, ms: 0, max: 0 };
    try {
      this._ltObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) { this.longTasks.n++; this.longTasks.ms += e.duration; this.longTasks.max = Math.max(this.longTasks.max, e.duration); }
      });
      this._ltObs.observe({ type: 'longtask' });
    } catch (e) { this._ltObs = null; /* longtask desteklenmiyor: sayaç boş kalır (günlüğe yazılmaz: beklenen) */ }
    this._hold = { done: false, active: false, since: 0, ours: false };
    // konuşanın cinsiyeti (content/gender.js): perde örnekleri, konuşmacı sırası → cinsiyet, en son duyulan
    this.pitch = new GenderTracker();
    this.genders = { turns: new Map(), recent: new Map(), last: null, fallback: null };
    // konuşmacı tanıma (engines/spk): kümeler videonun sonuna kadar (sarmada da) korunur
    this.spk = { clusters: new SpeakerClusters(), capture: null, busy: false, off: false, fails: 0 };
    // konuşmacıya benzeyen ses (common/voice-match.js): küme → { voice, pitch }; aday sesler indirilmiş olanlar
    this.match = new VoiceAssigner();
    this._matchPool = null; // null: henüz sorulmadı; Promise: soruluyor
    this._listeners = [];
    this._lastErrAt = 0;
    this._trKey = trKey(settings);
    this._audioKey = audioKey(settings);
    this.btnState = 'preparing';
    this.btnDetail = '';
  }

  // Oynatıcıdaki TR düğmesinin durumu (preparing | active | warn | error).
  _setBtn(state, detail = '') {
    if (this.btnState === state && this.btnDetail === detail) return;
    this.btnState = state;
    this.btnDetail = detail;
    if (session === this) ensureButton();
  }

  // ---- yaşam döngüsü ----

  async start() {
    const alive = () => this.alive;
    const kind = pageKind();
    this.player = await waitFor(() => findPlayer(document, kind), { alive });
    if (!this.alive || !this.player) return;
    this.video = await waitFor(() => findVideo(this.player), { alive });
    if (!this.alive || !this.video) return;

    this.overlay = new Overlay(this.player);
    this.marks = new ProgressMarks(this.player); // çubukta dublajlı bölümler (tick'te güncellenir)
    this.audio = new DubAudio();
    this.sys = new SystemVoice(sendBg);
    this.ducker = new Ducker(this.video);
    this._bindVideo();
    this.syncSeparation();

    this.overlay.setStatus('Türkçe dublaj 1/4: İngilizce altyazılar alınıyor…');
    this._setBtn('preparing', 'altyazılar alınıyor');
    // bekletme ve altyazı göstergesi altyazı gelmeden de çalışsın; motorlar altyazıyla aynı anda yüklenir
    this._tick = setInterval(() => this.tick(), TICK_MS);
    this._syncPitchTimer();
    const engines = this.initEngines();
    try {
      await this.loadCaptions();
      this._mark('captions');
    } catch (e) {
      if (!this.alive) return;
      const msg = e instanceof UserError ? e.message : 'Altyazılar alınamadı: ' + (e?.message || e);
      this.overlay.setStatus(msg, { kind: e instanceof UserError ? 'warn' : 'error', timeoutMs: 10000 });
      this._setBtn(e instanceof UserError ? 'warn' : 'error', msg);
      console.warn(LOG, e);
      sendBg({ type: 'diag.error', source: 'altyazı', message: msg });
      this._releaseHold();
      return;
    }
    if (!this.alive) return;
    if (this.enginesReady) this.overlay.clearStatus();
    else if (!this.waitingApproval) {
      this._setBtn('preparing', 'motorlar yükleniyor');
      this._engineStatus();
    }
    // Çeviriler kalıcı önbelleğe yazılır (sekme kapanırsa da kaybolmasın).
    this._persistTimer = setInterval(() => this._persist(), PERSIST_MS);
    this._keepTimer = setInterval(() => this._keepalive(), KEEPALIVE_MS);
    this._on(window, 'pagehide', () => this._persist());
    // çeviri ve seslendirme ayrı döngülerde: ilk cümlenin sesi hazırlanırken sonraki cümleler çevrilir
    this.loopTr();
    this.loopAu();
    await engines;
  }

  _mark(k) {
    if (this.timing[k] == null) this.timing[k] = Math.round(performance.now() - this.timing.t0);
  }

  // [tanılama] bellek özeti: cümle sesi blob'ları ve süreleri + ayırma paketleri/PCM (SeparatedAudio.memoryInfo)
  memoryInfo() {
    let blobs = 0, audioSec = 0;
    for (const s of this.sentences) {
      if (s.audio?.url) { blobs++; audioSec += s.audio.duration || 0; }
    }
    return {
      sentences: this.sentences.length, blobs, audioSec: Math.round(audioSec * 10) / 10,
      heapMB: Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576) || null,
      longTasks: { n: this.longTasks.n, ms: Math.round(this.longTasks.ms), max: Math.round(this.longTasks.max) },
      ...(this.separation?.memoryInfo?.() || {}),
    };
  }

  _engineStatus() {
    const n = this.sentences.length;
    const wait = this._hold.active ? ' Video hazır olunca devam edecek.' : '';
    this.overlay.setStatus(`Türkçe dublaj 2/4: çeviri ve ses motorları yükleniyor…${n ? ` (${n} cümle bulundu)` : ''}${wait}`);
  }

  // İlk "aktif": hazırlık sürelerini konsola ve tanılama kaydına yaz (yavaş sistemleri teşhis için).
  _reportTiming() {
    if (this._timingSent) return;
    this._timingSent = true;
    this._mark('active');
    const T = this.timing;
    const f = (k) => (T[k] != null ? `${(T[k] / 1000).toFixed(1)} sn` : '—');
    const held = T.heldMs ? `, video ${(T.heldMs / 1000).toFixed(1)} sn bekletildi` : '';
    const d = (k, name) => (T[k] != null ? ` (${name} ${(T[k] / 1000).toFixed(1)} sn)` : '');
    const sep = T.sepReady != null ? `, ayırma modeli ${f('sepReady')}` : '';
    const line = `aktif ${f('active')} (altyazı ${f('captions')}, çeviri motoru ${f('mt')}, ses motoru ${f('tts')}, ` +
      `ilk çeviri ${f('firstTr')}${d('trReqMs', 'istek')}, ilk ses ${f('firstAudio')}${d('synthMs', 'sentez')}${sep}${held})`;
    console.info(LOG, 'hazırlık:', line);
    sendBg({ type: 'diag.timing', line });
  }

  destroy() {
    if (!this.alive) return;
    this.alive = false;
    this._ltObs?.disconnect();
    this.marks?.destroy();
    clearInterval(this._tick);
    clearInterval(this._pitchTimer);
    clearInterval(this._persistTimer);
    clearInterval(this._keepTimer);
    this._wakeUp();
    for (const [el, ev, fn] of this._listeners) el.removeEventListener(ev, fn);
    this._listeners = [];
    this.stopSpeech();
    this._releaseHold();
    this.separation?.destroy();
    this.separation = null;
    this.spk.capture?.destroy();
    this.ducker?.destroy();
    this.overlay?.destroy();
    if (session === this) panel?.update({ session: null });
    sendBg({ type: 'jobs.cancel', tag: this.tag });
    this._saveTranscript();
    this._dropAudio();
  }

  _on(el, ev, fn) {
    el.addEventListener(ev, fn);
    this._listeners.push([el, ev, fn]);
  }

  _bindVideo() {
    const on = (el, ev, fn) => this._on(el, ev, fn);
    const v = this.video;
    on(v, 'seeking', () => { this.stopSpeech(); this._wakeUp(); });
    on(v, 'seeked', () => {
      this.pitch.prune(v.currentTime);
      this.lastPlayed = lastPlayedAfterSeek(this.sentences, v.currentTime);
      this._wakeUp();
    });
    on(v, 'pause', () => {
      this.audio.pause();
      this.sys.pause();
      this.ducker.release(0);
    });
    on(v, 'play', () => {
      // bekletme sırasında kullanıcı oynatırsa bekletme biter (videoyu ikinci kez durdurmayız). Video işleyici çalışırken
      // zaten duraklatılmışsa bu 'play' bizim bekletmemizin durdurduğu başlangıca aittir (olay gecikmeli gelir): yok sayılır,
      // yoksa bekletme biter ama video duraklatılmış kalır ve kimse sürdürmez.
      if (this._hold.active && !this._hold.resuming && !v.paused) this._endHold();
      resumeAudio();
      this._rewarm();
      if (this.audio.busy || this.sys.busy) {
        this.ducker.duck(settings.originalVolume);
        this.audio.resume();
        this.sys.resume();
      }
    });
    // Oynatıcının ses düzeyi/sessize alma dublaj sesine aynı oranda uygulanır.
    on(v, 'volumechange', () => this.applyDubVolume());
    on(v, 'ratechange', () => {
      if (this.audio.busy) this.audio.setRate((this._curRate || 1) * v.playbackRate);
    });
    // Otomatik oynatma politikası: ilk etkileşimde ses bağlamını aç.
    on(document, 'click', () => resumeAudio(), true);
    on(document, 'keydown', () => resumeAudio(), true);
  }

  // ---- gerçek dublaj: konuşmasız orijinal ses (content/separation.js) ----
  // this.separation: SeparatedAudio | null; 'state' olayı { status, backend, model, aheadSec, cachedRanges, progress,
  // rtf, message } (oynatıcı paneli de dinleyebilir). Reklamda kapatılır, reklam bitince yeniden kurulur.

  syncSeparation() {
    const ad = !!this.player?.classList.contains('ad-showing');
    const want = this.alive && this.video && settings.enabled && settings.separation === 'auto' && !ad &&
      (settings.engineMode === 'mock' || settings.modelsApproved);
    const mode = settings.engineMode === 'mock' ? 'mock' : 'real';
    if (this.separation && (!want || this.separation.mode !== mode)) {
      this.separation.destroy();
      this.separation = null;
    }
    if (this.separation) this.separation.setPrebuffer(settings.prebufferSec);
    if (!want || this.separation) return;
    const sep = new SeparatedAudio(this.video, { mode, prebufferSec: settings.prebufferSec, quality: settings.sepQuality, gpuPreference: settings.gpuPreference, otherHold: () => this._hold.active });
    sep.addEventListener('state', (ev) => this._onSepState(ev.detail));
    this.separation = sep.start();
  }

  _onSepState(st) {
    if (st.status === 'error' && st.message) this._sepLastError = st.message; // [tanılama]
    if (this.timing && st.status && st.status !== 'off' && st.status !== 'loading-model' && st.status !== 'error') this._mark('sepReady');
    const g = this._genderOn();
    if (g !== this._genderPrev) { // otomatik kadın/erkek kipi açıldı ya da kapandı: çalınmamış cümleler yeniden hazırlanır
      const first = this._genderPrev === undefined;
      this._genderPrev = g;
      if (!first && this.video) this._regender(this.video.currentTime);
    }
    if (st.status !== this._sepStatus) {
      this._sepStatus = st.status;
      console.info(LOG, `ayırma: ${st.status}${st.backend ? ` (${st.backend})` : ''} — ${st.message}`);
    }
    // video ayırma için bekletiliyorsa nedeni oynatıcıda görünsün
    const st0 = this.overlay?.status;
    if (!st0) return;
    if (this.separation?.holding) this.overlay.setStatus(st.message, { kind: 'sep' });
    else if (st0.dataset.kind === 'sep') this.overlay.clearStatus();
  }

  // Dublaj sesi = eklentideki dublaj seviyesi × oynatıcının ses seviyesi.
  dubVolume() {
    return settings.ttsVolume * (this.ducker ? this.ducker.userVolume() : 1);
  }

  applyDubVolume() {
    this.audio?.setVolume(this.dubVolume());
  }

  // ---- altyazılar ----

  async loadCaptions() {
    const cached = transcriptCache.get(this.videoId);
    if (cached?.trKey === this._trKey) {
      this.sentences = cached.sentences.map((s, i) => ({ ...s, i, audio: null }));
      this.trackKind = cached.kind;
      return;
    }
    // Daha önce izlenen video: altyazı ve çeviriler kalıcı önbellekten.
    try {
      const stored = await loadTranscriptEntry(chrome.storage.local, this.videoId, this._trKey);
      if (stored && this.alive) {
        this.sentences = stored.sentences.map((s, i) => ({ ...s, i, audio: null }));
        this.trackKind = stored.kind;
        this._savedCount = stored.sentences.filter((s) => s.tr != null).length;
        console.info(LOG, `${stored.sentences.length} cümle önbellekten (${this._savedCount} çevrili)`);
        return;
      }
    } catch (e) {
      console.warn(LOG, 'Önbellek okunamadı', e);
    }
    if (cached) {
      this.sentences = cached.sentences.map((s, i) => ({ ...s, i, tr: null, audio: null }));
      this.trackKind = cached.kind;
      return;
    }
    let info = null;
    for (let i = 0; i < 40 && this.alive; i++) {
      try { info = await callMain('get-player-response'); } catch (e) { info = null; logError('sayfa köprüsü', e); }
      if (info?.videoId === this.videoId) break;
      await sleep(250);
    }
    if (!this.alive) return;
    if (!info || info.videoId !== this.videoId) throw new Error('Video bilgisi okunamadı.');
    if (info.isLive) throw new UserError('Canlı yayınlarda dublaj desteklenmiyor.');
    const pick = pickTrack(info.captionTracks);
    if (!pick) throw new UserError('Bu videoda İngilizce altyazı bulunamadı; dublaj yapılamıyor.');

    const json = await this._fetchJson3(pick);
    const cues = parseJson3(json);
    const sentences = mergeSentences(cues);
    if (!sentences.length) throw new UserError('Altyazı boş görünüyor.');
    this.sentences = sentences.map((s, i) => ({ ...s, i, tr: null, audio: null }));
    this.trackKind = pick.kind;
    console.info(LOG, `${sentences.length} cümle (${pick.kind}, ${pick.track.languageCode})`);
  }

  async _fetchJson3(pick) {
    const { track, tlang } = pick;
    let txt = await fetchText(sameOrigin(buildJson3Url(track.baseUrl, { tlang })));
    // Yeni YouTube sürümleri timedtext için "pot" belirteci ister: oynatıcının isteğinden al.
    // Oynatıcı sayfa açılışında henüz hazır olmayabilir; birkaç kez dene.
    for (let attempt = 0; !txt && attempt < 3 && this.alive; attempt++) {
      if (attempt) await sleep(1500);
      let cap = null;
      try { cap = await callMain('get-timedtext-url', { videoId: this.videoId }); } catch (e) { logError('sayfa köprüsü', e); }
      if (!cap || !cap.includes('pot=')) {
        try {
          cap = await callMain('trigger-captions', {
            videoId: this.videoId, languageCode: track.languageCode, kind: track.kind,
          }, 20000);
        } catch (e) { logError('sayfa köprüsü', e); }
      }
      if (cap && this.alive) txt = await fetchText(sameOrigin(buildJson3Url(mergeTimedTextParams(track.baseUrl, cap), { tlang })));
    }
    if (!txt) {
      throw new UserError('Altyazı indirilemedi (YouTube boş yanıt verdi). Oynatıcıda CC düğmesini bir kez açıp kapatın, sonra TR düğmesiyle dublajı yeniden başlatın.');
    }
    try {
      return JSON.parse(txt);
    } catch {
      throw new Error('Altyazı biçimi tanınmadı (json3 bekleniyordu).');
    }
  }

  // Yeni çeviri varsa kalıcı önbelleğe yaz.
  // Oynarken offscreen'e "canlıyım" de: motorlar yalnız dublaj kapalıyken / video uzun süre durmuşken boşaltılır.
  _keepalive() {
    if (!this.alive || !this.enginesReady || !this.video || this.video.paused) return;
    sendBg({ type: 'engine.keepalive' });
  }

  // Uzun duraklamadan sonra oynatınca motorlar boşaltılmışsa ilk cümleden önce yeniden yükle (yüklüyse anında döner).
  _rewarm() {
    const now = performance.now();
    if (!this.alive || !this.enginesReady || now - (this._rewarmAt || 0) < 20000) return;
    this._rewarmAt = now;
    sendBg({ type: 'engine.init', engine: 'mt' });
    if (settings.voice !== 'system') sendBg({ type: 'engine.init', engine: 'tts' });
  }

  _persist() {
    const n = this.sentences.reduce((k, s) => k + (s.tr != null ? 1 : 0), 0);
    if (!n || n === this._savedCount) return;
    this._savedCount = n;
    saveTranscript(chrome.storage.local, this.videoId, this._trKey, this.sentences, this.trackKind)
      .catch((e) => console.warn(LOG, 'Önbelleğe yazılamadı', e));
  }

  _saveTranscript() {
    this._persist();
    if (!this.sentences.length) return;
    transcriptCache.delete(this.videoId);
    transcriptCache.set(this.videoId, {
      trKey: this._trKey,
      kind: this.trackKind,
      sentences: this.sentences.map(({ start, end, text, tr, speaker }) => ({ start, end, text, tr: tr ?? null, ...(speaker ? { speaker } : {}) })),
    });
    while (transcriptCache.size > CACHE_VIDEOS) transcriptCache.delete(transcriptCache.keys().next().value);
  }

  // ---- motorlar ----

  initEngines() {
    if (this._initing) return this._initing;
    this._initing = this._initEngines().finally(() => { this._initing = null; });
    return this._initing;
  }

  async _initEngines() {
    this.enginesReady = false;
    this.mtReady = false;
    this.ttsReady = false;
    if (settings.engineMode === 'real' && !settings.modelsApproved) {
      this.waitingApproval = true;
      this.overlay.setStatus('Dublaj için modeller hazırlanmalı: eklenti simgesine tıklayıp "Modelleri hazırla" düğmesine basın.', { kind: 'warn' });
      this._setBtn('warn', 'modeller hazırlanmalı');
      this._releaseHold();
      return false;
    }
    this.waitingApproval = false;
    if (this.sentences.length) {
      this._setBtn('preparing', 'motorlar yükleniyor');
      this._engineStatus();
    }
    const useSystem = settings.voice === 'system';
    // her motor hazır olur olmaz kendi döngüsünü başlatır (önbellekte çevirisi olan video çeviri motorunu beklemez)
    const t0 = performance.now();
    const [mt, tts] = await Promise.all([
      sendBg({ type: 'engine.init', engine: 'mt' }).then((r) => {
        if (r.ok && this.alive) { this.timing.mt ??= Math.round(performance.now() - t0); this.mtReady = true; this._wakeUp(); }
        return r;
      }),
      (useSystem ? Promise.resolve({ ok: true }) : sendBg({ type: 'engine.init', engine: 'tts' })).then((r) => {
        if (r.ok && this.alive) { if (!useSystem) this.timing.tts ??= Math.round(performance.now() - t0); this.ttsReady = true; this._wakeUp(); }
        return r;
      }),
    ]);
    if (!this.alive) return false;
    if (!mt.ok) {
      this.overlay.setStatus('Çeviri motoru başlatılamadı: ' + mt.error, { kind: 'error' });
      this._setBtn('error', 'çeviri motoru başlatılamadı');
      this._releaseHold();
      return false;
    }
    this.ttsBroken = !tts.ok;
    if (!tts.ok) {
      this.overlay.setStatus('Ses motoru başlatılamadı, yalnızca altyazı gösterilecek: ' + tts.error, { kind: 'warn', timeoutMs: 12000 });
    } else if (this.sentences.length) {
      this.overlay.clearStatus();
    }
    this.enginesReady = true;
    this._wakeUp();
    return true;
  }

  onProgress(p) {
    this.overlay?.setProgress(p);
    // Uzun indirmede ilk istek zaman aşımına uğramış olabilir: hazır olunca yeniden bağlan.
    if (p.done && !this.enginesReady && !this.waitingApproval && this.sentences.length && !this._reinit) {
      this._reinit = true;
      setTimeout(() => { this._reinit = false; if (this.alive && !this.enginesReady) this.initEngines(); }, 300);
    }
  }

  // ---- ileri-bakış hattı ----

  _wakeUp() {
    const ws = [...this._wakers];
    this._wakers.clear();
    for (const w of ws) w();
  }

  _sleepWake(ms) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this._wakers.delete(done); resolve(); };
      const t = setTimeout(done, ms);
      this._wakers.add(done);
    });
  }

  // Çeviri ve seslendirme birbirini beklemeden çalışır (ayrı motorlar, ayrı iş parçacıkları).
  async loopTr() {
    await this._loop(() => this.mtReady, () => this.stepTr());
  }

  async loopAu() {
    await this._loop(() => this.ttsReady && !this.ttsBroken && settings.voice !== 'system', () => this.stepAu());
  }

  async _loop(ready, step) {
    while (this.alive) {
      let did = false;
      if (ready() && !this.inAd && this.sentences.length) {
        try {
          did = await step();
        } catch (e) {
          this._reportError(e);
          await this._sleepWake(1500);
        }
      }
      if (!this.alive) break;
      if (!did) await this._sleepWake(ready() ? 400 : 1000);
    }
  }

  // Oynatma konumuna en yakın çevrilmemiş cümlelerden başlayarak çevirir.
  async stepTr() {
    const S = this.sentences;
    const t = this.video.currentTime;
    const needTr = windowIndices(S, t, settings.lookaheadSec, (s) => s.tr == null && !s.trPending);
    if (!needTr.length) return false;
    const batch = needTr.slice(0, trBatchSize(S[needTr[0]], t, { first: !this.firstBatchDone }));
    const gen = this.trGen;
    for (const i of batch) S[i].trPending = true;
    const tReq = performance.now();
    const res = await sendBg({
      type: 'mt.translate', sentences: batch.map((i) => S[i].text), tag: this.tag,
      restore: this.trackKind === 'asr', // otomatik altyazı: çeviri öncesi noktalama (ayar ve model açıksa)
    });
    for (const i of batch) S[i].trPending = false;
    if (!this.alive || gen !== this.trGen) return true;
    if (!res.ok) {
      if (res.code === 'ABORTED') return true;
      for (const i of batch) {
        S[i].trFail = (S[i].trFail || 0) + 1;
        if (S[i].trFail >= 3) S[i].tr = '';
      }
      throw new Error('Çeviri hatası: ' + res.error);
    }
    batch.forEach((i, k) => { S[i].tr = String(res.result[k] ?? '').trim(); });
    this.firstBatchDone = true;
    if (this.timing.trReqMs == null) this.timing.trReqMs = Math.round(performance.now() - tReq); // ilk çeviri isteğinin süresi
    this._mark('firstTr');
    this._wakeUp(); // seslendirme döngüsü yeni çeviriyi beklemesin
    return true;
  }

  // Çevirisi hazır, sesi olmayan en yakın cümleyi seslendirir (sistem sesi önceden sentez gerektirmez).
  async stepAu() {
    const t = this.video.currentTime;
    const needAu = windowIndices(this.sentences, t, settings.lookaheadSec, (s) => s.tr && !s.audio && !s.auPending && !s.auFailed);
    if (needAu.length) {
      const tSyn = performance.now();
      await this.synth(needAu[0]);
      if (this.timing.synthMs == null) this.timing.synthMs = Math.round(performance.now() - tSyn); // ilk sentezin süresi
      if (this.sentences[needAu[0]]?.audio) this.sentences[needAu[0]].dubbed = true; // çubukta işaretli kalsın (bellekten atılsa da)
      this._mark('firstAudio');
      this._prewarmVoices();
      return true;
    }
    this._evict(t);
    return false;
  }

  async synth(i) {
    const S = this.sentences;
    const s = S[i];
    const gen = this.audioGen;
    const slot = slotSec(S, i);
    const text = spokenText(s);
    const voice = this.voiceFor(s);
    const key = this._voiceKey(s);
    const m = this._match(s);
    let tone = toneFor(settings, voice);
    if (m?.pitch && m.voice === voice) tone = { ...tone, pitch: tone.pitch + m.pitch };
    // üslubun hız çarpanı temel hıza katılır (sığdırma hesabı bunu bilir); favori sesin üslubu kendi tonundan
    const speed = chooseSynthSpeed(text, slot, { base: settings.ttsSpeed * (voice === 'system' ? 1 : styleSpeed(tone.style)) });
    s.auPending = true;
    const res = await sendBg({ type: 'tts.synthesize', text, voice, speed, tone, tag: this.tag });
    s.auPending = false;
    if (!this.alive || gen !== this.audioGen) return;
    // sentez sürerken konuşanın cinsiyeti değiştiyse bu ses atılır, döngü doğru sesle yeniden üretir
    if (res.ok && this._voiceKey(s) !== key) return;
    if (!res.ok) {
      if (res.code === 'ABORTED') return;
      s.auFail = (s.auFail || 0) + 1;
      if (s.auFail >= 2) s.auFailed = true;
      throw new Error('Seslendirme hatası: ' + res.error);
    }
    const r = res.result || {};
    console.debug(LOG, `ses ${i}: ${voice}`);
    if (r.system) { s.audio = { system: true, speed, voice, key }; return; }
    if (!r.pcmBase64) { s.audio = { empty: true, voice, key }; return; }
    const sr = r.sampleRate || 22050;
    const i16 = trimSilenceInt16(decodePcmBase64ToInt16(r.pcmBase64), sr);
    if (!i16.length) { s.audio = { empty: true, voice, key }; return; }
    const url = URL.createObjectURL(new Blob([int16ToWav(i16, sr)], { type: 'audio/wav' }));
    s.audio = { url, duration: i16.length / sr, speed, voice, key };
  }

  // ---- konuşanın cinsiyeti (settings.genderVoices) ----
  // Konuşmacı tanıma (engines/spk) açıkken: her cümlenin sesinden konuşmacı vektörü → kümeler (gender.js
  // SpeakerClusters); aynı küme hep aynı sesle, kümenin cinsiyeti bütün cümlelerinin kanıtıyla bir kez verilir.
  // Ses kaynağı: ayırma açıksa temiz konuşma (separation.speechAt, cümle çalmadan önce), değilse orijinal sesin
  // kaydı (capture.js, cümle bitince; çalan cümlenin ilk ≈ 1.5 sn'si en yakın kümeye bakılarak erken tahmin).
  // Motor yoksa (onaysız model, hata) eski yol: cümle başına perde (_measureGender).

  // Otomatik kadın/erkek yalnız ses ayırma çalışırken etkindir: ölçüm (docs/SES-AYIRMA.md, tools/spk-eval.mjs) temiz
  // konuşmada yeterli isabeti gösterdi; müzikli orijinal sesten tek ses kalır.
  _genderOn() {
    const st = this.separation?.state?.status;
    return !!(settings.genderVoices && settings.voice !== 'system' && settings.separation === 'auto' && st && st !== 'off' && st !== 'error');
  }

  // chooseVoice için etkin ayarlar (genderVoices = _genderOn)
  _eff() {
    return { ...settings, genderVoices: this._genderOn() };
  }

  _spkOn() {
    return this._genderOn() && !this.spk.off;
  }

  // Cümlenin sesi: cinsiyet modu açıksa tahmin edilen cinsiyetin sesi (favori öncelikli), değilse konuşmacı sırası.
  voiceFor(s) {
    if (this._spkOn()) {
      const m = this._match(s);
      if (m) return m.voice;
      const { gender, id } = this._spkPredict(s);
      return chooseVoice(this._eff(), { speaker: s.speaker, gender, alt: id != null ? this.spk.clusters.altOf(id) : 0 });
    }
    const G = this.genders;
    const gender = this._genderOn() ? predictGender(s, {
      ...G, fallback: voiceGender(settings, settings.voice || DEFAULT_VOICE),
    }) : null;
    // sırayla modunda aynı cinsiyetten iki konuşmacı: komşu sıra da bu cinsiyettense ikinci ses
    const turn = s.speaker || 0;
    const neighbour = G.turns.get(turn - 1) ?? G.turns.get(turn + 1);
    const alt = gender && neighbour === gender ? turn % 2 : 0;
    return chooseVoice(this._eff(), { speaker: s.speaker, gender, alt });
  }

  // Sesin kimliği + perde ayarı: hazırlanmış sesin hâlâ geçerli olup olmadığı bununla karşılaştırılır.
  _voiceKey(s) {
    const v = this.voiceFor(s);
    const m = this._match(s);
    return m && m.voice === v && m.pitch ? `${v}|${m.pitch}` : v;
  }

  // ---- konuşmacıya benzeyen ses (settings.matchVoices) ----
  _matchOn() {
    return !!settings.matchVoices && this._spkOn();
  }

  // Cümlenin konuşanına atanmış ses ({ voice, pitch }) ya da null (atama yok / özellik kapalı).
  _match(s) {
    if (!this._matchOn()) return null;
    const { id, gender } = this._spkPredict(s);
    const m = id == null ? null : this.match.get(this.spk.clusters.resolve(id));
    return m && m.gender === gender ? m : null;
  }

  // Aday sesler: indirilmiş ve perdesi bilinen sesler (engines/tts/voices.js f0). Bir kez sorulur.
  _loadMatchPool() {
    if (this._matchPool) return;
    this._matchPool = sendBg({ type: 'engine.list' }).then((res) => {
      if (!this.alive) return;
      const voices = (res.ok && res.result?.voices) || [];
      this.match.setPool(voices.filter((v) => v.cached && v.f0));
      console.debug(LOG, `benzeyen ses adayları: ${this.match.pool.map((v) => v.id).join(', ') || 'yok'}`);
      this._assignMatches();
    }, (e) => logError('ses eşleme', e));
  }

  // Yeterli perde kanıtı toplamış kümelere ses ata; yeni atama olduysa hazırlanmış sesleri yenile.
  _assignMatches() {
    if (!this._matchOn()) return;
    if (!this._matchPool) { this._loadMatchPool(); return; }
    const C = this.spk.clusters;
    let changed = false;
    for (const c of C.clusters.values()) {
      const had = this.match.get(c.id);
      if (had && had.gender === c.gender) continue;
      // kümenin cinsiyet kararı döndü (yalnız güçlü kanıtla olur): o cinsiyetten yeniden seçilir
      if (had) this.match.byId.delete(c.id);
      // birleşmiş kümenin eski kimliğinin ataması varsa o korunur (konuşmacının sesi değişmesin)
      const old = had ? null : [...C.alias.keys()].find((k) => C.resolve(k) === c.id && this.match.get(k)?.gender === c.gender);
      if (old != null) { this.match.byId.set(c.id, this.match.get(old)); continue; }
      const a = this.match.assign({ id: c.id, gender: c.gender, hz: C.medianHz(c), nf0: c.nf0 });
      if (!a) continue;
      changed = true;
      console.info(LOG, `konuşmacı ${c.id} (${a.gender === 'female' ? 'kadın' : 'erkek'}, ${a.hz} Hz) → ${a.voice}` +
        `${a.pitch ? ` ${a.pitch > 0 ? '+' : ''}${a.pitch} yarım ton` : ''}`);
      // ses başka modelse arka planda yükle: ilk cümlesinde takılmasın
      sendBg({ type: 'tts.synthesize', text: 'Merhaba.', voice: a.voice, speed: 1, tone: toneFor(settings, a.voice), tag: this.tag })
        .catch(() => { /* ısınma: hata önemsiz */ });
    }
    if (changed) this._regender(this.video?.currentTime ?? 0);
  }

  // Bilgisi olan cümlenin konuşmanı: { gender, id } (id: küme) ya da null.
  _spkInfo(s) {
    const C = this.spk.clusters;
    for (const k of [s.spk, s.peek]) {
      if (k?.id != null && C.genderOf(k.id)) return { gender: C.genderOf(k.id), id: C.resolve(k.id) };
      if (k?.gender) return { gender: k.gender, id: null };
    }
    return null;
  }

  // Cümlenin konuşanı: kendi kümesi → önceki cümlelerden (>> varsa aynı sıranın, sonra iki sıra öncesinin, yoksa en
  // yakın) bilineni → birinci sesin cinsiyeti.
  _spkPredict(s) {
    const own = this._spkInfo(s);
    if (own) return own;
    const S = this.sentences;
    let near = null;
    let turn2 = null;
    for (let i = (s.i ?? S.length) - 1; i >= 0 && i >= (s.i ?? S.length) - 40; i--) {
      const p = this._spkInfo(S[i]);
      if (!p) continue;
      const a = s.speaker || 0;
      const b = S[i].speaker || 0;
      if (a === b) return p;
      near ||= p;
      if (!turn2 && b === a - 2) turn2 = p;
    }
    return turn2 || near || { gender: voiceGender(settings, settings.voice || DEFAULT_VOICE), id: null };
  }

  // İlk ses hazır olunca diğer cinsiyetin sesini arka planda yükle: konuşan ilk kez değiştiğinde model yüklenirken
  // dublaj takılmasın (motor en çok iki modeli bellekte tutar; Supertonic sesleri tek pakettir).
  _prewarmVoices() {
    if (this._prewarmed || !this._genderOn()) return;
    this._prewarmed = true;
    const primary = chooseVoice(this._eff(), { gender: voiceGender(settings, settings.voice || DEFAULT_VOICE) });
    for (const g of ['female', 'male']) {
      const v = genderVoice(settings, g);
      if (v && v !== primary) sendBg({ type: 'tts.synthesize', text: 'Merhaba.', voice: v, speed: 1, tone: toneFor(settings, v), tag: this.tag })
        .then((r) => { if (r && !r.ok && r.code !== 'ABORTED') logError('ses ısıtma', r.error); }).catch((e) => logError('ses ısıtma', e));
    }
  }

  // Sıradaki gömme işi (tek seferde bir): ayırmanın temiz konuşması (ileri cümleler) → biten cümlenin kaydı →
  // çalan cümlenin başı (erken bakış).
  _embedSpeakers(t) {
    if (!this._spkOn() || this.spk.busy || this.inAd) return;
    const S = this.sentences;
    const sep = this.separation;
    const now = performance.now();
    if (typeof sep?.speechAt === 'function') {
      for (const s of S) {
        if (s.start > t + settings.lookaheadSec) break;
        if (s.spk || s.end < t - 1 || now - (s.spkTry || 0) < 1500) continue;
        let sp = null;
        try { sp = sep.speechAt(s.start, s.end); } catch (e) { sp = null; logError('ayırma konuşma izi', e); }
        const pcm = sp && toMono16k(sp);
        if (!pcm) { s.spkTry = now; continue; }
        this._embed(s, pcm, 'ayırma');
        return;
      }
    }
    const v = this.video;
    if (!v || v.paused) return;
    const cap = this.spk.capture || (this.spk.capture = new OriginalCapture(v));
    if (!cap.start()) return;
    for (const s of S) {
      if (s.start > t) break;
      if (s.spk || s.end < t - 6) continue;
      if (s.end <= t) {
        const pcm = cap.range(s.start, s.end);
        if (pcm) { this._embed(s, pcm, 'kayıt'); return; }
        s.spk = { none: true };
        continue;
      }
      if (!s.peek && t - s.start >= PEEK_SEC) {
        const pcm = cap.range(s.start, t);
        if (pcm) { this._embed(s, pcm, 'kayıt', true); return; }
        s.peek = { none: true };
      }
    }
  }

  async _embed(s, pcm, src, peek = false) {
    this.spk.busy = true;
    let res;
    try {
      res = await sendBg({ type: 'spk.embed', pcmBase64: encodePcmBase64(pcm), tag: this.tag });
    } finally {
      this.spk.busy = false;
    }
    if (!this.alive) return;
    if (!res.ok) {
      if (res.code === 'ABORTED') return;
      if (peek) s.peek = { none: true }; else s.spk = { none: true };
      if (res.code === 'NOT_APPROVED' || ++this.spk.fails >= 3) {
        this.spk.off = true;
        console.info(LOG, 'konuşmacı tanıma kapalı, perdeye dönülüyor:', res.error);
      }
      return;
    }
    this.spk.fails = 0;
    const r = res.result || {};
    const C = this.spk.clusters;
    const vec = r.vector ? Float32Array.from(r.vector) : null;
    const before = this._spkPredict({ i: this.sentences.length, speaker: s.speaker });
    if (peek) {
      // yalnız bakış: kümelere eklenmez (cümle bitince tamamı eklenir)
      const near = vec ? C.nearest(vec) : null;
      s.peek = near?.cluster && near.sim >= SPK_JOIN ? { id: near.cluster.id } : { gender: sentenceGender(r) };
    } else {
      s.spk = { src };
      if (vec) s.spk.id = C.assign(vec, { w: Math.min(r.voicedSec || 1, 4), ev: { f0: r.f0, score: r.score } });
      else s.spk.gender = sentenceGender(r);
      if (vec) this._assignMatches();
    }
    const t = this.video.currentTime;
    const k = peek ? s.peek : s.spk;
    console.debug(LOG, `konuşmacı ${s.i}${peek ? ' (erken)' : ''}: ${k.id != null ? `küme ${C.resolve(k.id)} ${C.genderOf(k.id) || '?'} ${Math.round(C.medianHz(k.id))} Hz` : k.gender || '?'}` +
      ` (${src}, ${(r.voicedSec || 0).toFixed(1)} sn ses, ${r.f0?.length || 0} perde)`);
    const cur = this._spkPredict({ i: this.sentences.length, speaker: s.speaker });
    if (cur.gender && (cur.gender !== this.genders.last || cur.id !== before.id)) {
      const hz = Math.round(cur.id != null ? C.medianHz(cur.id) : 0) || this.genders.hz || 0;
      if (cur.gender !== this.genders.last) {
        console.info(LOG, `konuşan: ${cur.gender === 'female' ? 'kadın' : 'erkek'} (${hz} Hz, ${t.toFixed(1)} sn, ` +
          `${cur.id != null ? `küme ${cur.id}` : 'tek cümle'}, ${src}${peek ? ', erken' : ''})`);
      }
      this.genders.last = cur.gender;
      this.genders.hz = hz || null;
    }
    this._regender(t);
  }

  /** Eski perde yolu (ayırma kapalıyken kadın/erkek) dışında 50 ms'lik örnekleme zamanlayıcısı çalışmaz. */
  _syncPitchTimer() {
    const need = this.alive && this._genderOn() && !this._spkOn();
    if (need && !this._pitchTimer) this._pitchTimer = setInterval(() => this._samplePitch(), PITCH_MS);
    else if (!need && this._pitchTimer) { clearInterval(this._pitchTimer); this._pitchTimer = null; }
  }

  _samplePitch() {
    if (!this._genderOn() || this.inAd || this._spkOn()) return;
    const v = this.video;
    if (!v || v.paused || v.seeking) return;
    const an = this._analyser || (this._analyser = videoAnalyser(v));
    if (!an) return;
    const buf = this._pitchBuf || (this._pitchBuf = new Float32Array(an.fftSize));
    an.getFloatTimeDomainData(buf);
    this.pitch.push(v.currentTime, estimateF0(buf, an.context.sampleRate));
  }

  // Eski yol (konuşmacı tanıma yokken): biten cümlelerin perdesini ölç; konuşmacı sırasının cinsiyetini güncelle
  // (gender.js turnGender). Çalan cümlede ilk ≈ 0.5 sn'lik konuşma belirgin bir cinsiyet gösterir ve beklenenden
  // farklıysa karar hemen verilir (erken karar); bitişteki tam ölçüm yine yapılır.
  _measureGender(t) {
    if (!this._genderOn() || this._spkOn()) return;
    const G = this.genders;
    let changed = false;
    for (const s of this.sentences) {
      if (!s.early && !s.measured && s.start <= t && s.end > t) {
        const m = this.pitch.measure(s.start, t, { min: EARLY_VOICED });
        if (!m?.gender || (m.hz >= CLEAR_MALE_HZ && m.hz <= CLEAR_FEMALE_HZ)) continue;
        s.early = true;
        const turn = s.speaker || 0;
        if (G.turns.get(turn) === m.gender && G.last === m.gender) continue;
        changed = true;
        console.info(LOG, `konuşan: ${m.gender === 'female' ? 'kadın' : 'erkek'} (${m.hz} Hz, ${t.toFixed(1)} sn, erken)`);
        G.turns.set(turn, m.gender);
        G.last = m.gender;
        G.hz = m.hz;
        continue;
      }
      if (s.measured || s.end > t || s.end < t - 5) continue;
      s.measured = true;
      const m = this.pitch.measure(s.start, s.end);
      if (!m?.gender) continue;
      s.gender = m.gender;
      const turn = s.speaker || 0;
      if (!G.recent.has(turn)) G.recent.set(turn, []);
      const maj = turnGender(G.recent.get(turn), m);
      if (G.turns.get(turn) !== maj || G.last !== maj) {
        changed = true;
        console.info(LOG, `konuşan: ${maj === 'female' ? 'kadın' : 'erkek'} (${m.hz} Hz, ${t.toFixed(1)} sn)`);
      }
      G.turns.set(turn, maj);
      G.last = maj;
      G.hz = m.hz;
    }
    if (changed) this._regender(t);
  }

  // Tahmin değişti: henüz çalınmamış ve artık uymayan sesle hazırlanmış cümleleri bırak (yeniden üretilecekler).
  _regender(t) {
    let n = 0;
    for (const s of this.sentences) {
      if (s.start <= t || s.i === this.playingIdx || !s.audio?.voice) continue;
      if ((s.audio.key ?? s.audio.voice) === this._voiceKey(s)) continue;
      if (s.audio.url) URL.revokeObjectURL(s.audio.url);
      s.audio = null;
      n++;
    }
    if (n) { console.debug(LOG, `${n} cümle yeni sesle hazırlanacak`); this._wakeUp(); }
  }

  _evict(t) {
    const hi = t + settings.lookaheadSec + KEEP_AHEAD_EXTRA_SEC;
    for (const s of this.sentences) {
      if (s.audio && (s.end < t - KEEP_BEHIND_SEC || s.start > hi) && s.i !== this.playingIdx) {
        if (s.audio.url) URL.revokeObjectURL(s.audio.url);
        s.audio = null;
      }
    }
  }

  _dropAudio() {
    for (const s of this.sentences) {
      if (s.audio?.url) URL.revokeObjectURL(s.audio.url);
      s.audio = null;
      s.auPending = false;
      s.auFailed = false;
      s.auFail = 0;
    }
  }

  // Ayar değişimi: ses ve/veya çeviri yeniden üretilir.
  invalidate({ translations = false, audio = true } = {}) {
    sendBg({ type: 'jobs.cancel', tag: this.tag });
    this.tag = `${this.videoId}:${Date.now().toString(36)}`;
    this.stopSpeech();
    if (audio || translations) { this.audioGen++; this._dropAudio(); }
    if (translations) {
      this._persist(); // eski motorun çevirileri kendi anahtarıyla kalsın
      this._savedCount = 0;
      this.trGen++;
      for (const s of this.sentences) { s.tr = null; s.trPending = false; s.trFail = 0; }
      this.firstBatchDone = false;
    }
    this._trKey = trKey(settings);
    this._audioKey = audioKey(settings);
    this._wakeUp();
  }

  _reportError(e) {
    console.warn(LOG, e);
    const now = Date.now();
    if (now - this._lastErrAt < 8000) return;
    this._lastErrAt = now;
    this.overlay?.setStatus(String(e?.message || e), { kind: 'error', timeoutMs: 8000 });
  }

  // ---- oynatma senkronu ----

  stopSpeech() {
    this.audio?.stop();
    this.sys?.stop();
    this.playingIdx = -1;
    this.ducker?.release(0);
  }

  tick() {
    if (!this.alive) return;
    this.syncSeparation(); // ayar, motor ve reklam durumuna göre kur / kaldır
    this._syncPitchTimer();
    this._tickHold();
    if (panel && session === this && performance.now() - (this._panelAt || 0) >= 200) {
      this._panelAt = performance.now();
      panel.update({ session: this._panelState() });
    }
    if (!this.sentences.length) return;
    const v = this.video;
    const S = this.sentences;

    const ad = this.player.classList.contains('ad-showing');
    if (ad !== this.inAd) {
      this.inAd = ad;
      if (ad) { this.stopSpeech(); this.overlay.setText(''); }
      else { this.lastPlayed = lastPlayedAfterSeek(S, v.currentTime); this._wakeUp(); }
    }
    if (ad) return;

    const t = v.currentTime;
    this._measureGender(t);
    this._embedSpeakers(t);
    const ai = activeIndex(S, t);
    this.overlay.setText(settings.showSubtitles && ai >= 0 ? (S[ai].tr ? shownText(S[ai]) : '') : '');
    if (this.enginesReady) this._updatePrep(t);
    const nowMs = performance.now();
    if (!this._marksAt || nowMs - this._marksAt > 500) { this._marksAt = nowMs; this.marks?.update(S, v.duration); }

    if (v.paused || v.seeking || !(this.mtReady || this.ttsReady)) return;
    if (this.audio.busy || this.sys.busy) return; // sıradaki bekler

    const due = nextDue(S, t, this.lastPlayed);
    if (due.skipped.length) this.lastPlayed = Math.max(this.lastPlayed, ...due.skipped);
    if (due.index < 0) return;
    const idx = due.index;
    const s = S[idx];
    if (s.tr == null) return; // çeviri bekleniyor
    if (!s.tr) { this.lastPlayed = idx; return; }

    const remaining = s.start + slotSec(S, idx) - t;
    if (settings.voice === 'system' || s.audio?.system) {
      this.lastPlayed = idx;
      this._playSystem(idx, remaining);
      return;
    }
    if (!s.audio) {
      if (this.ttsBroken || s.auFailed) this.lastPlayed = idx;
      return; // sentez bekleniyor (gecikme sınırı nextDue'da)
    }
    this.lastPlayed = idx;
    if (s.audio.empty) return;
    this._playPcm(idx, remaining);
  }

  // Sıradaki cümle hazır değilse hangi aşamada beklendiğini göster; hata/uyarı mesajlarının üzerine yazma.
  _updatePrep(t) {
    const needAudio = !this.ttsBroken && settings.voice !== 'system';
    const p = prepStatus(this.sentences, t, settings.lookaheadSec, { needAudio });
    if (p) this._setBtn('preparing', p.phase === 'translate' ? 'çevriliyor' : 'ses hazırlanıyor');
    else if (this.ttsBroken) this._setBtn('warn', 'ses motoru yok, yalnızca altyazı');
    else { this._setBtn('active'); this._reportTiming(); }

    const st = this.overlay.status;
    const ours = st.dataset.kind === 'prep';
    if (st.classList.contains('visible') && !ours) return;
    if (!p) {
      if (ours) this.overlay.clearStatus();
      return;
    }
    const wait = this._hold.active ? ' Video hazır olunca devam edecek.' : '';
    const text = (p.phase === 'translate'
      ? `Türkçe dublaj 3/4: Türkçeye çevriliyor… (${p.done}/${p.total} cümle hazır)`
      : `Türkçe dublaj 4/4: Türkçe ses hazırlanıyor… (${p.done}/${p.total} cümle hazır)`) + wait;
    if (!ours || st.textContent !== text) this.overlay.setStatus(text, { kind: 'prep' });
  }

  // ---- oynatıcı paneli (content/panel.js) ----

  // Panelin görünüm modeli: hazırlık adımları, çalan cümlenin sesi, ölçülen konuşan, bekletme, ses ayırma.
  _panelState() {
    const S = this.sentences;
    const v = this.video;
    const t = v?.currentTime || 0;
    const sys = settings.voice === 'system';
    const failed = this.timing.captions == null && (this.btnState === 'warn' || this.btnState === 'error') && !this.waitingApproval;
    const nTr = S.reduce((k, s) => k + (s.tr != null ? 1 : 0), 0);
    const nAu = S.reduce((k, s) => k + (s.audio ? 1 : 0), 0);
    // önbellek: oynatma konumundan sonra sesi (ya da boş çevirisi) hazır, kesintisiz cümleler
    let ahead = 0;
    for (const s of S) {
      if (s.end <= t) continue;
      if (!(sys ? s.tr != null : s.audio || s.tr === '')) break;
      ahead = s.end - t;
    }
    const p = this.playingIdx >= 0 ? S[this.playingIdx] : null;
    const speaking = p && !v.paused && (sys || p.audio?.system ? this.sys.busy : this.audio.busy && !this.audio.paused)
      ? { idx: this.playingIdx, voice: p.audio?.voice || (sys ? 'system' : null) } : null;
    const st = this.overlay?.status;
    const h = this._hold;
    const sepAhead = this.separation?.state?.aheadSec;
    return {
      notice: st?.classList.contains('visible') ? { text: st.textContent, kind: st.dataset.kind || 'info' } : null,
      steps: {
        captions: S.length ? { status: 'done', text: `${S.length} cümle` }
          : failed ? { status: this.btnState, text: this.btnDetail } : { status: 'active', text: 'alınıyor…' },
        mt: this.mtReady ? { status: 'done', text: `${nTr}/${S.length} çevrildi` }
          : this.waitingApproval ? { status: 'warn', text: 'modeller hazırlanmalı' } : { status: 'active', text: 'yükleniyor…' },
        tts: sys ? { status: 'done', text: 'Sistem sesi' } : this.ttsBroken ? { status: 'error', text: 'başlatılamadı' }
          : this.ttsReady ? { status: 'done', text: `${nAu} ses hazır` }
          : this.waitingApproval ? { status: 'warn', text: 'modeller hazırlanmalı' } : { status: 'active', text: 'yükleniyor…' },
        cache: !S.length ? { status: 'wait', text: '—' }
          : { status: ahead >= 8 ? 'done' : ahead > 0 ? 'active' : 'wait', text: `${Math.floor(ahead)} sn ileri hazır`, pct: Math.min(1, ahead / settings.lookaheadSec) },
      },
      speaking,
      level: this.audio?.gain || null,
      speaker: this.genders.last ? { gender: this.genders.last, hz: this.genders.hz || null } : null,
      hold: h.active ? { sec: (performance.now() - h.since) / 1000, maxSec: HOLD_MAX_MS / 1000, aheadSec: Number.isFinite(sepAhead) ? sepAhead : null } : null,
      separation: this.separation || null,
    };
  }

  // ---- ilk cümleye kadar bekletme (settings.holdStart) ----

  _tickHold() {
    const h = this._hold;
    if (h.done || !settings.holdStart || !this.video) return;
    const v = this.video;
    if (this.player?.classList.contains('ad-showing')) return; // reklamda bekletme yok
    const needAudio = !this.ttsBroken && settings.voice !== 'system';
    const hold = shouldHold(this.sentences, v.currentTime, { loaded: this.sentences.length > 0, needAudio });
    if (!h.active) {
      if (!hold) { if (this.sentences.length && (this.mtReady || this.ttsReady)) h.done = true; return; }
      // kullanıcı durdurmuşsa beklemeye gerek yok; oynatınca yeniden bakılır (ayırma bekletiyorsa bekletmeyi paylaş)
      if (v.paused && !this.separation?.holding) return;
      h.active = true;
      h.ours = true;
      h.since = performance.now();
      if (!v.paused) v.pause();
      if (this.sentences.length && !this.enginesReady && !this.waitingApproval) this._engineStatus();
      return;
    }
    if (!hold || performance.now() - h.since > HOLD_MAX_MS) this._releaseHold();
  }

  // Bekletmeyi bitir; videoyu biz durdurduysak sürdür.
  _releaseHold() {
    const h = this._hold;
    if (!h.active) { h.done = true; return; }
    const ours = h.ours;
    this._endHold();
    // ayırma da bekletiyorsa videoyu o sürdürür
    if (ours && this.video?.paused && this.alive && !this.separation?.holding) {
      h.resuming = true;
      this.video.play().catch(() => {}).finally(() => { h.resuming = false; });
    }
  }

  _endHold() {
    const h = this._hold;
    if (h.active) this.timing.heldMs = Math.round(performance.now() - h.since);
    h.active = false;
    h.ours = false;
    h.done = true;
  }

  _playPcm(idx, remaining) {
    const s = this.sentences[idx];
    const { rate } = fitRate(s.audio.duration, remaining, s.audio.speed);
    this._curRate = rate;
    this.playingIdx = idx;
    this.ducker.duck(settings.originalVolume);
    this.audio.play(s.audio.url, { rate: rate * this.video.playbackRate, volume: this.dubVolume() }).then((err) => {
      if (err && err.name === 'NotAllowedError') {
        this.overlay.setStatus('Ses çalmak için sayfaya bir kez tıklayın.', { kind: 'warn', timeoutMs: 6000 });
      }
      if (this.playingIdx === idx) {
        this.playingIdx = -1;
        if (!this.audio.busy) this.ducker.release();
      }
    });
  }

  _playSystem(idx, remaining) {
    const s = this.sentences[idx];
    const base = settings.ttsSpeed;
    const text = spokenText(s);
    const est = estimateSpeechSec(text, base);
    const { rate } = fitRate(est, remaining, base);
    this.playingIdx = idx;
    this.ducker.duck(settings.originalVolume);
    this.sys.play(text, {
      rate: base * rate * this.video.playbackRate,
      volume: this.dubVolume(),
      voiceName: settings.systemVoiceName || undefined,
    }).then((res) => {
      if (res && !res.ok) this._reportError(new Error(res.error));
      if (this.playingIdx === idx) {
        this.playingIdx = -1;
        if (!this.sys.busy) this.ducker.release();
      }
    });
  }
}

// ---------------------------------------------------------------------------

function ensureButton() {
  let state = 'off', detail = '';
  if (settings?.enabled) {
    state = session?.btnState || 'preparing';
    detail = session?.btnDetail || '';
  }
  const player = session?.player?.isConnected ? session.player : findPlayer(document, pageKind());
  ensureToggleButton(state, () => {
    resumeAudio();
    setEnabled(!settings.enabled);
  }, detail, player);
  // oynatıcı paneli: oynatıcı değişince yeniden kurulur
  if (panel && (panel.player !== player || !panel.root.isConnected)) { panel.destroy(); panel = null; }
  if (!panel && player) panel = new Panel(player);
  panel?.update({ enabled: !!settings?.enabled, state, detail });
}

function route() {
  ensureButton();
  const vid = currentVideoId();
  if (session && session.videoId === vid && settings.enabled) return;
  if (session) { session.destroy(); session = null; }
  if (!vid || !settings.enabled) return;
  session = new Session(vid);
  session.start().catch((e) => console.error(LOG, e));
}

// Dublajın açık/kapalı durumu sekmeye özeldir: bir sekmede kapatmak ötekini etkilemez. Depodaki `enabled` yalnız
// yeni açılan sekmenin başlangıç değeridir (son seçim); başka sekmenin değişikliği buradaki durumu değiştirmez.
function setEnabled(on) {
  on = !!on;
  if (settings.enabled === on) return;
  const prev = settings;
  settings = { ...settings, enabled: on };
  onSettings(prev, ['enabled']);
  setSettings({ enabled: on });
}

function onSettings(prev, keys) {
  const has = (k) => keys.includes(k);
  // ayırma kapatılınca (ya da dublaj kapanınca) işçi ve modeli bellekten at
  if ((has('separation') && settings.separation === 'off') || (has('enabled') && !settings.enabled)) {
    session?.syncSeparation();
    disposeSeparation();
  }
  if ((has('sepQuality') || has('gpuPreference')) && session) {
    // ayırma kalitesi / kart tercihi değişti: işçi yeni ayarla yeniden yüklensin
    session.separation?.destroy();
    session.separation = null;
    disposeSeparation();
    session.syncSeparation();
  }
  if (has('enabled')) { route(); return; }
  ensureButton();
  if (!session) return;
  if (has('originalVolume')) session.ducker?.setLevel(settings.originalVolume);
  if (has('ttsVolume')) session.applyDubVolume();
  const trChanged = trKey(prev) !== trKey(settings);
  const auChanged = audioKey(prev) !== audioKey(settings);
  if (trChanged || auChanged) session.invalidate({ translations: trChanged, audio: true });
  if (has('engineMode') || has('mtBackend') || has('voice') ||
      (has('modelsApproved') && settings.modelsApproved && (session.waitingApproval || !session.enginesReady))) {
    if (session.sentences.length) session.initEngines();
  }
}

export async function start() {
  settings = await getSettings();
  onSettingsChanged((s, keys) => {
    const prev = settings;
    keys = keys.filter((k) => k !== 'enabled'); // sekmeye özel (setEnabled)
    settings = { ...s, enabled: prev.enabled };
    if (keys.length) onSettings(prev, keys);
  });
  window.addEventListener('locadub-set-enabled', (e) => setEnabled(e.detail));
  chrome.runtime.onMessage.addListener((msg, _from, respond) => {
    if (msg?.type === 'engine.progress') session?.onProgress(msg);
    // açılır pencere: bu sekmenin dublaj durumu (sekmeye özel)
    if (msg?.type === 'dub.state') respond({ enabled: !!settings.enabled });
    if (msg?.type === 'dub.set') { setEnabled(msg.enabled); respond({ enabled: !!settings.enabled }); }
    // [tanılama] ses ayırma özeti: ayarlar sayfasındaki rapor için (background diag.separation → üst çerçeve)
    if (msg?.type === 'diag.separation') {
      const sp = session?.separation;
      const { cachedRanges, message, ...st } = sp?.state || {};
      const memory = session?.memoryInfo(); // ayırma kapalıyken de cümle sesi sayıları görünür
      respond(sp ? { ...st, lastError: sp.error?.message || (st.status === 'error' ? message : session._sepLastError) || '', memory } : { off: true, memory });
    }
  });
  document.addEventListener('yt-navigate-finish', () => route());
  window.addEventListener('popstate', () => setTimeout(route, 300));
  // Oynatıcı yeniden çizilebilir: düğmeyi ve rotayı periyodik doğrula.
  setInterval(() => {
    ensureButton();
    if ((session?.videoId ?? null) !== (settings.enabled ? currentVideoId() : null)) route();
  }, 1500);
  route();
}
