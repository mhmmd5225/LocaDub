// Konuşma tanıma: videonun sesinden İngilizce zaman damgalı cümleler üretir (altyazı gerekmez).
//
// - Transcriber      Whisper işçisinin sarmalayıcısı (asr-worker.js)
// - Segmenter        akan 16 kHz sesi video zamanıyla etiketleyip sessiz noktalardan ≤ 24 sn'lik pencerelere böler
// - Coverage         yazıya dökülmüş video zaman aralıkları
// - BufferSource     bilgisayardaki video: sesi dosyadan çözer, oynatma konumunun önünden sırayla yazıya döker
// Saf yardımcılar (quietestCut, chunksToCues, Coverage) node testleriyle sınanır.

export const SR = 16000;
export const ASR_MODEL = {
  id: 'whisper-base.en',
  repo: 'onnx-community/whisper-base.en',
  label: 'Whisper base.en (konuşma tanıma)',
  dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
  sizeMB: 136,
  // transformers.js modeli kendi önbelleğinde tutar
  cacheName: 'transformers-cache',
  probeUrl: 'https://huggingface.co/onnx-community/whisper-base.en/resolve/main/onnx/encoder_model.onnx',
};

const WINDOW_MAX = 24;   // sn ses; Whisper 30 sn'lik bağlamla çalışır
const WINDOW_MIN = 14;   // bu süreden sonra sessiz bir noktada kes
const FIRST_MIN = 6;     // başlangıçta/sarmadan sonra ilk pencere: dublaj çabuk başlasın
const QUIET_FRAME = 0.2; // sn

// [from, to) aralığındaki en sessiz QUIET_FRAME'in ortası (örnek indeksi).
export function quietestCut(audio, from, to, sr = SR) {
  const frame = Math.max(1, Math.round(QUIET_FRAME * sr));
  let best = to, bestE = Infinity;
  for (let a = Math.max(0, from); a + frame <= Math.min(to, audio.length); a += frame >> 1) {
    let e = 0;
    for (let i = a; i < a + frame; i += 4) e += audio[i] * audio[i];
    if (e < bestE) { bestE = e; best = a + (frame >> 1); }
  }
  return best;
}

const rms = (a) => {
  let e = 0;
  for (let i = 0; i < a.length; i += 8) e += a[i] * a[i];
  return Math.sqrt(e / Math.max(1, a.length / 8));
};

// Whisper'ın sessizlik/müzik üzerinde uydurduğu kalıplar.
const HALLUCINATION = /^(thank you\.?|thanks for watching!?|you|bye\.?|\.+|music|\W*)$/i;

// Whisper parça başlangıçları kabadır (çoğu zaman önceki sessizliği de kapsar): [from, from+maxSec) içinde
// konuşmanın gerçekten başladığı ilk anı (sn) bulur; bulamazsa from döner.
export function speechOnset(audio, fromSec, maxSec = 3, sr = SR) {
  if (!audio) return fromSec;
  const frame = Math.round(0.03 * sr);
  const a0 = Math.round(fromSec * sr), a1 = Math.min(audio.length, a0 + Math.round(maxSec * sr));
  for (let a = a0; a + frame <= a1; a += frame) {
    let e = 0;
    for (let i = a; i < a + frame; i++) e += audio[i] * audio[i];
    if (Math.sqrt(e / frame) > 0.02) return Math.max(fromSec, a / sr - 0.05);
  }
  return fromSec;
}

/** Pencere çıktısı → video zamanlı parçalar (ms; captions.js mergeSentences girdisi). */
export function chunksToCues(chunks, startVideo, rate = 1, audioSec = Infinity, audio = null) {
  const out = [];
  for (const c of chunks || []) {
    const text = String(c.text || '').trim();
    if (!text || HALLUCINATION.test(text)) continue;
    const a = speechOnset(audio, Math.max(0, Number(c.start) || 0));
    // end null: Whisper parçayı pencere sonunda kesti → pencerenin sonuna kadar
    const guess = Number.isFinite(audioSec) && c.end == null ? audioSec : a + Math.max(1, text.length / 15);
    const b = Math.min(audioSec, Number.isFinite(c.end) && c.end > a ? c.end : guess);
    out.push({ start: Math.round((startVideo + a * rate) * 1000), end: Math.round((startVideo + b * rate) * 1000), text });
  }
  return out;
}

