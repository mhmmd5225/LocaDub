// Gerçek dublaj: orijinal sesten konuşma ayrılır, yalnızca müzik + efekt çalar (Türkçe dublaj üstüne).
//
//   MAIN dünyası (main-world.js): YouTube'un ses SourceBuffer eklemelerinin kopyası → window.postMessage
//   → burada: WebM/MP4 ayrıştırma (sep-demux.js) → kodlanmış paketler (medya zamanıyla, PacketStore)
//   → iş başına WebCodecs AudioDecoder ile PCM ([a − bağlam, b + bağlam]) → gizli eklenti çerçevesi (sep/host.html,
//     MessageChannel, aktarılabilir Float32Array) → ayırma işçisi (engines/sep/worker.js; WebGPU)
//   → bağlam kırpılır, ekler çapraz geçişle önbelleğe (PcmTimeline) → AudioBufferSourceNode'larla video.currentTime'a
//     eşitlenmiş çalma; bu sırada videonun kendi sesi grafikte susturulur (player.js videoGraph().mute).
//
// Yalnızca oynatma konumunun ilerisi işlenir (en yakın önce). Başta video en çok prebufferSec bekletilir; oynarken
// ayırma yetişmezse (< 2 sn) video duraklatılır, ≥ 8 sn hazır olunca sürer (kalite düşürülmez).
// Durum: 'state' olayı (CustomEvent.detail) ve .state → { status, backend, model, aheadSec, cachedRanges, progress,
// rtf, message }; status: 'off' | 'loading-model' | 'buffering' | 'playing' | 'waiting' | 'error'.

import { audioContext, videoGraph } from './player.js';
import { callMain } from './bridge.js';
import { createDemuxer } from './sep-demux.js';
import {
  SEP, PacketStore, PcmTimeline, HoldGate, DriftMeter, planNext, runJob, aheadOf, committedEnd, rangeAt, windowFor, bestLag,
} from './sep-core.js';

const FROM_MAIN = 'yt-tr-dub:main';
const TICK_MS = 100;
const LEAD = 0.04;      // yeniden eşitlemede ilk parçanın önündeki pay (sn)
const HORIZON = 2;      // bu kadar ilerisi çalmaya önceden kurulur (arka plan sekmesinde zamanlayıcı 1 sn'ye düşer)
const SLICE = 0.5;      // tek AudioBufferSourceNode boyu
const DETECT_MS = 4000; // bu sürede ses akışı yakalanamazsa kapalı
const PREROLL = 0.08;   // çözücü ısınması (opus)
const RATE_EPS = 0.01;

// ---- ayırma ev sahibi çerçevesi (tek; oturumlar arasında model bellekte kalır) ----

let host = null;

class SepHost {
  constructor() {
    this.reqs = new Map();
    this.seq = 0;
    this.mode = null;
    this.spawnP = null;
    this.loadP = null;
    this.info = null;
    this.error = null;
    this.progress = new Set();
    this.ready = this._open();
    this.ready.catch((e) => { this.error = e.message; });
  }

  _open() {
    return new Promise((resolve, reject) => {
      const f = this.frame = document.createElement('iframe');
      f.src = chrome.runtime.getURL('sep/host.html');
      f.setAttribute('aria-hidden', 'true');
      f.tabIndex = -1;
      f.style.cssText = 'position:fixed;left:-10px;top:-10px;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
      const timer = setTimeout(() => reject(new Error('Ayırma çerçevesi açılamadı')), 15000);
      f.addEventListener('load', () => {
        const ch = new MessageChannel();
        this.port = ch.port1;
        this.port.onmessage = (ev) => {
          const m = ev.data;
          if (m?.type === 'host-ready') { clearTimeout(timer); this.gpu = !!m.gpu; resolve(); } else if (m) this._onMsg(m);
        };
        f.contentWindow.postMessage({ type: 'locadub-sep-port' }, new URL(f.src).origin, [ch.port2]);
      }, { once: true });
      (document.body || document.documentElement).appendChild(f);
    });
  }

  spawn(mode) {
    if (this.mode === mode && this.spawnP) return this.spawnP;
    this.mode = mode;
    this.loadP = null;
    this.info = null;
    this.error = null;
    this._rejectAll('Ayırma işçisi yeniden başlatıldı');
    this.spawnP = this.ready.then(() => new Promise((res, rej) => {
      this._spawnWait = { res, rej };
      this.port.postMessage({ type: 'spawn', mode });
    }));
    return this.spawnP;
  }

