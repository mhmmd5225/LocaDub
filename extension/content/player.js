// Ses çalma (Web Audio) ve orijinal sesi kısma (ducking).

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let ctx = null;
export function audioContext() {
  if (!ctx) {
    try { ctx = new AudioContext({ latencyHint: 'interactive' }); } catch { ctx = null; }
  }
  return ctx;
}

export async function resumeAudio() {
  const c = audioContext();
  if (c && c.state === 'suspended') { try { await c.resume(); } catch { /* yoksay */ } }
  return !!c && c.state === 'running';
}

// TTS çalar: <audio> (perde korumalı playbackRate) → MediaElementSource → Gain → hoparlör.
export class DubAudio {
  constructor() {
    this.el = null;
    this.gain = null;
    this._resolve = null;
    this.volume = 1;
    this.lastError = null;
  }

  _ensure() {
    if (!this.el) {
      this.el = new Audio();
      this.el.preservesPitch = true;
      this.el.preload = 'auto';
    }
    // Grafiği yalnızca bağlam çalışıyorsa kur (askıdaki bağlam sesi tamamen keserdi).
    const c = audioContext();
    if (!this.gain && c && c.state === 'running') {
      try {
        const src = c.createMediaElementSource(this.el);
        this.gain = c.createGain();
        src.connect(this.gain).connect(c.destination);
      } catch { this.gain = null; }
    }
  }

  get busy() { return !!this._resolve; }
  get paused() { return !!this.el && this.el.paused; }

  _applyVolume() {
    if (!this.el) return;
    if (this.gain) { this.gain.gain.value = clamp(this.volume, 0, 2); this.el.volume = 1; }
    else this.el.volume = clamp(this.volume, 0, 1);
  }

  setVolume(v) { this.volume = v; this._applyVolume(); }

  setRate(r) {
    if (this.el) this.el.playbackRate = clamp(r, 0.25, 4);
  }

  // Bitince (veya durdurulunca) çözülür; hata varsa Error ile çözülür.
  async play(url, { rate = 1, volume = 1 } = {}) {
    this.stop();
    await resumeAudio();
    this._ensure();
    this.volume = volume;
    this._applyVolume();
    const el = this.el;
    el.src = url;
    el.preservesPitch = true;
    el.playbackRate = clamp(rate, 0.25, 4);
    return new Promise((resolve) => {
      this._resolve = resolve;
      el.onended = () => this._finish(null);
      el.onerror = () => this._finish(new Error('Ses çalınamadı'));
      el.play().catch((e) => { this.lastError = e; this._finish(e); });
    });
  }

  _finish(err) {
    const r = this._resolve;
    this._resolve = null;
    if (r) r(err || null);
  }

  stop() {
    if (this.el) {
      this.el.onended = null;
      this.el.onerror = null;
      this.el.pause();
      this.el.removeAttribute('src');
    }
    this._finish(null);
  }

  pause() { if (this._resolve && this.el) this.el.pause(); }

  resume() {
    if (this._resolve && this.el && this.el.paused) {
      resumeAudio().then(() => this.el.play().catch((e) => this._finish(e)));
    }
  }
}

// Sistem sesi (chrome.tts, background üzerinden).
export class SystemVoice {
  constructor(sendBg) {
    this.sendBg = sendBg;
    this._active = 0;
  }
  get busy() { return this._active > 0; }
  async play(text, { rate = 1, volume = 1, voiceName } = {}) {
    this._active++;
    try {
      return await this.sendBg({ type: 'tts.system.speak', text, rate, volume: clamp(volume, 0, 1), voiceName });
    } finally {
      this._active = Math.max(0, this._active - 1);
    }
  }
  stop() { if (this._active) this.sendBg({ type: 'tts.system.stop' }); }
  pause() { if (this._active) this.sendBg({ type: 'tts.system.pause' }); }
  resume() { if (this._active) this.sendBg({ type: 'tts.system.resume' }); }
}

// Orijinal sesi kısar. Tercihen Web Audio Gain (YouTube'un ses ayarına dokunmaz),
// bağlam çalışmıyorsa video.volume ile.
const videoGains = new WeakMap();

export class Ducker {
  constructor(video) {
    this.v = video;
    this.mode = null; // 'gain' | 'volume'
    this.ducked = false;
    this.level = 1;
    this.base = video.volume;
    this.lastSet = null;
    this.releaseTimer = null;
    this._onVol = () => {
      if (this.mode !== 'volume' || !this.ducked) return;
      if (this.lastSet !== null && Math.abs(this.v.volume - this.lastSet) < 0.002) return;
      // Kullanıcı sesi değiştirdi: yeni temel seviye
      this.base = clamp(this.v.volume / Math.max(0.01, this.level), 0, 1);
      this._setVolume(this.base * this.level);
    };
    video.addEventListener('volumechange', this._onVol);
  }

  _gainNode() {
    let g = videoGains.get(this.v);
    if (g) return g;
    // Çapraz kaynaklı (MSE olmayan) medya Web Audio'da sessizleşir; yalnızca blob: kaynakta kullan.
    if (!String(this.v.currentSrc || this.v.src).startsWith('blob:')) return null;
    const c = audioContext();
    if (!c || c.state !== 'running') return null;
    try {
      const src = c.createMediaElementSource(this.v);
      g = c.createGain();
      src.connect(g).connect(c.destination);
      videoGains.set(this.v, g);
      return g;
    } catch {
      return null;
    }
  }

  _setVolume(x) {
    this.lastSet = clamp(x, 0, 1);
    this.v.volume = this.lastSet;
  }

  duck(level) {
    clearTimeout(this.releaseTimer);
    this.level = clamp(level, 0, 1);
    const g = this.mode === 'volume' ? null : this._gainNode();
    if (g) {
      this.mode = 'gain';
      const c = audioContext();
      g.gain.cancelScheduledValues(c.currentTime);
      g.gain.setTargetAtTime(this.level, c.currentTime, 0.06);
    } else {
      if (!this.ducked || this.mode !== 'volume') this.base = this.v.volume;
      this.mode = 'volume';
      this._setVolume(this.base * this.level);
    }
    this.ducked = true;
  }

  // Kısa gecikmeyle geri aç (ardışık cümlelerde pompalamayı önler).
  release(delayMs = 350) {
    clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => this.restore(), delayMs);
  }

  restore() {
    clearTimeout(this.releaseTimer);
    if (!this.ducked) return;
    if (this.mode === 'gain') {
      const g = videoGains.get(this.v);
      const c = audioContext();
      if (g && c) {
        g.gain.cancelScheduledValues(c.currentTime);
        g.gain.setTargetAtTime(1, c.currentTime, 0.12);
      }
    } else if (this.mode === 'volume') {
      this._setVolume(this.base);
    }
    this.ducked = false;
  }

  // Kullanıcının oynatıcıda seçtiği ses seviyesi (0–1); kendi kısmamızdan etkilenmez.
  userVolume() {
    if (this.v.muted) return 0;
    return this.mode === 'volume' && this.ducked ? this.base : this.v.volume;
  }

  setLevel(level) {
    if (this.ducked) this.duck(level);
    else this.level = clamp(level, 0, 1);
  }

  destroy() {
    this.restore();
    this.v.removeEventListener('volumechange', this._onVol);
  }
}
