// Orijinal sesin kaydı (16 kHz mono): ayırma yokken konuşmacı tanıma (engines/spk) cümlenin sesini buradan alır.
// player.js videoGraph kaynağına paralel bağlanır (kısma ve susturmadan önce); video oynarken her blok video
// zamanıyla saklanır, son KEEP_SEC tutulur. range(t0, t1) o aralığın sesini verir (eksikse null).

import { audioContext, videoGraph } from './player.js';
import { logError } from '../common/errlog.js';

const OUT_RATE = 16000;
const KEEP_SEC = 60;
const BLOCK = 4096;
const TAPS = 31;

// Kesim frekansı fc (çıkış hızına göre normalize) için pencereli sinc alçak geçiren süzgeç.
function lowpass(fc) {
  const h = new Float32Array(TAPS);
  const m = (TAPS - 1) / 2;
  let s = 0;
  for (let i = 0; i < TAPS; i++) {
    const x = i - m;
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (TAPS - 1));
    h[i] = (x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)) * w;
    s += h[i];
  }
  for (let i = 0; i < TAPS; i++) h[i] /= s;
  return h;
}

/** Akan sesi `rate`'ten 16 kHz'e indiren durumlu dönüştürücü (alçak geçiren + doğrusal ara değer). */
export function makeDownsampler(rate) {
  const ratio = rate / OUT_RATE;
  const h = lowpass(0.45 / ratio);
  const hist = new Float32Array(TAPS - 1);
  let pos = 0; // sonraki çıkış örneğinin, süzülmüş akıştaki konumu (bu bloğun başına göre)
  let prev = 0; // önceki bloğun son süzülmüş örneği
  return (x) => {
    const buf = new Float32Array(hist.length + x.length);
    buf.set(hist);
    buf.set(x, hist.length);
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      let s = 0;
      for (let k = 0; k < TAPS; k++) s += h[k] * buf[i + k];
      y[i] = s;
    }
    hist.set(buf.subarray(buf.length - hist.length));
    const out = [];
    while (pos < x.length - 1) {
      const i = Math.floor(pos);
      const f = pos - i;
      const a = i < 0 ? prev : y[i];
      out.push(a + (y[i + 1] - a) * f);
      pos += ratio;
    }
    pos -= x.length;
    prev = y[x.length - 1];
    return Float32Array.from(out);
  };
}

export class OriginalCapture {
  constructor(video) {
    this.v = video;
    this.blocks = []; // { t: video zamanı (blok başı), pcm: Float32Array 16 kHz }
    this.node = null;
  }

  /** Grafiği kur (bağlam çalışıyorsa); kurulamazsa false. */
  start() {
    if (this.node) return true;
    const g = videoGraph(this.v);
    const c = audioContext();
    if (!g || !c) return false;
    try {
      this.node = c.createScriptProcessor(BLOCK, 2, 1);
      this.sink = c.createGain();
      this.sink.gain.value = 0;
      this.down = makeDownsampler(c.sampleRate);
      this.node.onaudioprocess = (ev) => this._block(ev);
      g.source.connect(this.node);
      this.node.connect(this.sink).connect(c.destination);
      return true;
    } catch (e) {
      logError('ses yakalama', e);
      this.node = null;
      return false;
    }
  }

  _block(ev) {
    const v = this.v;
    if (v.paused || v.seeking) { this.down = makeDownsampler(ev.inputBuffer.sampleRate); return; }
    const ib = ev.inputBuffer;
    const L = ib.getChannelData(0);
    const R = ib.numberOfChannels > 1 ? ib.getChannelData(1) : L;
    const x = new Float32Array(L.length);
    for (let i = 0; i < x.length; i++) x[i] = 0.5 * (L[i] + R[i]);
    const pcm = this.down(x);
    // blok, işlendiği anda çalınmış sayılır: başı = şimdiki zaman − blok süresi
    const t = v.currentTime - L.length / ib.sampleRate;
    const last = this.blocks.at(-1);
    if (last && Math.abs(last.t + last.pcm.length / OUT_RATE - t) > 0.5) this.blocks = []; // atlama (sarma)
    this.blocks.push({ t, pcm });
    while (this.blocks.length && this.blocks[0].t < t - KEEP_SEC) this.blocks.shift();
  }

  /** [t0, t1] aralığının 16 kHz sesi; kayıt aralığın en az %80'ini kapsamıyorsa null. */
  range(t0, t1) {
    const n = Math.round((t1 - t0) * OUT_RATE);
    if (n <= 0) return null;
    const out = new Float32Array(n);
    let got = 0;
    for (const b of this.blocks) {
      const a = Math.round((b.t - t0) * OUT_RATE);
      if (a >= n || a + b.pcm.length <= 0) continue;
      const s = Math.max(0, -a);
      const e = Math.min(b.pcm.length, n - a);
      out.set(b.pcm.subarray(s, e), a + s);
      got += e - s;
    }
    return got >= n * 0.8 ? out : null;
  }

  clear() { this.blocks = []; }

  destroy() {
    try { this.node?.disconnect(); this.sink?.disconnect(); } catch { /* yoksay */ }
    if (this.node) this.node.onaudioprocess = null;
    this.node = null;
    this.blocks = [];
  }
}

/** Ayırmanın verdiği temiz konuşmayı ({ left, right, sampleRate }) 16 kHz monoya çevir. */
export function toMono16k(sp) {
  if (!sp?.left?.length || !sp.sampleRate) return null;
  const L = sp.left;
  const R = sp.right?.length === L.length ? sp.right : L;
  const x = new Float32Array(L.length);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * (L[i] + R[i]);
  return sp.sampleRate === OUT_RATE ? x : makeDownsampler(sp.sampleRate)(x);
}