  load(opts = {}) {
    if (!this.loadP) {
      this.loadP = this.spawnP.then(() => this._req({ type: 'load', ...opts })).then((m) => (this.info = m));
      this.loadP.catch(() => { this.loadP = null; });
    }
    return this.loadP;
  }

  process(left, right, sampleRate, extra = {}) {
    return this._req({ type: 'process', left, right, sampleRate, ...extra }, [left.buffer, right.buffer]);
  }

  post(msg) { this.ready.then(() => this.port.postMessage(msg)).catch(() => {}); }

  _req(msg, transfer = []) {
    if (this.error) return Promise.reject(new Error(this.error));
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.reqs.set(id, { res, rej });
      this.port.postMessage({ ...msg, id }, transfer);
    });
  }

  _rejectAll(message) {
    for (const r of this.reqs.values()) r.rej(new Error(message));
    this.reqs.clear();
  }

  _onMsg(m) {
    if (m.type === 'spawned') { this._spawnWait?.res(m); this._spawnWait = null; return; }
    if (m.type === 'progress') { for (const f of this.progress) f(m); return; }
    if (m.type === 'error' && m.id == null) {
      this.error = m.message;
      this._spawnWait?.rej(new Error(m.message));
      this._spawnWait = null;
      this._rejectAll(m.message);
      return;
    }
    const r = this.reqs.get(m.id);
    if (!r) return;
    this.reqs.delete(m.id);
    if (m.type === 'error') r.rej(new Error(m.message || 'Ayırma hatası'));
    else r.res(m);
  }

  dispose() {
    try { this.port?.postMessage({ type: 'dispose' }); } catch { /* yoksay */ }
    this._rejectAll('Ayırma kapatıldı');
    setTimeout(() => this.frame?.remove(), 600);
  }
}

function sepHost() {
  return host || (host = new SepHost());
}

/** Ayırma işçisini ve çerçeveyi kapat (ayar kapatılınca; GPU belleği boşalır). */
export function disposeSeparation() {
  host?.dispose();
  host = null;
}

// ---- çözme ----

function decoderConfig(cfg) {
  const c = { codec: cfg.codec, sampleRate: cfg.sampleRate, numberOfChannels: cfg.numberOfChannels };
  if (cfg.description) c.description = cfg.description;
  return c;
}

const supported = new WeakMap(); // cfg → Promise<boolean>
function isSupported(cfg) {
  if (!supported.has(cfg)) {
    supported.set(cfg, typeof AudioDecoder === 'function'
      ? AudioDecoder.isConfigSupported(decoderConfig(cfg)).then((r) => !!r.supported).catch(() => false)
      : Promise.resolve(false));
  }
  return supported.get(cfg);
}

// AudioData → kanal dizileri (f32-planar; dönüştürülemezse araya serpiştirilmiş f32'den ayrılır)
function planes(ad) {
  const n = ad.numberOfFrames, ch = ad.numberOfChannels;
  const out = [];
  try {
    for (let c = 0; c < Math.min(ch, 2); c++) {
      const a = new Float32Array(n);
      ad.copyTo(a, { planeIndex: c, format: 'f32-planar' });
      out.push(a);
    }
  } catch {
    out.length = 0;
    const inter = new Float32Array(n * ch);
    ad.copyTo(inter, { planeIndex: 0, format: 'f32' });
    for (let c = 0; c < Math.min(ch, 2); c++) {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = inter[i * ch + c];
      out.push(a);
    }
  }
  if (out.length === 1) out.push(out[0]);
  return out;
}

