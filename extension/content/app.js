// YouTube içerik uygulaması: altyazı → çeviri → seslendirme → senkron çalma.

import { getSettings, setSettings, onSettingsChanged, chooseVoice, toneFor, voiceGender, genderVoice } from '../common/settings.js';
import { styleSpeed } from '../engines/tts/styles.js';
import { DEFAULT_VOICE } from '../engines/tts/voices.js';
import { GenderTracker, estimateF0, predictGender, turnGender } from './gender.js';
import { decodePcmBase64ToInt16, int16ToWav, trimSilenceInt16 } from '../common/pcm.js';
import { loadTranscriptEntry, saveTranscript } from '../common/transcript-store.js';
import { applyGlossary, glossaryCompiler } from '../common/glossary.js';
import { pageVideo, findPlayer, findVideo } from '../common/page.js';
import { pickTrack, buildJson3Url, mergeTimedTextParams, parseJson3, mergeSentences } from './captions.js';
import {
  slotSec, chooseSynthSpeed, fitRate, activeIndex, nextDue, lastPlayedAfterSeek, windowIndices, estimateSpeechSec,
  prepStatus, shouldHold, trBatchSize, HOLD_MAX_MS,
} from './timing.js';
import { callMain, sendBg } from './bridge.js';
import { Overlay, ensureToggleButton } from './overlay.js';
import { DubAudio, SystemVoice, Ducker, resumeAudio, videoAnalyser } from './player.js';

const LOG = '[yt-tr-dub]';
const TICK_MS = 100;
const KEEP_BEHIND_SEC = 90;
const KEEP_AHEAD_EXTRA_SEC = 120;
const CACHE_VIDEOS = 5;
const PERSIST_MS = 15000;
const PITCH_MS = 50;

