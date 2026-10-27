// Oynatıcı katmanı: yerel <video> ve YouTube IFrame oynatıcısı için tek arayüz.
//   media.currentTime, .paused, .seeking, .playbackRate
//   media.on(ev, fn)   ev: play | pause | seeking | seeked | volumechange | ratechange | ended
//   media.ducker       duck(level) / release(ms) / restore() / userVolume() / setLevel() / destroy()
// Ayrıca: WebSystemVoice (speechSynthesis), YouTube bağlantısından video kimliği.

import { Ducker } from './ext/content/player.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

class Emitter {
  constructor() { this._l = new Map(); }
  on(ev, fn) {
    if (!this._l.has(ev)) this._l.set(ev, new Set());
    this._l.get(ev).add(fn);
    return () => this._l.get(ev)?.delete(fn);
  }
  emit(ev, ...a) { for (const fn of this._l.get(ev) || []) { try { fn(...a); } catch (e) { console.error(e); } } }
}

// ---------- Yerel video dosyası ----------

export class FileMedia extends Emitter {
  constructor(container, file) {
    super();
    this.kind = 'file';
    this.url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.className = 'media-video';
    v.controls = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = this.url;
    container.replaceChildren(v);
    this.video = v;
    // blob: kaynak → Web Audio kazancıyla kısma (oynatıcının ses ayarına dokunmaz).
    this.ducker = new Ducker(v);
    this._off = [];
    for (const ev of ['play', 'pause', 'seeking', 'seeked', 'volumechange', 'ratechange', 'ended']) {
      const fn = () => this.emit(ev);
      v.addEventListener(ev, fn);
      this._off.push(() => v.removeEventListener(ev, fn));
    }
  }
  ready() {
    if (this.video.readyState >= 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      this.video.addEventListener('error', () => reject(new Error('Video dosyası açılamadı (tarayıcı bu biçimi desteklemiyor olabilir).')), { once: true });
    });
  }
  get currentTime() { return this.video.currentTime; }
  get paused() { return this.video.paused; }
  get seeking() { return this.video.seeking; }
  get playbackRate() { return this.video.playbackRate || 1; }
  get duration() { return this.video.duration || 0; }
  play() { return this.video.play().catch(() => {}); }
  destroy() {
    this._off.forEach((f) => f());
    this.ducker.destroy();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    URL.revokeObjectURL(this.url);
  }
}

// ---------- YouTube ----------

export function parseYouTubeId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.searchParams.get('v');
    if (!id) {
      const m = /^\/(?:embed|shorts|live|v)\/([\w-]{11})/.exec(u.pathname);
      id = m?.[1] || null;
    }
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

let apiP = null;
function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!apiP) {
    apiP = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { apiP = null; reject(new Error('YouTube oynatıcısı yüklenemedi (ağ bağlantısını ya da reklam engelleyiciyi kontrol edin).')); };
      document.head.append(s);
    });
  }
  return apiP;
}

const YT_ERRORS = {
  2: 'Geçersiz video kimliği.',
  5: 'Bu video HTML5 oynatıcıda açılamıyor.',
  100: 'Video bulunamadı ya da gizli.',
  101: 'YouTube bu videonun başka sitelerde oynatılmasına izin vermedi (video sahibi gömmeyi kapatmış olabilir).',
  150: 'YouTube bu videonun başka sitelerde oynatılmasına izin vermedi (video sahibi gömmeyi kapatmış olabilir).',
};

// YouTube'un ses düzeyini (0–100) kısarak orijinal sesi azaltır. Kullanıcı düzeyi değiştirirse yeni temel alınır.
class YouTubeDucker {
  constructor(media) {
    this.m = media;
    this.ducked = false;
    this.level = 1;
    this.base = null;
    this.lastSet = null;
    this.releaseTimer = null;
  }
  _vol() { try { return this.m.player.getVolume() / 100; } catch { return 1; } }
  _set(x) {
    this.lastSet = Math.round(clamp(x, 0, 1) * 100);
    try { this.m.player.setVolume(this.lastSet); } catch { /* yoksay */ }
  }
  // Oynatıcı yoklamasında çağrılır: kısılıyken kullanıcı ses düzeyini değiştirdiyse temeli güncelle.
  poll() {
    if (!this.ducked || this.lastSet == null) return;
    const now = Math.round(this._vol() * 100);
    if (Math.abs(now - this.lastSet) <= 1) return;
    this.base = clamp(now / 100 / Math.max(0.01, this.level), 0, 1);
    this._set(this.base * this.level);
  }
  duck(level) {
    clearTimeout(this.releaseTimer);
    this.level = clamp(level, 0, 1);
    if (!this.ducked) this.base = this._vol();
    this._set(this.base * this.level);
    this.ducked = true;
  }
  release(delayMs = 350) {
    clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => this.restore(), delayMs);
  }
  restore() {
    clearTimeout(this.releaseTimer);
    if (!this.ducked) return;
    this._set(this.base);
    this.ducked = false;
  }
  userVolume() {
    try { if (this.m.player.isMuted()) return 0; } catch { /* yoksay */ }
    return this.ducked ? this.base : this._vol();
  }
  setLevel(level) {
    if (this.ducked) this.duck(level);
    else this.level = clamp(level, 0, 1);
  }
  destroy() { this.restore(); }
}