/** Paketleri çözüp [ra, rb) (örnek, sr) aralığına zaman damgasına göre yerleştirir; eksik yerler sıfır. */
async function decodeRange(packets, ra, rb, sr) {
  const L = new Float32Array(rb - ra), R = new Float32Array(rb - ra);
  let dec = null, cfg = null, err = null, rateSeen = sr;
  const place = (ad) => {
    try {
      if (ad.sampleRate !== sr) { rateSeen = ad.sampleRate; return; }
      const [l, r] = planes(ad);
      const at = Math.round((ad.timestamp / 1e6) * sr) - ra;
      const from = Math.max(0, -at), to = Math.min(l.length, rb - ra - at);
      if (to > from) { L.set(l.subarray(from, to), at + from); R.set(r.subarray(from, to), at + from); }
    } finally { ad.close(); }
  };
  const finish = async () => { if (dec) { await dec.flush(); dec.close(); dec = null; } };
  for (const p of packets) {
    if (p.cfg !== cfg) {
      await finish();
      cfg = p.cfg;
      if (!(await isSupported(cfg))) throw new Error(`Ses biçimi çözülemiyor (${cfg.codec})`);
      dec = new AudioDecoder({ output: place, error: (e) => { err = e; } });
      dec.configure(decoderConfig(cfg));
    }
    dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(p.t * 1e6), duration: Math.round(p.dur * 1e6), data: p.data }));
  }
  await finish();
  if (err) throw new Error('Ses çözülemedi: ' + (err.message || err));
  return { L, R, rate: rateSeen };
}

// ---- ayrılmış sesin çalınması ----

export class SeparatedAudio extends EventTarget {
  /**
   * video: <video>; mode: 'real' | 'mock'; prebufferSec: başta en çok bekletme (5–60);
   * otherHold(): dublajın kendi başlangıç bekletmesi sürüyor mu (app.js _hold) — iki bekletme birbirinin videosunu
   * erken sürdürmesin.
   */
  constructor(video, { mode = 'real', prebufferSec = 20, otherHold = () => false } = {}) {
    super();
    this.video = video;
    this.mode = mode;
    this.prebufferSec = prebufferSec;
    this.otherHold = otherHold;
    this.alive = true;
    this.ctxSec = SEP.ctxSec;
    this.xfSec = SEP.xfSec;
    this.sources = new Map(); // msId → { url, store, demux: Map<sbId, demuxer> }
    this.sep = null;          // PcmTimeline (ayrılmış)
    this.job = null;
    this.ready = false;
    this.error = null;
    this.offReason = null;
    this.progress = 0;
    this.rtf = 0;
    this.backend = null;
    this.model = null;
    this.aheadSec = 0;
    this.gate = new HoldGate();
    this.drift = new DriftMeter();
    this._hold = { active: false, ours: false, resuming: false };
    this._sched = [];         // { node, k0, k1, m0 }
    this._anchor = null;
    this._schedEnd = 0;
    this._t0 = performance.now();
    this._fails = 0;
    this._listeners = [];
    this._last = {};
    this._lastEmit = 0;
    this._onWin = (ev) => this._onMain(ev);
    this._onProgress = (m) => {
      const total = Number(m.total) || 0;
      this.progress = total ? Math.min(1, (Number(m.loaded) || 0) / total) : this.progress;
    };
  }

  get holding() { return this._hold.active; }