/** Yazıya dökülmüş video aralıkları (sn), birleşik ve sıralı. */
export class Coverage {
  constructor() { this.list = []; }
  add(a, b) {
    if (!(b > a)) return;
    const l = [...this.list, [a, b]].sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const [s, e] of l) {
      const last = out[out.length - 1];
      if (last && s <= last[1] + 1.5) last[1] = Math.max(last[1], e);
      else out.push([s, e]);
    }
    this.list = out;
  }
  /** t'yi içeren aralığın sonu; t kapsanmıyorsa -1. */
  until(t) {
    for (const [s, e] of this.list) if (t >= s - 1.5 && t < e) return e;
    return -1;
  }
}

// ---------- Whisper ----------

export class Transcriber {
  constructor() {
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.onProgress = null;
    this.ready = null;
  }
  _w() {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module', name: 'asr' });
    const files = new Map();
    this.worker.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === 'progress') {
        files.set(m.file, { loaded: m.loaded || 0, total: m.total || 0 });
        let L = 0, T = 0;
        for (const f of files.values()) { L += f.loaded; T += f.total; }
        this.onProgress?.({ engine: 'asr', loaded: L, total: T });
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.type === 'error') p.reject(new Error(m.message));
      else p.resolve(m);
    };
    this.worker.onerror = (ev) => {
      const e = new Error('Konuşma tanıma işçisi yüklenemedi: ' + (ev.message || 'ağ hatası'));
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
      this.worker = null;
      this.ready = null;
    };
    return this.worker;
  }
  _req(msg, transfer) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._w().postMessage({ ...msg, id }, transfer || []);
    });
  }
  load(onProgress) {
    if (onProgress) this.onProgress = onProgress;
    if (!this.ready) {
      this.ready = this._req({ type: 'load', model: ASR_MODEL.repo, dtype: ASR_MODEL.dtype })
        .then(() => this.onProgress?.({ engine: 'asr', done: true }));
      this.ready.catch(() => { this.ready = null; });
    }
    return this.ready;
  }
  /** Pencere → video zamanlı parçalar. Sessiz pencerede Whisper çalıştırılmaz. */
  async transcribe(win) {
    const audioSec = win.audio.length / SR;
    if (rms(win.audio) < 0.004) return [];
    await this.load();
    const { chunks } = await this._req({ type: 'transcribe', audio: win.audio });
    return chunksToCues(chunks, win.startVideo, win.rate, audioSec, win.audio);
  }
  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    for (const p of this.pending.values()) p.reject(new Error('İptal edildi'));
    this.pending.clear();
  }
}

export async function isAsrCached() {
  try { return !!(await (await caches.open(ASR_MODEL.cacheName)).match(ASR_MODEL.probeUrl)); } catch { return false; }
}

export async function clearAsrCache() {
  try { return await caches.delete(ASR_MODEL.cacheName); } catch { return false; }
}

// ---------- Akan ses → pencereler ----------

/**
 * push(samples, videoTime, rate): videoTime = bu bloğun ilk örneğinin video zamanı.
 * Sıçrama (ileri/geri sarma) ya da hız değişiminde pencere kapanır. onWindow({ audio, startVideo, rate }).
 */
