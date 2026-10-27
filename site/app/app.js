// LocaDub web uygulaması: video (YouTube ya da dosya) + İngilizce altyazı → çeviri → seslendirme → senkron çalma.
// Dublaj hattı eklentinin content/app.js oturumunu izler; motorlar ve saf modüller eklentiyle ortaktır (ext/).

import { DEFAULTS, normalizeSettings } from './ext/common/settings.js';
import { float32ToInt16, int16ToWav, trimSilenceInt16 } from './ext/common/pcm.js';
import {
  slotSec, chooseSynthSpeed, fitRate, activeIndex, nextDue, lastPlayedAfterSeek, windowIndices, estimateSpeechSec,
  prepStatus,
} from './ext/content/timing.js';
import { DubAudio, resumeAudio } from './ext/content/player.js';
import { listCached, deleteByPrefix, clearModels } from './ext/engines/common/model-cache.js';
import * as engines from './engines.js';
import { FileMedia, YouTubeMedia, WebSystemVoice, parseYouTubeId, systemVoices } from './media.js';
import { parseSubtitles } from './subs.js';
import { mergeSentences } from './ext/content/captions.js';
import { ASR_MODEL, BufferSource, Coverage, Transcriber, clearAsrCache, decodeFileAudio, isAsrCached } from './asr.js';

const LOG = '[locadub]';
const TICK_MS = 100;
const TR_BATCH_FIRST = 3;
const TR_BATCH = 8;
const KEEP_BEHIND_SEC = 90;
const KEEP_AHEAD_EXTRA_SEC = 120;
const STORE_KEY = 'locadub:settings';

const $ = (id) => document.getElementById(id);

// ---------- Ayarlar (localStorage) ----------

function loadSettings() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { raw = {}; }
  return normalizeSettings({ ...raw, enabled: true });
}

let settings = loadSettings();

function setSettings(patch) {
  const prev = settings;
  settings = normalizeSettings({ ...settings, ...patch });
  const { enabled, ...persist } = settings;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(persist)); } catch { /* gizli pencere vb. */ }
  const keys = Object.keys(patch).filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(settings[k]));
  if (keys.length) onSettings(prev, keys);
}

const trKey = (s) => `${s.engineMode}|${s.mtBackend || ''}`;
const audioKey = (s) => `${s.engineMode}|${s.voice || ''}|${s.ttsSpeed}|${s.systemVoiceName || ''}`;

// ---------- Ekran: durum, altyazı, ilerleme ----------

let statusTimer = null;
const ui = {
  // timeoutMs: uyarı/hata mesajı bu süre sonra kalkar (dublaj durumu yeniden görünür).
  status(text, kind = 'info', timeoutMs = 0) {
    const el = $('status');
    clearTimeout(statusTimer);
    el.textContent = text || '';
    el.dataset.kind = text ? kind : '';
    if (timeoutMs) statusTimer = setTimeout(() => { if (el.textContent === text) ui.status(''); }, timeoutMs);
  },
  sub(text) {
    const el = $('sub');
    if (el.textContent !== text) el.textContent = text;
    el.hidden = !text;
  },
  progress(p) {
    const bar = $('progress');
    if (!p || p.done || p.error || !p.total || p.cached) { bar.hidden = true; return; }
    bar.hidden = false;
    const pct = Math.floor((p.loaded / p.total) * 100);
    bar.firstElementChild.style.width = pct + '%';
    bar.title = `${p.engine === 'mt' ? 'Çeviri' : 'Ses'} modeli indiriliyor: %${pct}`;
    ui.status(`${p.engine === 'mt' ? 'Çeviri' : 'Ses'} modeli indiriliyor… %${pct} (${fmtMB(p.loaded / 1e6)} / ${fmtMB(p.total / 1e6)})`);
  },
};