  get state() {
    const t = this.video.currentTime;
    return {
      status: this.status || 'off',
      backend: this.backend,
      model: this.model,
      aheadSec: Math.round(this.aheadSec * 10) / 10,
      cachedRanges: this.sep ? this.sep.rangesSec().map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10]) : [],
      progress: this.ready ? 1 : Math.round(this.progress * 100) / 100,
      rtf: Math.round(this.rtf * 1000) / 1000,
      message: this._message(t),
    };
  }

  setPrebuffer(sec) { this.prebufferSec = sec; }

  start() {
    const v = this.video;
    window.addEventListener('message', this._onWin);
    const on = (ev, fn) => { v.addEventListener(ev, fn); this._listeners.push([ev, fn]); };
    on('seeking', () => this._stopAll());
    on('pause', () => this._stopAll());
    on('playing', () => this._tickPlay());
    on('volumechange', () => this._applyVolume());
    on('play', () => {
      // bekletme sırasında kullanıcı oynattı: bekletme biter, ayırma yeniden yetişene dek video durdurulmaz
      if (this._hold.active && !this._hold.resuming) { this.gate.userOverride(); this._hold.active = false; this._hold.ours = false; }
    });
    callMain('sep-subscribe').catch(() => {});
    const h = sepHost();
    h.progress.add(this._onProgress);
    h.spawn(this.mode)
      // model kendiliğinden: WebGPU'da Kim Vocal 2, yoksa hafif model daha az örtüşmeyle (engines/sep/worker.js)
      .then(() => h.load({ model: 'auto', backend: 'auto', ...(h.gpu ? {} : { overlap: 0.25 }) }))
      .then((info) => {
        if (!this.alive) return;
        this.ready = true;
        this.backend = info.backend || null;
        this.model = info.model || null;
        if (Number.isFinite(info.contextSec)) this.ctxSec = Math.min(3, Math.max(0, info.contextSec));
      })
      .catch((e) => this._fail(e?.message || String(e)));
    this._timer = setInterval(() => this._tick(), TICK_MS);
    this._tick();
    return this;
  }

  destroy() {
    if (!this.alive) return;
    this.alive = false;
    clearInterval(this._timer);
    window.removeEventListener('message', this._onWin);
    for (const [ev, fn] of this._listeners) this.video.removeEventListener(ev, fn);
    host?.progress.delete(this._onProgress);
    callMain('sep-unsubscribe').catch(() => {});
    this._stopAll();
    this._setOrig(true);
    try { this.out?.disconnect(); } catch { /* yoksay */ }
    this._releaseHold();
    this.status = 'off';
    this._emit(true);
    if (this.mode === 'mock') delete document.documentElement.dataset.locadubSep;
  }

  _fail(message) {
    if (!this.alive || this.error) return;
    this.error = message;
    console.warn('[yt-tr-dub] ayırma:', message);
    this._stopAll();
    this._setOrig(true);
  }

  // ---- yakalama (MAIN dünyası → paketler) ----

  _src(msId) {
    let s = this.sources.get(msId);
    if (!s) {
      s = { url: null, store: new PacketStore(), demux: new Map() };
      this.sources.set(msId, s);
      while (this.sources.size > 3) this.sources.delete(this.sources.keys().next().value);
    }
    return s;
  }

  _onMain(ev) {
    if (ev.source !== window || ev.data?.source !== FROM_MAIN) return;
    const m = ev.data;
    if (typeof m.type !== 'string' || !m.type.startsWith('sep-')) return;
    if (m.type === 'sep-close') { this.sources.delete(m.msId); return; }
    const s = this._src(m.msId);
    if (m.url) s.url = m.url;
    if (m.type === 'sep-abort') { s.demux.get(m.sbId)?.abort(); return; }
    if (m.type !== 'sep-append' || !(m.data instanceof ArrayBuffer)) return;
    let d = s.demux.get(m.sbId);
    if (!d || d.mime !== m.mime) {
      const nd = createDemuxer(m.mime);
      if (!nd) return;
      nd.mime = m.mime;
      if (d?.cfg && nd.kind === d.kind) nd.cfg = d.cfg; // changeType: aynı tür
      s.demux.set(m.sbId, (d = nd));
    }
    try {
      for (const p of d.push(new Uint8Array(m.data), { tso: m.tso })) s.store.add(p);
    } catch (e) {
      console.debug('[yt-tr-dub] ayırma: ayrıştırılamadı', e);
      d.abort();
    }
    if (d.encrypted) s.encrypted = true;
  }

  /** Videonun şu anki MediaSource'unun paketleri (ya da null). */
  _current() {
    const src = this.video.src || this.video.currentSrc;
    for (const s of this.sources.values()) if (s.url && s.url === src) return s;
    return null;
  }

  // ---- ana döngü ----

  _tick() {
    if (!this.alive) return;
    const v = this.video;
    const now = performance.now();
    const t = v.currentTime;
    const cur = this._current();
    const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity;
    // kapalı nedenleri
    const src = String(v.src || v.currentSrc);
    const blob = src.startsWith('blob:');
    // yeni kaynak (gömülüde ilk oynatmada, reklam sonrası): yakalama süresi yeniden başlar
    if (blob && src !== this._srcUrl) { this._srcUrl = src; if (!cur?.store.size) this._t0 = now; }
    if (!blob) this.offReason = 'Bu oynatıcıda ses akışı yakalanamıyor (MSE değil).';
    else if (!cur?.store.size && now - this._t0 > DETECT_MS) this.offReason = 'Ses akışı yakalanamadı; orijinal ses çalıyor.';
    else if (cur?.encrypted) { this._fail('Şifreli (DRM) ses: ayırma yapılamıyor.'); this.offReason = null; }
    else this.offReason = null;
    const rateOk = Math.abs(v.playbackRate - 1) < RATE_EPS;

    // önbellek ve iş
    const raw = cur ? cur.store.ranges() : [];
    if (cur && !this.sep && cur.store.size) this.sep = new PcmTimeline(cur.store.list[0].cfg.sampleRate);
    const sepR = this.sep ? this.sep.rangesSec() : [];
    this.aheadSec = aheadOf(sepR, t, { duration, xfSec: this.xfSec });
    const windowSec = windowFor(this.prebufferSec);
    const plan = this.error || this.offReason || !this.sep ? null : planNext({
      t, raw, sep: sepR, duration, windowSec, aheadSec: this.aheadSec, ctxSec: this.ctxSec, xfSec: this.xfSec,
    });
    if (plan && this.ready && !this.job) this._run(plan, cur);
    if (now - (this._lastPrune || 0) > 1000) {
      this._lastPrune = now;
      for (const s of this.sources.values()) s.store.prune(t - SEP.packetsBehindSec);
      if (this.sep) {
        const sr = this.sep.sr;
        this.sep.prune(Math.round((t - SEP.keepBehindSec) * sr), Math.round((t + windowSec + SEP.chunkSec + 5) * sr));
      }
    }

    // bekletme
    const detecting = blob && !cur?.store.size && now - this._t0 <= DETECT_MS;
    const pending = !!this.job || !!plan || detecting;
    const failed = !!this.error || !!this.offReason || !rateOk || v.ended;
    const want = this.gate.update({ elapsedMs: now - this._t0, prebufferSec: this.prebufferSec, aheadSec: this.aheadSec, pending, ready: this.ready, failed });
    this._applyHold(want);

    // durum
    if (this.error) this.status = 'error';
    else if (this.offReason || !rateOk) this.status = 'off';
    else if (!this.ready) this.status = 'loading-model';
    else if (this._hold.active && !this.gate.initial) this.status = 'waiting';
    else if (this._hold.active || !this._covered(t)) this.status = 'buffering';
    else this.status = 'playing';

    this._tickPlay();
    if (this.mode === 'mock') this._mockTick(now);
    this._emit();
  }

  async _run(job, cur) {
    this.job = job;
    const sr = this.sep.sr;
    const sep = this.sep;
    const h = sepHost();
    const t0 = performance.now();
    try {
      const res = await runJob(job, {
        timeline: sep,
        xfSec: this.xfSec,
        readRaw: async (ra, rb) => {
          const pk = cur.store.packetsIn(ra / sr - PREROLL, rb / sr);
          const out = await decodeRange(pk, ra, rb, sr);
          if (out.rate !== sr) throw Object.assign(new Error('örnekleme hızı değişti'), { rate: out.rate });
          return out;
        },
        separate: (L, R, rate) => h.process(L, R, rate, this.mode === 'mock' ? { mockRtf: this._mockRtf() } : {}),
      });
      if (!this.alive) return;
      const sec = job.b - job.a;
      const r = (res.ms ?? performance.now() - t0) / 1000 / Math.max(0.1, sec);
      this.rtf = this.rtf ? this.rtf * 0.7 + r * 0.3 : r;
      if (res.backend) this.backend = res.backend;
      this._fails = 0;
    } catch (e) {
      if (!this.alive) return;
      if (e?.rate) { this.sep = new PcmTimeline(e.rate); this._stopAll(); return; } // ayrılmış önbellek yeni hızla
      console.warn('[yt-tr-dub] ayırma parçası başarısız', job, e);
      if (++this._fails >= 3 || h.error) this._fail(e?.message || String(e));
    } finally {
      if (this.job === job) this.job = null;
    }
  }

  // ---- bekletme (videoyu duraklatma / sürdürme) ----

  _applyHold(want) {
    const v = this.video, h = this._hold;
    if (want && !h.active) {
      if (!v.paused) { h.active = true; h.ours = true; v.pause(); }
      else if (this.otherHold()) { h.active = true; h.ours = true; } // dublajın başlangıç bekletmesini devral
      // kullanıcı durdurmuşsa dokunma; oynatınca yeniden bakılır
    } else if (!want && h.active) {
      this._releaseHold();
    }
  }

  _releaseHold() {
    const v = this.video, h = this._hold;
    if (!h.active) return;
    const ours = h.ours;
    h.active = false;
    h.ours = false;
    if (ours && v.paused && !this.otherHold()) {
      h.resuming = true;
      v.play().catch(() => {}).finally(() => { h.resuming = false; });
    }
  }

  // ---- çalma ----

  _covered(t) {
    if (!this.sep) return false;
    const r = rangeAt(this.sep.rangesSec(), t);
    return !!r && t < committedEnd(r[1], this._duration(), this.xfSec) - 0.05;
  }

  _duration() {
    const d = this.video.duration;
    return Number.isFinite(d) && d > 0 ? d : Infinity;
  }

  _ensureOut(c) {
    if (this.out) return;
    this.out = c.createGain();
    this.out.connect(c.destination);
    this._applyVolume();
  }

  // Ayrılmış ses = oynatıcının ses düzeyi (YouTube ses düğmesi / sessiz); kısılmaz (dublaj ducking'i orijinale uygulanır).
  _applyVolume() {
    if (!this.out) return;
    const v = this.video;
    this.out.gain.value = v.muted ? 0 : v.volume;
  }

  _setOrig(on, at = null) {
    const g = this._graph;
    const c = audioContext();
    if (!g || !c) return;
    const when = Math.max(c.currentTime, at ?? c.currentTime);
    g.mute.gain.cancelScheduledValues(when);
    g.mute.gain.setTargetAtTime(on ? 1 : 0, when, 0.008);
    this._origOn = on;
  }

  _stopAll() {
    for (const s of this._sched) { try { s.node.onended = null; s.node.stop(); s.node.disconnect(); } catch { /* yoksay */ } }
    this._sched = [];
    this._anchor = null;
    this._gapAt = 0;
    this.drift.reset();
  }

  _tickPlay() {
    if (!this.alive) return;
    const v = this.video;
    const c = audioContext();
    if (!this._graph && c?.state === 'running') this._graph = videoGraph(v);
    const g = this._graph;
    const rateOk = Math.abs(v.playbackRate - 1) < RATE_EPS;
    const usable = !!g && c.state === 'running' && rateOk && !this.error && !this.offReason && !!this.sep;
    const t = v.currentTime;
    if (!usable || v.paused || v.seeking || v.ended) {
      this._stopAll();
      // duraklatılmışken ayrılmış ses hazırsa orijinal susuk kalır (oynatınca konuşma sızmasın)
      const keepMuted = usable && this._covered(t);
      if (this._origOn !== !keepMuted) this._setOrig(!keepMuted);
      return;
    }
    this._ensureOut(c);
    const k = c.currentTime;
    const sr = this.sep.sr;
    // kayma: çalan parçanın medya zamanı − video zamanı
    const now = this._sched.find((s) => s.k0 <= k && k < s.k1);
    if (now) {
      this._lastDrift = now.m0 + (k - now.k0) - t;
      if (this.drift.push(this._lastDrift)) {
        console.debug('[yt-tr-dub] ayırma: yeniden eşitleme, kayma', Math.round(this.drift.median * 1000), 'ms,', t.toFixed(2), 'sn');
        this._resyncs = (this._resyncs || 0) + 1;
        this._stopAll();
      }
    }
    if (this._anchor && this._schedEnd < t + 0.02) this._stopAll(); // kurulan ses bitti (boşluk sonrası): yeniden
    if (!this._anchor) {
      const m0 = t + LEAD;
      if (!this._covered(m0)) { if (!this._origOn) this._setOrig(true); return; }
      this._anchor = { m: m0, k: k + LEAD };
      this._schedEnd = m0;
      this.drift.reset();
      this._setOrig(false, k + LEAD);
    }
    const A = this._anchor;
    const kFor = (m) => A.k + (m - A.m);
    while (this._schedEnd < t + HORIZON) {
      const s0 = Math.round(this._schedEnd * sr);
      const r = rangeAt(this.sep.rangesSec(), this._schedEnd);
      const e = r ? Math.round(committedEnd(r[1], this._duration(), this.xfSec) * sr) : s0;
      if (e - s0 < 64) { // ayrılmış ses bitti: o anda orijinale dön
        if (!this._gapAt) { this._gapAt = kFor(this._schedEnd); this._setOrig(true, this._gapAt); }
        return;
      }
      if (this._gapAt) { this._setOrig(false, Math.max(k, kFor(this._schedEnd))); this._gapAt = 0; }
      const s1 = Math.min(e, s0 + Math.round(SLICE * sr));
      const { L, R } = this.sep.read(s0, s1);
      const buf = c.createBuffer(2, s1 - s0, sr);
      buf.copyToChannel(L, 0);
      buf.copyToChannel(R, 1);
      const node = c.createBufferSource();
      node.buffer = buf;
      node.connect(this.out);
      const when = kFor(s0 / sr);
      const item = { node, k0: when, k1: when + (s1 - s0) / sr, m0: s0 / sr };
      if (when >= k) node.start(when);
      else node.start(k, k - when);
      node.onended = () => { const i = this._sched.indexOf(item); if (i >= 0) this._sched.splice(i, 1); };
      this._sched.push(item);
      this._schedEnd = s1 / sr;
    }
  }

  // ---- durum ----

  _message(t) {
    const a = Math.floor(this.aheadSec);
    switch (this.status) {
      case 'error': return 'Ses ayırma çalışmıyor: ' + this.error + ' Orijinal ses çalıyor.';
      case 'off': return this.offReason || (Math.abs(this.video.playbackRate - 1) >= RATE_EPS
        ? 'Oynatma hızı 1x değil: orijinal ses çalıyor (ayrılmış ses perdesi korunamaz).' : 'Ses ayırma kapalı.');
      case 'loading-model': return `Ses ayırma modeli yükleniyor… %${Math.round(this.progress * 100)}` +
        (this._hold.active ? ' Video hazır olunca sürecek.' : '');
      case 'waiting': return `Ses ayırma geride kaldı; ${SEP.high} sn hazır olunca video sürecek (${a} sn hazır).`;
      case 'buffering': return this._hold.active
        ? `Gerçek dublaj hazırlanıyor: konuşma sesten ayrılıyor… (${a}/${Math.round(this.prebufferSec)} sn)`
        : 'Ses ayırma yetişmedi: bu bölümde orijinal ses çalıyor.';
      case 'playing': return `Gerçek dublaj: yalnızca müzik ve efektler${this.backend ? ` (${this.backend})` : ''}.` +
        (this.backend === 'wasm' ? ' GPU (WebGPU) yok: ayırma yavaş, video ara ara bekleyebilir.' : '');
      default: void t; return '';
    }
  }

  _emit(force = false) {
    const st = this.state;
    const key = st.status + '|' + st.message.replace(/\d+/g, '#');
    const now = performance.now();
    if (!force && key === this._last.key && now - this._lastEmit < 500) return;
    if (!force && key === this._last.key && JSON.stringify(st) === this._last.json) return;
    this._last = { key, json: JSON.stringify(st) };
    this._lastEmit = now;
    this.dispatchEvent(new CustomEvent('state', { detail: st }));
  }

  // ---- test motoru: yavaşlatma ve senkron ölçümü (yalnızca mode === 'mock') ----

  _mockRtf() {
    return Number(document.documentElement.dataset.locadubMockSepRtf) || 0;
  }

  _mockTick(now) {
    const rtf = this._mockRtf();
    if (rtf !== this._lastMockRtf) { this._lastMockRtf = rtf; sepHost().post({ type: 'mock-rtf', rtf }); }
    const c = audioContext();
    // ölçüm: orijinal (susturmadan önce) ile ayrılmış çıkışın çapraz ilintisi → gerçek duyulan kayma
    if (this._graph && this.out && !this._taps) {
      const mk = () => { const a = c.createAnalyser(); a.fftSize = 8192; return a; };
      this._taps = { orig: mk(), sep: mk() };
      this._graph.gain.connect(this._taps.orig);
      this.out.connect(this._taps.sep);
    }
    if (this._taps && this.status === 'playing' && this._sched.length && now - (this._lastProbe || 0) > 1500) {
      this._lastProbe = now;
      const a = new Float32Array(8192), b = new Float32Array(8192);
      this._taps.orig.getFloatTimeDomainData(a);
      this._taps.sep.getFloatTimeDomainData(b);
      const { lag, score } = bestLag(a, b, Math.round(0.06 * c.sampleRate));
      this._probe = { lagMs: Math.round((lag / c.sampleRate) * 1000 * 10) / 10, score: Math.round(score * 100) / 100, t: Math.round(this.video.currentTime * 10) / 10 };
    }
    const g = this._graph;
    document.documentElement.dataset.locadubSep = JSON.stringify({
      ...this.state, holding: this._hold.active, initial: this.gate.initial,
      origGain: g ? Math.round(g.mute.gain.value * 1000) / 1000 : null,
      scheduled: this._sched.length, drift: this._lastDrift != null ? Math.round(this._lastDrift * 1000) : null,
      resyncs: this._resyncs || 0, probe: this._probe || null, job: this.job ? [this.job.a, this.job.b] : null,
    });
  }
}