export class YouTubeMedia extends Emitter {
  constructor(container, videoId) {
    super();
    this.kind = 'youtube';
    this.videoId = videoId;
    this.container = container;
    this.player = null;
    this.ducker = new YouTubeDucker(this);
    this._state = -1;
    this._t = 0;
    this._at = 0;
    this._rate = 1;
    this._vol = null;
  }

  async ready() {
    const YT = await loadYouTubeApi();
    const host = document.createElement('div');
    this.container.replaceChildren(host);
    await new Promise((resolve, reject) => {
      this.player = new YT.Player(host, {
        videoId: this.videoId,
        host: 'https://www.youtube-nocookie.com',
        playerVars: { playsinline: 1, rel: 0, fs: 0, cc_load_policy: 0, iv_load_policy: 3, origin: location.origin },
        events: {
          onReady: () => resolve(),
          onError: (e) => {
            const msg = YT_ERRORS[e.data] || `YouTube oynatıcı hatası (${e.data}).`;
            reject(new Error(msg));
            this.emit('error', new Error(msg));
          },
          onStateChange: (e) => this._onState(e.data),
          onPlaybackRateChange: () => { this._rate = this.player.getPlaybackRate() || 1; this.emit('ratechange'); },
        },
      });
    });
    this._rate = this.player.getPlaybackRate() || 1;
    this._t = this.player.getCurrentTime() || 0;
    this._at = performance.now();
    this._poll = setInterval(() => this._tick(), 100);
  }

  _onState(s) {
    const prev = this._state;
    this._state = s;
    if (s === 1 && prev !== 1) this.emit('play');
    else if (s !== 1 && prev === 1) this.emit('pause');
    if (s === 0) this.emit('ended');
  }

  // IFrame API olay vermediği için ileri/geri sarma ve ses değişimi zaman/ses yoklamasıyla bulunur.
  _tick() {
    if (!this.player?.getCurrentTime) return;
    const now = performance.now();
    const t = this.player.getCurrentTime() || 0;
    const expected = this._t + (this._state === 1 ? ((now - this._at) / 1000) * this._rate : 0);
    if (Math.abs(t - expected) > 1.2) { this.emit('seeking'); this.emit('seeked'); }
    this._t = t;
    this._at = now;
    let vol;
    try { vol = this.player.isMuted() ? -1 : this.player.getVolume(); } catch { vol = null; }
    this.ducker.poll();
    if (vol !== this._vol) { this._vol = vol; this.emit('volumechange'); }
  }

  get currentTime() {
    try { return this.player.getCurrentTime() || 0; } catch { return 0; }
  }
  get paused() { return this._state !== 1; }
  get seeking() { return this._state === 3; }
  get playbackRate() { return this._rate || 1; }
  get duration() { try { return this.player.getDuration() || 0; } catch { return 0; } }
  play() { try { this.player.playVideo(); } catch { /* yoksay */ } }
  destroy() {
    clearInterval(this._poll);
    this.ducker.destroy();
    try { this.player?.destroy(); } catch { /* yoksay */ }
    this.container.replaceChildren();
  }
}

// ---------- Sistem sesi (speechSynthesis) ----------

export function systemVoices() {
  if (!('speechSynthesis' in window)) return [];
  return speechSynthesis.getVoices().filter((v) => /^tr\b/i.test(v.lang));
}

export class WebSystemVoice {
  constructor() { this._active = 0; }
  get available() { return 'speechSynthesis' in window; }
  get busy() { return this._active > 0; }
  play(text, { rate = 1, volume = 1, voiceName } = {}) {
    if (!this.available) return Promise.resolve({ ok: false, error: 'Bu tarayıcıda sistem sesi yok.' });
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(String(text || ''));
      u.lang = 'tr-TR';
      u.rate = clamp(rate, 0.1, 10);
      u.volume = clamp(volume, 0, 1);
      const voice = systemVoices().find((v) => v.name === voiceName) || systemVoices()[0];
      if (voice) u.voice = voice;
      this._active++;
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        this._active = Math.max(0, this._active - 1);
        resolve(r);
      };
      u.onend = () => finish({ ok: true });
      u.onerror = (e) => finish(e.error === 'interrupted' || e.error === 'canceled'
        ? { ok: true } : { ok: false, error: 'Sistem sesi hatası: ' + (e.error || 'bilinmiyor') });
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      setTimeout(() => finish({ ok: true }), 60000);
    });
  }
  stop() { if (this._active && this.available) speechSynthesis.cancel(); }
  pause() { if (this._active && this.available) speechSynthesis.pause(); }
  resume() { if (this._active && this.available) speechSynthesis.resume(); }
}