const fmtMB = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`);

// ---------- Dublaj oturumu ----------

let job = null;     // { media, sentences, trKey } — yüklü video ve altyazı
let session = null; // aktif dublaj

class Session {
  constructor(media, sentences) {
    this.media = media;
    this.tag = 'dub:' + Date.now().toString(36);
    this.alive = true;
    this.sentences = sentences;
    this.lastPlayed = lastPlayedAfterSeek(sentences, media.currentTime);
    this.playingIdx = -1;
    this.enginesReady = false;
    this.ttsBroken = false;
    this.firstBatchDone = false;
    this.audioGen = 0;
    this.trGen = 0;
    this._wake = null;
    this._off = [];
    this._lastErrAt = 0;
    this.audio = new DubAudio();
    this.sys = new WebSystemVoice();
    this.ducker = media.ducker;
  }

  async start() {
    const m = this.media;
    const on = (ev, fn) => this._off.push(m.on(ev, fn));
    on('seeking', () => { this.stopSpeech(); this._wakeUp(); });
    on('seeked', () => { this.lastPlayed = lastPlayedAfterSeek(this.sentences, m.currentTime); this._wakeUp(); });
    on('pause', () => { this.audio.pause(); this.sys.pause(); this.ducker.release(0); });
    on('play', () => {
      resumeAudio();
      if (this.audio.busy || this.sys.busy) {
        this.ducker.duck(settings.originalVolume);
        this.audio.resume();
        this.sys.resume();
      }
    });
    on('volumechange', () => this.applyDubVolume());
    on('ratechange', () => { if (this.audio.busy) this.audio.setRate((this._curRate || 1) * m.playbackRate); });
    this._tick = setInterval(() => this.tick(), TICK_MS);
    await this.initEngines();
    this.loop();
  }

  destroy() {
    if (!this.alive) return;
    this.alive = false;
    clearInterval(this._tick);
    this._wakeUp();
    this._off.forEach((f) => f());
    this.stopSpeech();
    engines.cancel(this.tag);
    this._dropAudio();
    ui.sub('');
  }

  dubVolume() { return settings.ttsVolume * this.ducker.userVolume(); }
  applyDubVolume() { this.audio.setVolume(this.dubVolume()); }

  // Konuşma tanımadan yeni cümleler eklendi (first: ilk eklenenin indeksi).
  onSentencesAdded(first) {
    if (first <= this.lastPlayed) this.lastPlayed = lastPlayedAfterSeek(this.sentences, this.media.currentTime);
    this._wakeUp();
  }

  initEngines() {
    if (!this._initing) this._initing = this._initEngines().finally(() => { this._initing = null; });
    return this._initing;
  }

  async _initEngines() {
    this.enginesReady = false;
    this.engineFailed = false;
    ui.status('Çeviri ve ses motorları yükleniyor…');
    const useSystem = settings.voice === 'system';
    const onProgress = (p) => { if (this.alive) ui.progress(p); };
    const [mt, tts] = await Promise.allSettled([
      engines.ensure('mt', settings, onProgress),
      useSystem ? Promise.resolve() : engines.ensure('tts', settings, onProgress),
    ]);
    if (!this.alive) return false;
    ui.progress(null);
    if (mt.status === 'rejected') {
      this.engineFailed = true;
      ui.status('Çeviri motoru başlatılamadı: ' + (mt.reason?.message || mt.reason), 'error');
      renderModels();
      return false;
    }
    this.ttsBroken = tts.status === 'rejected' || (useSystem && !this.sys.available);
    if (tts.status === 'rejected') {
      ui.status('Ses motoru başlatılamadı, yalnızca altyazı gösterilecek: ' + (tts.reason?.message || tts.reason), 'warn', 12000);
    } else if (this.ttsBroken) {
      ui.status('Bu tarayıcıda sistem sesi yok, yalnızca altyazı gösterilecek.', 'warn', 12000);
    } else {
      ui.status('Dublaj hazır.', 'ok');
    }
    this.enginesReady = true;
    renderModels();
    this._wakeUp();
    return true;
  }

  // ---- ileri-bakış hattı ----

  _wakeUp() { const w = this._wake; this._wake = null; w?.(); }
  _sleepWake(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this._wake = null; resolve(); }, ms);
      this._wake = () => { clearTimeout(t); resolve(); };
    });
  }

  async loop() {
    while (this.alive) {
      let did = false;
      if (this.enginesReady) {
        try { did = await this.step(); } catch (e) {
          if (e?.code !== 'ABORTED') this._reportError(e);
          await this._sleepWake(1500);
        }
      }
      if (!this.alive) break;
      if (!did) await this._sleepWake(this.enginesReady ? 400 : 1000);
    }
  }

  async step() {
    const S = this.sentences;
    const t = this.media.currentTime;
    const ahead = settings.lookaheadSec;

    const needTr = windowIndices(S, t, ahead, (s) => s.tr == null && !s.trPending);
    if (needTr.length) {
      const batch = needTr.slice(0, this.firstBatchDone ? TR_BATCH : TR_BATCH_FIRST);
      const gen = this.trGen;
      for (const i of batch) S[i].trPending = true;
      let res;
      try {
        res = await engines.translate(batch.map((i) => S[i].text), settings, this.tag);
      } catch (e) {
        for (const i of batch) S[i].trPending = false;
        if (e?.code === 'ABORTED' || !this.alive || gen !== this.trGen) return true;
        for (const i of batch) {
          S[i].trFail = (S[i].trFail || 0) + 1;
          if (S[i].trFail >= 3) S[i].tr = '';
        }
        throw new Error('Çeviri hatası: ' + (e?.message || e));
      }
      for (const i of batch) S[i].trPending = false;
      if (!this.alive || gen !== this.trGen) return true;
      batch.forEach((i, k) => { S[i].tr = res[k] ?? ''; });
      this.firstBatchDone = true;
      return true;
    }

    if (!this.ttsBroken && settings.voice !== 'system') {
      const needAu = windowIndices(S, t, ahead, (s) => s.tr && !s.audio && !s.auPending && !s.auFailed);
      if (needAu.length) { await this.synth(needAu[0]); return true; }
    }

    this._evict(t);
    return false;
  }

  async synth(i) {
    const S = this.sentences;
    const s = S[i];
    const gen = this.audioGen;
    const speed = chooseSynthSpeed(s.tr, slotSec(S, i), { base: settings.ttsSpeed });
    s.auPending = true;
    let r;
    try {
      r = await engines.synthesize(s.tr, speed, settings, this.tag);
    } catch (e) {
      s.auPending = false;
      if (e?.code === 'ABORTED' || !this.alive || gen !== this.audioGen) return;
      s.auFail = (s.auFail || 0) + 1;
      if (s.auFail >= 2) s.auFailed = true;
      throw new Error('Seslendirme hatası: ' + (e?.message || e));
    }
    s.auPending = false;
    if (!this.alive || gen !== this.audioGen) return;
    const i16 = trimSilenceInt16(float32ToInt16(r.pcm), r.sampleRate);
    if (!i16.length) { s.audio = { empty: true }; return; }
    const url = URL.createObjectURL(new Blob([int16ToWav(i16, r.sampleRate)], { type: 'audio/wav' }));
    s.audio = { url, duration: i16.length / r.sampleRate, speed };
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

  invalidate({ translations = false } = {}) {
    engines.cancel(this.tag);
    this.tag = 'dub:' + Date.now().toString(36);
    this.stopSpeech();
    this.audioGen++;
    this._dropAudio();
    if (translations) {
      this.trGen++;
      for (const s of this.sentences) { s.tr = null; s.trPending = false; s.trFail = 0; }
      this.firstBatchDone = false;
    }
    this._wakeUp();
  }

  _reportError(e) {
    console.warn(LOG, e);
    const now = Date.now();
    if (now - this._lastErrAt < 8000) return;
    this._lastErrAt = now;
    ui.status(String(e?.message || e), 'error', 8000);
  }

  // ---- oynatma senkronu ----

  stopSpeech() {
    this.audio.stop();
    this.sys.stop();
    this.playingIdx = -1;
    this.ducker.release(0);
  }

  tick() {
    if (!this.alive) return;
    const m = this.media;
    const S = this.sentences;
    const t = m.currentTime;
    const ai = activeIndex(S, t);
    ui.sub(settings.showSubtitles && ai >= 0 ? (S[ai].tr || '') : '');
    if (this.enginesReady) this._updatePrep(t);

    if (m.paused || m.seeking || !this.enginesReady) return;
    if (this.audio.busy || this.sys.busy) return;

    const due = nextDue(S, t, this.lastPlayed);
    if (due.skipped.length) this.lastPlayed = Math.max(this.lastPlayed, ...due.skipped);
    if (due.index < 0) return;
    const idx = due.index;
    const s = S[idx];
    if (s.tr == null) return;
    if (!s.tr) { this.lastPlayed = idx; return; }

    const remaining = s.start + slotSec(S, idx) - t;
    if (settings.voice === 'system') {
      this.lastPlayed = idx;
      if (!this.ttsBroken) this._playSystem(idx, remaining);
      return;
    }
    if (!s.audio) {
      if (this.ttsBroken || s.auFailed) this.lastPlayed = idx;
      return;
    }
    this.lastPlayed = idx;
    if (s.audio.empty) return;
    this._playPcm(idx, remaining);
  }

  _updatePrep(t) {
    const needAudio = !this.ttsBroken && settings.voice !== 'system';
    const p = prepStatus(this.sentences, t, settings.lookaheadSec, { needAudio });
    const el = $('status');
    const ours = el.dataset.kind === 'prep' || el.dataset.kind === 'ok';
    if (!ours && el.dataset.kind) return; // hata/uyarı mesajını ezme
    if (!p) {
      if (el.dataset.kind === 'prep') ui.status('Dublaj aktif.', 'ok');
      return;
    }
    ui.status(p.phase === 'translate'
      ? `Türkçeye çevriliyor… (${p.done}/${p.total} cümle hazır)`
      : `Türkçe ses hazırlanıyor… (${p.done}/${p.total} cümle hazır)`, 'prep');
  }

  _playPcm(idx, remaining) {
    const s = this.sentences[idx];
    const { rate } = fitRate(s.audio.duration, remaining, s.audio.speed);
    this._curRate = rate;
    this.playingIdx = idx;
    this.ducker.duck(settings.originalVolume);
    this.audio.play(s.audio.url, { rate: rate * this.media.playbackRate, volume: this.dubVolume() }).then((err) => {
      if (err && err.name === 'NotAllowedError') ui.status('Ses çalmak için sayfaya bir kez tıklayın.', 'warn', 6000);
      if (this.playingIdx === idx) {
        this.playingIdx = -1;
        if (!this.audio.busy) this.ducker.release();
      }
    });
  }

  _playSystem(idx, remaining) {
    const s = this.sentences[idx];
    const base = settings.ttsSpeed;
    const { rate } = fitRate(estimateSpeechSec(s.tr, base), remaining, base);
    this.playingIdx = idx;
    this.ducker.duck(settings.originalVolume);
    this.sys.play(s.tr, {
      rate: base * rate * this.media.playbackRate,
      volume: Math.min(1, this.dubVolume()),
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

function startSession() {
  stopSession();
  if (!job || !settings.enabled) return;
  if (job.trKey !== trKey(settings)) {
    for (const s of job.sentences) s.tr = null;
    job.trKey = trKey(settings);
  }
  session = new Session(job.media, job.sentences);
  session.start().catch((e) => { console.error(LOG, e); ui.status(String(e?.message || e), 'error'); });
  renderDubToggle();
}

function stopSession() {
  if (session) { session.destroy(); session = null; }
  renderDubToggle();
}

function onSettings(prev, keys) {
  const has = (k) => keys.includes(k);
  renderSettings();
  if (has('enabled')) { settings.enabled ? startSession() : stopSession(); return; }
  if (has('engineMode') || has('mtBackend') || has('voice')) renderModels();
  if (!session) return;
  if (has('originalVolume')) session.ducker.setLevel(settings.originalVolume);
  if (has('ttsVolume')) session.applyDubVolume();
  const trChanged = trKey(prev) !== trKey(settings);
  const auChanged = audioKey(prev) !== audioKey(settings);
  if (trChanged) job.trKey = trKey(settings);
  if (trChanged || auChanged) session.invalidate({ translations: trChanged });
  if (has('engineMode') || has('mtBackend') || has('voice')) session.initEngines();
}

// ---------- Kaynak seçimi ve başlatma ----------

let sourceTab = 'youtube';
let parsedSubs = null; // isteğe bağlı altyazı dosyası: { sentences, format, name }

function setTab(group, value) {
  for (const b of document.querySelectorAll(`[data-tabs="${group}"] [role="tab"]`)) {
    const on = b.dataset.value === value;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    $(b.getAttribute('aria-controls')).hidden = !on;
  }
  if (group === 'source') sourceTab = value;
}

for (const list of document.querySelectorAll('[data-tabs]')) {
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[role="tab"]');
    if (b) setTab(list.dataset.tabs, b.dataset.value);
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    setTab(list.dataset.tabs, next.dataset.value);
  });
}

const fmtClock = (sec) => {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(r).padStart(2, '0');
};

const FORMAT_NAMES = { transcript: 'transkript', timed: 'SRT/VTT', json3: 'YouTube json3' };

async function updateSubsInfo() {
  const info = $('subsInfo');
  parsedSubs = null;
  const f = $('subsFile').files[0];
  $('subsClear').hidden = !f;
  if (!f) { info.textContent = ''; info.dataset.kind = ''; return; }
  try {
    const r = parseSubtitles(await f.text());
    parsedSubs = { ...r, name: f.name };
    const last = r.sentences[r.sentences.length - 1];
    info.textContent = `✓ ${r.sentences.length} cümle · ${FORMAT_NAMES[r.format]} · ${fmtClock(r.sentences[0].start)}–${fmtClock(last.end)}. Konuşma tanıma kullanılmayacak.`;
    info.dataset.kind = 'ok';
  } catch (e) {
    info.textContent = e.message;
    info.dataset.kind = 'error';
  }
}
$('subsFile').addEventListener('change', updateSubsInfo);
$('subsClear').addEventListener('click', () => { $('subsFile').value = ''; updateSubsInfo(); });

function confirmBox(text, yesLabel) {
  const d = $('confirm');
  $('confirmText').textContent = text;
  $('confirmYes').textContent = yesLabel;
  d.showModal();
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true });
  });
}

// Seçili modeller indirilmemişse boyutu gösterip onay ister; Chrome çevirmeni dil paketi için tıklama gerekir.
async function approveModels({ asr }) {
  const lists = await engines.listAll(settings);
  const backend = effectiveBackend(lists);
  const voice = effectiveVoice(lists);
  let mb = 0;
  const names = [];
  if (asr && !(await isAsrCached())) { mb += ASR_MODEL.sizeMB; names.push('konuşma tanıma (Whisper)'); }
  if (settings.engineMode !== 'mock') {
    if (backend?.id === 'opus-mt' && !backend.downloaded) { mb += backend.sizeMB; names.push('çeviri (OPUS-MT)'); }
    if (voice && !voice.system && !voice.cached) { mb += voice.sizeMB; names.push(`ses (${voice.label})`); }
  }
  if (mb > 0) {
    const ok = await confirmBox(
      `İlk kullanım için ${names.join(', ')} modelleri indirilecek (yaklaşık ${fmtMB(mb)}). Modeller bu tarayıcıda saklanır; ` +
      'sonraki kullanımlarda yeniden indirilmez. Metin ve ses hiçbir sunucuya gönderilmez.',
      `İndir ve başlat (${fmtMB(mb)})`);
    if (!ok) return false;
  }
  if (settings.engineMode !== 'mock' && backend?.id === 'chrome-translator' && backend.needsUserActivation) {
    ui.status('Chrome EN→TR dil paketi hazırlanıyor…');
    try {
      const mt = await engines.loadModule('mt', 'real');
      await mt.prepareChromeTranslator({ onProgress: (p) => ui.progress({ engine: 'mt', ...p }) });
    } catch (e) {
      ui.status('Chrome dil paketi hazırlanamadı: ' + (e?.message || e) + ' Ayarlardan OPUS-MT çeviriyi seçebilirsiniz.', 'error');
      return false;
    }
  }
  return true;
}

// ---------- Konuşma tanıma ----------

const listenUi = (text, kind = 'info') => {
  const el = $('listenStatus');
  el.textContent = text || '';
  el.dataset.kind = text ? kind : '';
};

// YouTube: dinleyici penceresi (listen.html) videoyu önden oynatıp yazıya döker; burada yalnızca sonuçlar toplanır.
class PopupSource {
  constructor(win, media) {
    this.win = win;
    this.media = media;
    this.coverage = new Coverage();
    this.onCues = null;
    this.closed = false;
    this._onMsg = (ev) => {
      const d = ev.data;
      if (ev.origin !== location.origin || ev.source !== this.win || d?.source !== 'locadub-listener') return;
      if (d.type === 'cues') {
        this.coverage.list = Array.isArray(d.coverage) ? d.coverage : [];
        this.onCues?.(d.cues || []);
      } else if (d.type === 'status') listenUi(d.text, d.kind);
      else if (d.type === 'progress' && d.total) listenUi(`Konuşma tanıma modeli indiriliyor… %${Math.floor((d.loaded / d.total) * 100)}`);
    };
    window.addEventListener('message', this._onMsg);
    this._timer = setInterval(() => this._sync(), 400);
  }
  _sync() {
    if (this.win.closed) {
      if (!this.closed) {
        this.closed = true;
        listenUi('Dinleyici penceresi kapandı; yeni bölümler yazıya dökülemiyor.', 'error');
        $('reopen').hidden = false;
      }
      return;
    }
    this.win.postMessage({ source: 'locadub-main', type: 'main', t: this.media.currentTime, playing: !this.media.paused }, location.origin);
  }
  until(t) { return this.coverage.until(t); }
  follow() {}
  destroy() {
    clearInterval(this._timer);
    window.removeEventListener('message', this._onMsg);
    try { this.win.close(); } catch { /* yoksay */ }
  }
}

function openListener(videoId) {
  return window.open(`listen.html?v=${encodeURIComponent(videoId)}`, 'locadub-listener', 'popup,width=600,height=680');
}

$('reopen').addEventListener('click', () => {
  if (!job?.videoId) return;
  const w = openListener(job.videoId);
  if (!w) { listenUi('Açılır pencere engellendi. Adres çubuğundan bu siteye açılır pencere izni verin.', 'error'); return; }
  job.source?.destroy();
  job.source = new PopupSource(w, job.media);
  job.source.onCues = addCues;
  $('reopen').hidden = true;
  listenUi('Dinleyici penceresinde "Dinlemeyi başlat"a basın.');
});

// Yazıya dökülen yeni parçaları cümle listesine sıralı ekler (çakışanlar atlanır).
function addCues(cues) {
  if (!job || !cues.length) return;
  const S = job.sentences;
  const fresh = mergeSentences(cues).filter((n) => {
    const mid = (n.start + n.end) / 2;
    return !S.some((s) => mid >= s.start && mid <= s.end);
  });
  if (!fresh.length) return;
  let first = Infinity;
  for (const n of fresh) {
    let pos = S.findIndex((s) => s.start > n.start);
    if (pos < 0) pos = S.length;
    S.splice(pos, 0, { ...n, tr: null, audio: null });
    first = Math.min(first, pos);
  }
  S.forEach((s, i) => { s.i = i; });
  session?.onSentencesAdded(first);
}

// Dublaj kaçmasın diye video gerekirse bekletilir (tampon gibi): konuşma henüz yazıya dökülmediyse,
// motorlar yükleniyorsa ya da sıradaki cümlenin çevirisi/sesi hazır değilse. Hazır olunca kendiliğinden sürer.
const HOLD_TEXT = {
  listen: 'Ses yazıya dökülüyor; video birkaç saniye içinde kendiliğinden devam edecek…',
  engines: 'Çeviri ve ses motorları hazırlanıyor; video hazır olunca kendiliğinden başlayacak…',
  translate: 'Türkçe dublaj hazırlanıyor; video birazdan kendiliğinden devam edecek…',
  synth: 'Türkçe dublaj hazırlanıyor; video birazdan kendiliğinden devam edecek…',
};

function holdReason(t) {
  const m = job.media;
  const dur = m.duration || Infinity;
  if (job.source) {
    let u = t >= dur - 1.5 ? Infinity : job.source.until(t);
    if (u >= dur - 1.5) u = Infinity; // videonun sonuna kadar yazıya döküldü
    if (u < t + (job.gated === 'listen' ? 20 : 1.5)) return 'listen';
  }
  if (!session || session.engineFailed) return null;
  if (!session.enginesReady) return 'engines';
  const needAudio = !session.ttsBroken && settings.voice !== 'system';
  const p = prepStatus(session.sentences, t, 5, { needAudio, soonSec: job.gated ? 3 : 0.4 });
  return p ? p.phase : null;
}

function gateTick() {
  if (!job) return;
  const m = job.media;
  const t = m.currentTime;
  job.source?.follow(t);
  const reason = settings.enabled ? holdReason(t) : null;
  if (reason && !job.gated && !m.paused) {
    job.gated = reason;
    m.pause();
  } else if (job.gated && !reason) {
    job.gated = false;
    m.play();
    listenUi('');
    return;
  }
  if (job.gated) {
    job.gated = reason;
    listenUi(HOLD_TEXT[reason], 'warn');
  }
}

function destroyJob() {
  stopSession();
  if (!job) return;
  clearInterval(job.gateTimer);
  job.source?.destroy();
  job.transcriber?.dispose();
  job.media.destroy();
  job = null;
  $('reopen').hidden = true;
  listenUi('');
}

$('start').addEventListener('click', async () => {
  resumeAudio();
  const btn = $('start');
  if (btn.disabled) return;
  let make, videoId = null, file = null;
  if (sourceTab === 'youtube') {
    videoId = parseYouTubeId($('ytUrl').value);
    if (!videoId) { ui.status('Geçerli bir YouTube bağlantısı girin (ör. https://www.youtube.com/watch?v=…).', 'error'); $('ytUrl').focus(); return; }
    make = (host) => new YouTubeMedia(host, videoId);
  } else {
    file = $('videoFile').files[0];
    if (!file) { ui.status('Bilgisayarınızdan bir video dosyası seçin.', 'error'); $('videoFile').focus(); return; }
    make = (host) => new FileMedia(host, file);
  }
  const subs = parsedSubs;
  const asr = !subs;

  // Açılır pencere yalnızca tıklamanın hemen ardından açılabilir.
  let listener = null;
  if (asr && videoId) {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      ui.status('Bu tarayıcı YouTube videolarını yazıya dökemiyor (sekme sesi yakalama yok). Masaüstünde Chrome ya da Edge kullanın.', 'error');
      return;
    }
    listener = openListener(videoId);
    if (!listener) { ui.status('Açılır pencere engellendi. Adres çubuğundan bu siteye açılır pencere izni verip yeniden deneyin.', 'error'); return; }
    window.focus();
  }

  btn.disabled = true;
  try {
    if (!(await approveModels({ asr }))) {
      listener?.close();
      ui.status('Model indirmesi onaylanmadı.', 'warn');
      return;
    }
    destroyJob();
    $('empty').hidden = true;
    ui.status('Video yükleniyor…');
    const media = make($('mediaHost'));
    try {
      await media.ready();
    } catch (e) {
      media.destroy();
      listener?.close();
      $('empty').hidden = false;
      throw e;
    }
    media.on('error', (e) => ui.status(e.message, 'error'));
    job = {
      media,
      videoId,
      sentences: subs ? subs.sentences.map((s, i) => ({ ...s, i, tr: null, audio: null })) : [],
      trKey: trKey(settings),
      source: null,
      gated: false,
    };
    if (asr && listener) {
      job.source = new PopupSource(listener, media);
      job.source.onCues = addCues;
      listenUi('Açılan dinleyici penceresinde "Dinlemeyi başlat"a basın ve bu sekmeyi paylaşın.', 'warn');
    } else if (asr && file) {
      listenUi('Videonun sesi çözülüyor…');
      const audio = await decodeFileAudio(file);
      if (job?.media !== media) return;
      job.transcriber = new Transcriber();
      const src = new BufferSource(audio, job.transcriber);
      src.onCues = addCues;
      src.onError = (e) => listenUi('Konuşma tanıma hatası: ' + (e?.message || e), 'error');
      job.source = src;
      listenUi('Konuşma tanıma modeli yükleniyor…');
      job.transcriber.load((p) => {
        if (p.total && !p.done) listenUi(`Konuşma tanıma modeli indiriliyor… %${Math.floor((p.loaded / p.total) * 100)}`);
        else if (p.done && !job?.gated) listenUi('');
      }).catch((e) => listenUi('Konuşma tanıma modeli yüklenemedi: ' + (e?.message || e), 'error'));
      src.run();
    }
    job.gateTimer = setInterval(gateTick, 250);
    if (!settings.enabled) setSettings({ enabled: true });
    else startSession();
    $('stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    ui.status(String(e?.message || e), 'error');
  } finally {
    btn.disabled = false;
  }
});

// ---------- Oynatıcı düğmeleri ----------

function renderDubToggle() {
  const b = $('dubToggle');
  b.hidden = !job;
  b.setAttribute('aria-pressed', String(!!session));
  b.textContent = session ? 'Dublaj açık' : 'Dublaj kapalı';
}
$('dubToggle').addEventListener('click', () => { resumeAudio(); setSettings({ enabled: !settings.enabled }); });

$('fullscreen').addEventListener('click', () => {
  const st = $('stage');
  if (document.fullscreenElement) document.exitFullscreen();
  else st.requestFullscreen?.().catch(() => {});
});
document.addEventListener('fullscreenchange', () => {
  $('fullscreen').textContent = document.fullscreenElement ? 'Tam ekrandan çık' : 'Tam ekran';
});
document.addEventListener('click', () => resumeAudio(), true);
document.addEventListener('keydown', () => resumeAudio(), true);

// ---------- Ayarlar paneli ----------

const RANGES = {
  ttsSpeed: (v) => `${v.toFixed(2)}×`,
  ttsVolume: (v) => `%${Math.round(v * 100)}`,
  originalVolume: (v) => `%${Math.round(v * 100)}`,
  lookaheadSec: (v) => `${v} sn`,
};
for (const [id, fmt] of Object.entries(RANGES)) {
  const input = $(id), out = $(id + 'Out');
  input.addEventListener('input', () => { out.textContent = fmt(Number(input.value)); });
  input.addEventListener('change', () => setSettings({ [id]: Number(input.value) }));
}
$('showSubtitles').addEventListener('change', (e) => setSettings({ showSubtitles: e.target.checked }));
$('mock').addEventListener('change', (e) => setSettings({ engineMode: e.target.checked ? 'mock' : 'real', mtBackend: null, voice: null }));
$('mtBackend').addEventListener('change', (e) => setSettings({ mtBackend: e.target.value || null }));
$('voice').addEventListener('change', (e) => setSettings({ voice: e.target.value || null }));
$('systemVoiceName').addEventListener('change', (e) => setSettings({ systemVoiceName: e.target.value || null }));
$('resetSettings').addEventListener('click', () => {
  const { enabled, modelsApproved, ...rest } = DEFAULTS;
  setSettings(rest);
});

function renderSettings() {
  $('showSubtitles').checked = settings.showSubtitles;
  $('mock').checked = settings.engineMode === 'mock';
  for (const [id, fmt] of Object.entries(RANGES)) {
    if (document.activeElement !== $(id)) $(id).value = settings[id];
    $(id + 'Out').textContent = fmt(Number(settings[id]));
  }
  $('systemVoiceRow').hidden = settings.voice !== 'system';
}

function fillSelect(sel, items, value, autoLabel) {
  const opts = [new Option(autoLabel, '')];
  for (const it of items) {
    const o = new Option(it.label + (it.available === false ? ' — bu tarayıcıda yok' : ''), it.id);
    o.disabled = it.available === false;
    opts.push(o);
  }
  sel.replaceChildren(...opts);
  sel.value = value || '';
}

function renderSystemVoices() {
  const voices = systemVoices();
  const sel = $('systemVoiceName');
  sel.replaceChildren(new Option(voices.length ? 'Varsayılan Türkçe ses' : 'Türkçe sistem sesi bulunamadı', ''),
    ...voices.map((v) => new Option(`${v.name}${v.localService ? '' : ' (çevrimiçi)'}`, v.name)));
  sel.value = settings.systemVoiceName || '';
}
if ('speechSynthesis' in window) speechSynthesis.addEventListener?.('voiceschanged', renderSystemVoices);

// ---------- Modeller ----------

let lists = { backends: [], voices: [], errors: {} };
const downloading = new Map(); // `${engine}:${id}` → { loaded, total }

function effectiveBackend(l = lists) {
  if (settings.mtBackend) return l.backends.find((b) => b.id === settings.mtBackend) || null;
  return l.backends.find((b) => b.available) || null;
}
function effectiveVoice(l = lists) {
  if (settings.voice) return l.voices.find((v) => v.id === settings.voice) || null;
  return l.voices.find((v) => v.default && !v.system) || l.voices.find((v) => v.available && !v.system) || null;
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e[k] = v;
  }
  e.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return e;
}

async function downloadModel(engine, id) {
  const key = `${engine}:${id}`;
  downloading.set(key, { loaded: 0, total: 0 });
  renderModelList();
  const patch = engine === 'mt' ? { mtBackend: id } : { voice: id };
  try {
    await engines.ensure(engine, { ...settings, ...patch }, (p) => {
      if (p.total) { downloading.set(key, { loaded: p.loaded, total: p.total }); renderModelList(); }
    });
  } catch (e) {
    ui.status('Model indirilemedi: ' + (e?.message || e), 'error');
  } finally {
    downloading.delete(key);
    await renderModels();
  }
}

async function deleteModel(prefix, label) {
  if (!(await confirmBox(`${label} bu tarayıcıdan silinecek. Yeniden kullanmak için tekrar indirmeniz gerekir.`, 'Sil'))) return;
  stopSession();
  await engines.resetAll();
  await deleteByPrefix(prefix);
  await renderModels();
  if (job && settings.enabled) startSession();
}

function modelRow({ engine, item, ready, inUse, sizeMB, prefix, note, onDownload, onDelete }) {
  const dl = downloading.get(`${engine}:${item.id}`);
  const chip = dl
    ? el('span', { class: 'chip busy', textContent: dl.total ? `İndiriliyor %${Math.floor((dl.loaded / dl.total) * 100)}` : 'Hazırlanıyor…' })
    : ready ? el('span', { class: 'chip ok', textContent: '✓ Hazır' })
      : el('span', { class: 'chip', textContent: item.available === false ? 'Desteklenmiyor' : 'İndirilmedi' });
  const actions = [];
  if (!ready && !dl && item.available !== false && sizeMB) {
    actions.push(el('button', { class: 'btn small ghost', textContent: `İndir (${fmtMB(sizeMB)})`, onclick: onDownload || (() => downloadModel(engine, item.id)) }));
  }
  if (ready && (prefix || onDelete)) {
    actions.push(el('button', { class: 'btn small ghost danger', textContent: 'Sil', onclick: onDelete || (() => deleteModel(prefix, item.label)) }));
  }
  return el('li', { class: 'model' + (inUse ? ' in-use' : '') },
    el('div', { class: 'model-name' }, item.label, inUse ? el('span', { class: 'chip use', textContent: 'Seçili' }) : null),
    el('div', { class: 'model-meta' }, chip, note ? el('span', { textContent: note }) : null, ...actions));
}

let asrCached = false;

async function downloadAsr() {
  downloading.set('asr:whisper', { loaded: 0, total: 0 });
  renderModelList();
  const t = new Transcriber();
  try {
    await t.load((p) => { if (p.total) { downloading.set('asr:whisper', { loaded: p.loaded, total: p.total }); renderModelList(); } });
  } catch (e) {
    ui.status('Model indirilemedi: ' + (e?.message || e), 'error');
  } finally {
    t.dispose();
    downloading.delete('asr:whisper');
    await renderModels();
  }
}

async function deleteAsr() {
  if (!(await confirmBox(`${ASR_MODEL.label} bu tarayıcıdan silinecek.`, 'Sil'))) return;
  await clearAsrCache();
  await renderModels();
}

function renderModelList() {
  const rows = [modelRow({
    engine: 'asr', item: { id: 'whisper', label: ASR_MODEL.label }, ready: asrCached, inUse: !parsedSubs,
    sizeMB: ASR_MODEL.sizeMB, note: 'İngilizce konuşmayı yazıya döker', onDownload: downloadAsr, onDelete: deleteAsr,
  })];
  const useB = effectiveBackend(), useV = effectiveVoice();
  for (const b of lists.backends) {
    if (b.id === 'chrome-translator') {
      rows.push(modelRow({
        engine: 'mt', item: b, ready: b.status === 'available', inUse: useB?.id === b.id,
        note: !b.available ? 'Chrome 138+ gerekir' : b.status === 'available' ? 'dil paketini Chrome yönetir' : 'ilk başlatmada Chrome indirir',
      }));
    } else {
      rows.push(modelRow({ engine: 'mt', item: b, ready: !!b.downloaded, inUse: useB?.id === b.id, sizeMB: b.sizeMB, prefix: b.cachePrefix }));
    }
  }
  for (const v of lists.voices) {
    if (v.system) {
      rows.push(modelRow({ engine: 'tts', item: { ...v, label: 'Tarayıcının sistem sesi', available: systemVoices().length > 0 }, ready: systemVoices().length > 0, inUse: useV?.id === v.id || settings.voice === 'system', note: systemVoices().length ? '' : 'Türkçe ses yüklü değil' }));
    } else {
      rows.push(modelRow({ engine: 'tts', item: v, ready: !!v.cached, inUse: useV?.id === v.id, sizeMB: v.sizeMB, prefix: v.cachePrefix }));
    }
  }
  $('models').replaceChildren(...rows);
  const errs = Object.values(lists.errors || {});
  $('modelsError').hidden = !errs.length;
  $('modelsError').textContent = errs.join('\n');
}

async function renderModels() {
  [lists, asrCached] = await Promise.all([engines.listAll(settings), isAsrCached()]);
  const mock = lists.mode === 'mock';
  fillSelect($('mtBackend'), lists.backends, settings.mtBackend, mock ? 'Otomatik' : 'Otomatik (Chrome çevirmeni varsa o)');
  fillSelect($('voice'), lists.voices.map((v) => (v.system ? { ...v, label: 'Tarayıcının sistem sesi (indirme yok)' }
    : v.sizeMB ? { ...v, label: `${v.label} · ${fmtMB(v.sizeMB)}` } : v)),
  settings.voice, mock ? 'Varsayılan' : 'Varsayılan (Antalia Mini)');
  renderModelList();
  try {
    const files = await listCached();
    const bytes = files.reduce((n, f) => n + f.size, 0);
    const any = bytes || asrCached;
    $('storage').textContent = bytes ? `Bu tarayıcıda ${fmtMB(bytes / 1048576)} çeviri/ses model verisi saklanıyor${asrCached ? ' (konuşma tanıma hariç)' : ''}.`
      : asrCached ? 'Konuşma tanıma modeli indirildi.' : 'Henüz model indirilmedi.';
    $('clearModels').hidden = !any;
  } catch {
    $('storage').textContent = 'Bu tarayıcıda model önbelleği kullanılamıyor.';
  }
}

$('clearModels').addEventListener('click', async () => {
  if (!(await confirmBox('İndirilen tüm modeller bu tarayıcıdan silinecek.', 'Tümünü sil'))) return;
  stopSession();
  await engines.resetAll();
  await clearModels();
  await clearAsrCache();
  await renderModels();
  if (job && settings.enabled) startSession();
});

// ---------- Başlangıç ----------

const params = new URLSearchParams(location.search);
if (params.get('v') || params.get('url')) {
  $('ytUrl').value = params.get('url') || `https://www.youtube.com/watch?v=${params.get('v')}`;
}
setTab('source', 'youtube');
renderSettings();
renderSystemVoices();
renderDubToggle();
renderModels().catch((e) => console.warn(LOG, e));
if (!('caches' in window) || typeof WebAssembly !== 'object') {
  ui.status('Bu tarayıcı yerel modelleri çalıştıramıyor. Güncel bir Chrome, Edge ya da Firefox kullanın.', 'error');
}
