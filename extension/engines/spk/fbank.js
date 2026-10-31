// Kaldi uyumlu log-mel filtre bankası (fbank): konuşmacı gömme modellerinin girdisi. Saf modül (DOM yok); işçide ve
// Node testlerinde aynı kod. Kaldi/kaldi-native-fbank varsayılanları: 25 ms pencere, 10 ms kayma, snip_edges,
// DC çıkarma, ön vurgu 0.97, povey penceresi, 512 noktalı FFT, güç spektrumu, 20 Hz – Nyquist arası 80 üçgen mel
// süzgeci, log (taban FLT_EPSILON), dither yok. Doğrulama: tests/extension/spk.test.mjs (kaldi-native-fbank
// değerleriyle).

const FLT_EPSILON = 1.1920929e-7;
const mel = (f) => 1127 * Math.log(1 + f / 700);

const cache = new Map();

function setup(rate, bins, frameLen, window) {
  const key = `${rate}|${bins}|${frameLen}|${window}`;
  if (cache.has(key)) return cache.get(key);
  let nfft = 1;
  while (nfft < frameLen) nfft <<= 1;
  const win = new Float32Array(frameLen);
  for (let i = 0; i < frameLen; i++) {
    const a = (2 * Math.PI * i) / (frameLen - 1);
    win[i] = window === 'hamming' ? 0.54 - 0.46 * Math.cos(a) : (0.5 - 0.5 * Math.cos(a)) ** 0.85;
  }
  // mel süzgeçleri: [ilk bin, ağırlıklar] (Nyquist bini dahil değil, Kaldi'deki gibi)
  const half = nfft >> 1;
  const lo = mel(20);
  const hi = mel(rate / 2);
  const delta = (hi - lo) / (bins + 1);
  const filters = [];
  for (let b = 0; b < bins; b++) {
    const l = lo + b * delta;
    const c = l + delta;
    const r = c + delta;
    let first = -1;
    const w = [];
    for (let i = 0; i < half; i++) {
      const m = mel((rate / nfft) * i);
      if (m > l && m < r) {
        if (first < 0) first = i;
        w.push(m <= c ? (m - l) / (c - l) : (r - m) / (r - c));
      } else if (first >= 0) break;
    }
    filters.push([Math.max(0, first), Float32Array.from(w)]);
  }
  // FFT tabloları
  const cos = new Float32Array(half);
  const sin = new Float32Array(half);
  for (let i = 0; i < half; i++) { cos[i] = Math.cos((2 * Math.PI * i) / nfft); sin[i] = -Math.sin((2 * Math.PI * i) / nfft); }
  const rev = new Uint32Array(nfft);
  const bits = Math.log2(nfft);
  for (let i = 0; i < nfft; i++) {
    let r = 0;
    for (let k = 0; k < bits; k++) r |= ((i >> k) & 1) << (bits - 1 - k);
    rev[i] = r;
  }
  const s = { nfft, win, filters, cos, sin, rev };
  cache.set(key, s);
  return s;
}

// Yerinde radix-2 FFT (re, im uzunluğu nfft).
function fft(re, im, s) {
  const n = s.nfft;
  for (let i = 0; i < n; i++) {
    const j = s.rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const h = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < h; k++) {
        const wr = s.cos[k * step];
        const wi = s.sin[k * step];
        const a = i + k;
        const b = a + h;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

/** snip_edges ile çerçeve sayısı. */
export const numFrames = (n, rate = 16000) => {
  const len = Math.round(rate * 0.025);
  const shift = Math.round(rate * 0.01);
  return n < len ? 0 : 1 + Math.floor((n - len) / shift);
};

/**
 * PCM (mono, `rate` Hz, [-1, 1]) → { data: Float32Array(frames·bins), frames, bins }.
 * opts.window: 'povey' (Kaldi, 3D-Speaker) | 'hamming' (WeSpeaker); opts.scale: örnek çarpanı (Kaldi int16 için 32768).
 */
export function fbank(pcm, { rate = 16000, bins = 80, window = 'povey', scale = 1 } = {}) {
  const len = Math.round(rate * 0.025);
  const shift = Math.round(rate * 0.01);
  const frames = numFrames(pcm.length, rate);
  const s = setup(rate, bins, len, window);
  const out = new Float32Array(frames * bins);
  const re = new Float32Array(s.nfft);
  const im = new Float32Array(s.nfft);
  const pow = new Float32Array(s.nfft >> 1);
  for (let f = 0; f < frames; f++) {
    const o = f * shift;
    let mean = 0;
    for (let i = 0; i < len; i++) mean += pcm[o + i] * scale;
    mean /= len;
    for (let i = 0; i < len; i++) re[i] = pcm[o + i] * scale - mean;
    for (let i = len - 1; i > 0; i--) re[i] -= 0.97 * re[i - 1];
    re[0] -= 0.97 * re[0];
    for (let i = 0; i < len; i++) re[i] *= s.win[i];
    re.fill(0, len);
    im.fill(0);
    fft(re, im, s);
    for (let i = 0; i < pow.length; i++) pow[i] = re[i] * re[i] + im[i] * im[i];
    for (let b = 0; b < bins; b++) {
      const [first, w] = s.filters[b];
      let e = 0;
      for (let k = 0; k < w.length; k++) e += w[k] * pow[first + k];
      out[f * bins + b] = Math.log(Math.max(e, FLT_EPSILON));
    }
  }
  return { data: out, frames, bins };
}

/** Zaman boyunca ortalamayı çıkar (CMN; modeller böyle eğitildi), yerinde. */
export function subtractMean({ data, frames, bins }) {
  if (!frames) return;
  for (let b = 0; b < bins; b++) {
    let m = 0;
    for (let f = 0; f < frames; f++) m += data[f * bins + b];
    m /= frames;
    for (let f = 0; f < frames; f++) data[f * bins + b] -= m;
  }
}