let settings = null;
let session = null;
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
      `|${s.genderVoices ? 'g' : ''}|${JSON.stringify(s.favFemale)}|${JSON.stringify(s.favMale)}`);
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
  } catch {
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
    this._hold = { done: false, active: false, since: 0, ours: false };
    // konuşanın cinsiyeti (content/gender.js): perde örnekleri, konuşmacı sırası → cinsiyet, en son duyulan
    this.pitch = new GenderTracker();
    this.genders = { turns: new Map(), recent: new Map(), last: null, fallback: null };
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
    this.audio = new DubAudio();
    this.sys = new SystemVoice(sendBg);
    this.ducker = new Ducker(this.video);
    this._bindVideo();

    this.overlay.setStatus('Türkçe dublaj 1/4: İngilizce altyazılar alınıyor…');
    this._setBtn('preparing', 'altyazılar alınıyor');
    // bekletme ve altyazı göstergesi altyazı gelmeden de çalışsın; motorlar altyazıyla aynı anda yüklenir
    this._tick = setInterval(() => this.tick(), TICK_MS);
    this._pitchTimer = setInterval(() => this._samplePitch(), PITCH_MS);
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
    this._on(window, 'pagehide', () => this._persist());
    // çeviri ve seslendirme ayrı döngülerde: ilk cümlenin sesi hazırlanırken sonraki cümleler çevrilir
    this.loopTr();
    this.loopAu();
    await engines;
  }

  _mark(k) {
    if (this.timing[k] == null) this.timing[k] = Math.round(performance.now() - this.timing.t0);
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
    const line = `aktif ${f('active')} (altyazı ${f('captions')}, çeviri motoru ${f('mt')}, ses motoru ${f('tts')}, ` +
      `ilk çeviri ${f('firstTr')}, ilk ses ${f('firstAudio')}${held})`;
    console.info(LOG, 'hazırlık:', line);
    sendBg({ type: 'diag.timing', line });
  }

  destroy() {
    if (!this.alive) return;
    this.alive = false;
    clearInterval(this._tick);
    clearInterval(this._pitchTimer);
    clearInterval(this._persistTimer);
    this._wakeUp();
    for (const [el, ev, fn] of this._listeners) el.removeEventListener(ev, fn);
    this._listeners = [];
    this.stopSpeech();
    this._releaseHold();
    this.ducker?.destroy();
    this.overlay?.destroy();
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
      // bekletme sırasında kullanıcı oynatırsa bekletme biter (videoyu ikinci kez durdurmayız)
      if (this._hold.active && !this._hold.resuming) this._endHold();
      resumeAudio();
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
      try { info = await callMain('get-player-response'); } catch { info = null; }
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
      try { cap = await callMain('get-timedtext-url', { videoId: this.videoId }); } catch { /* yoksay */ }
      if (!cap || !cap.includes('pot=')) {
        try {
          cap = await callMain('trigger-captions', {
            videoId: this.videoId, languageCode: track.languageCode, kind: track.kind,
          }, 20000);
        } catch { /* yoksay */ }
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
    this._mark('firstTr');
    this._wakeUp(); // seslendirme döngüsü yeni çeviriyi beklemesin
    return true;
  }

  // Çevirisi hazır, sesi olmayan en yakın cümleyi seslendirir (sistem sesi önceden sentez gerektirmez).
  async stepAu() {
    const t = this.video.currentTime;
    const needAu = windowIndices(this.sentences, t, settings.lookaheadSec, (s) => s.tr && !s.audio && !s.auPending && !s.auFailed);
    if (needAu.length) {
      await this.synth(needAu[0]);
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
    const tone = toneFor(settings, voice);
    // üslubun hız çarpanı temel hıza katılır (sığdırma hesabı bunu bilir); favori sesin üslubu kendi tonundan
    const speed = chooseSynthSpeed(text, slot, { base: settings.ttsSpeed * (voice === 'system' ? 1 : styleSpeed(tone.style)) });
    s.auPending = true;
    const res = await sendBg({ type: 'tts.synthesize', text, voice, speed, tone, tag: this.tag });
    s.auPending = false;
    if (!this.alive || gen !== this.audioGen) return;
    // sentez sürerken konuşanın cinsiyeti değiştiyse bu ses atılır, döngü doğru sesle yeniden üretir
    if (res.ok && this.voiceFor(s) !== voice) return;
    if (!res.ok) {
      if (res.code === 'ABORTED') return;
      s.auFail = (s.auFail || 0) + 1;
      if (s.auFail >= 2) s.auFailed = true;
      throw new Error('Seslendirme hatası: ' + res.error);
    }
    const r = res.result || {};
    console.debug(LOG, `ses ${i}: ${voice}`);
    if (r.system) { s.audio = { system: true, speed, voice }; return; }
    if (!r.pcmBase64) { s.audio = { empty: true, voice }; return; }
    const sr = r.sampleRate || 22050;
    const i16 = trimSilenceInt16(decodePcmBase64ToInt16(r.pcmBase64), sr);
    if (!i16.length) { s.audio = { empty: true, voice }; return; }
    const url = URL.createObjectURL(new Blob([int16ToWav(i16, sr)], { type: 'audio/wav' }));
    s.audio = { url, duration: i16.length / sr, speed, voice };
  }

  // ---- konuşanın cinsiyeti (settings.genderVoices) ----

  // Cümlenin sesi: cinsiyet modu açıksa tahmin edilen cinsiyetin sesi (favori öncelikli), değilse konuşmacı sırası.
  voiceFor(s) {
    const G = this.genders;
    const gender = settings.genderVoices && settings.voice !== 'system' ? predictGender(s, {
      ...G, fallback: voiceGender(settings, settings.voice || DEFAULT_VOICE),
    }) : null;
    // sırayla modunda aynı cinsiyetten iki konuşmacı: komşu sıra da bu cinsiyettense ikinci ses
    const turn = s.speaker || 0;
    const neighbour = G.turns.get(turn - 1) ?? G.turns.get(turn + 1);
    const alt = gender && neighbour === gender ? turn % 2 : 0;
    return chooseVoice(settings, { speaker: s.speaker, gender, alt });
  }

  // İlk ses hazır olunca diğer cinsiyetin sesini arka planda yükle: konuşan ilk kez değiştiğinde model yüklenirken
  // dublaj takılmasın (motor en çok iki modeli bellekte tutar; Supertonic sesleri tek pakettir).
  _prewarmVoices() {
    if (this._prewarmed || !settings.genderVoices || settings.voice === 'system') return;
    this._prewarmed = true;
    const primary = this.voiceFor({});
    for (const g of ['female', 'male']) {
      const v = genderVoice(settings, g);
      if (v && v !== primary) sendBg({ type: 'tts.synthesize', text: 'Merhaba.', voice: v, speed: 1, tone: toneFor(settings, v), tag: this.tag }).catch(() => {});
    }
  }

  _samplePitch() {
    if (!settings.genderVoices || settings.voice === 'system' || this.inAd) return;
    const v = this.video;
    if (!v || v.paused || v.seeking) return;
    const an = this._analyser || (this._analyser = videoAnalyser(v));
    if (!an) return;
    const buf = this._pitchBuf || (this._pitchBuf = new Float32Array(an.fftSize));
    an.getFloatTimeDomainData(buf);
    this.pitch.push(v.currentTime, estimateF0(buf, an.context.sampleRate));
  }

  // Biten cümlelerin perdesini ölç; konuşmacı sırasının cinsiyetini güncelle (gender.js turnGender).
  _measureGender(t) {
    if (!settings.genderVoices || settings.voice === 'system') return;
    const G = this.genders;
    let changed = false;
    for (const s of this.sentences) {
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
    }
    if (changed) this._regender(t);
  }

  // Tahmin değişti: henüz çalınmamış ve artık uymayan sesle hazırlanmış cümleleri bırak (yeniden üretilecekler).
  _regender(t) {
    let n = 0;
    for (const s of this.sentences) {
      if (s.start <= t || s.i === this.playingIdx || !s.audio?.voice) continue;
      if (s.audio.voice === this.voiceFor(s)) continue;
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
    this._tickHold();
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
    const ai = activeIndex(S, t);
    this.overlay.setText(settings.showSubtitles && ai >= 0 ? (S[ai].tr ? shownText(S[ai]) : '') : '');
    if (this.enginesReady) this._updatePrep(t);

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
      if (v.paused) return; // kullanıcı durdurmuşsa beklemeye gerek yok; oynatınca yeniden bakılır
      h.active = true;
      h.ours = true;
      h.since = performance.now();
      v.pause();
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
    if (ours && this.video?.paused && this.alive) {
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
    setSettings({ enabled: !settings.enabled });
  }, detail, player);
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

function onSettings(prev, keys) {
  const has = (k) => keys.includes(k);
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
    settings = s;
    onSettings(prev, keys);
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'engine.progress') session?.onProgress(msg);
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