export class Segmenter {
  constructor(onWindow) {
    this.onWindow = onWindow;
    this.buf = new Float32Array(WINDOW_MAX * SR + SR);
    this.len = 0;
    this.startVideo = 0;
    this.rate = 1;
    this.first = true;
  }
  _expected() { return this.startVideo + (this.len / SR) * this.rate; }
  push(samples, videoTime, rate) {
    // Zaman kaynağı ses örneklerinin sayısıdır (kesintisiz). Oynatıcı saati yük altında saniyelerce takılabilir;
    // yalnızca büyük sıçrama elle sarmadır (kendi sarmalarımızdan önce flush() zaten çağrılır).
    if (this.len && (rate !== this.rate || Math.abs(videoTime - this._expected()) > 5)) this.flush();
    if (!this.len) { this.startVideo = videoTime; this.rate = rate; }
    let off = 0;
    while (off < samples.length) {
      const n = Math.min(samples.length - off, this.buf.length - this.len);
      this.buf.set(samples.subarray(off, off + n), this.len);
      this.len += n;
      off += n;
      if (this.len >= WINDOW_MAX * SR) this._cut();
    }
    if (this.len >= (this.first ? FIRST_MIN : WINDOW_MIN) * SR && this._quietTail()) this._cut(this.len);
  }
  // Son 0.4 sn sessizse (cümle arası) burada kesmek kelime bölmez.
  _quietTail() {
    const n = Math.round(0.4 * SR);
    return rms(this.buf.subarray(this.len - n, this.len)) < 0.01;
  }
  _cut(at) {
    const cut = at ?? quietestCut(this.buf, Math.round(WINDOW_MIN * SR), this.len);
    this._emit(cut);
  }
  _emit(cut) {
    const audio = this.buf.slice(0, cut);
    const win = { audio, startVideo: this.startVideo, rate: this.rate };
    const rest = this.buf.slice(cut, this.len);
    this.startVideo += (cut / SR) * this.rate;
    this.buf.set(rest, 0);
    this.len = rest.length;
    this.first = false;
    if (audio.length >= 0.5 * SR) this.onWindow(win);
  }
  flush() {
    if (this.len) this._emit(this.len);
    this.len = 0;
    this.first = true;
  }
}

// ---------- Bilgisayardaki video ----------

/** Dosyanın tüm sesini 16 kHz mono olarak çözer. */
export async function decodeFileAudio(file) {
  const buf = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, SR);
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(buf);
  } catch {
    throw new Error('Videonun sesi çözülemedi (tarayıcı bu ses biçimini desteklemiyor olabilir).');
  }
  if (decoded.sampleRate === SR && decoded.numberOfChannels === 1) return decoded.getChannelData(0);
  // Örnekleme hızı farklıysa OfflineAudioContext ile yeniden örnekle (kanallar ortalanır).
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * SR), SR);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

/**
 * Dosya sesini oynatma konumunun önünden sırayla yazıya döker. follow(t) ile konum bildirilir;
 * kapsanmamış bir yere sarılırsa oradan devam eder. Olaylar: onCues(cues), onCoverage(), onError(e).
 */
export class BufferSource {
  constructor(audio, transcriber, { lookaheadSec = 90 } = {}) {
    this.audio = audio;
    this.tr = transcriber;
    this.duration = audio.length / SR;
    this.coverage = new Coverage();
    this.cursor = 0;
    this.t = 0;
    this.lookahead = lookaheadSec;
    this.alive = true;
    this.onCues = null;
    this.onCoverage = null;
    this.onError = null;
    this._wake = null;
  }
  follow(t) {
    this.t = t;
    if (this.coverage.until(t) < 0 && Math.abs(t - this.cursor) > 1) this.cursor = Math.max(0, t - 0.5);
    this._wake?.();
  }
  until(t) { return t >= this.duration - 0.5 ? Infinity : this.coverage.until(t); }
  async run() {
    while (this.alive) {
      // İmleç kapsanmış bir aralığa girdiyse sonuna atla.
      const u = this.coverage.until(this.cursor);
      if (u > 0) this.cursor = u;
      if (this.cursor >= this.duration - 0.05 || this.cursor > this.t + this.lookahead) {
        await new Promise((r) => { this._wake = r; setTimeout(r, 1000); });
        this._wake = null;
        continue;
      }
      const a = Math.round(this.cursor * SR);
      let b = Math.min(this.audio.length, a + WINDOW_MAX * SR);
      if (b < this.audio.length) b = quietestCut(this.audio, a + WINDOW_MIN * SR, b);
      const win = { audio: this.audio.slice(a, b), startVideo: this.cursor, rate: 1 };
      const from = this.cursor, to = b / SR;
      try {
        const cues = await this.tr.transcribe(win);
        if (!this.alive) return;
        this.coverage.add(from, to);
        if (cues.length) this.onCues?.(cues);
        this.onCoverage?.();
        if (this.cursor === from) this.cursor = to;
      } catch (e) {
        if (!this.alive) return;
        this.onError?.(e);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  destroy() { this.alive = false; this._wake?.(); }
}
