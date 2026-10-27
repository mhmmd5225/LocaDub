// Small audio helpers for the TTS engine (pure JS, no dependencies).
// trimSilence follows Harfiyen's src/worker/tts.worker.ts (MIT, Copyright (c) 2026 Özcan Çelik).

/** Below this, relative to the clip's loudest sample (-50 dB), is silence. */
const SILENCE = 0.003;

/**
 * Cut the silence the model leaves around speech (it would delay every dubbed line), keeping a little margin so
 * the first and last sounds are not clipped; 5 ms fades make sure the cut is inaudible.
 */
export function trimSilence(x, rate, keepBefore = 0.03, keepAfter = 0.06) {
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
  }
  if (!peak) return new Float32Array(0);
  const floor = peak * SILENCE;
  let first = 0;
  while (first < x.length && Math.abs(x[first]) <= floor) first++;
  let last = x.length - 1;
  while (last > first && Math.abs(x[last]) <= floor) last--;
  const from = Math.max(0, first - Math.round(keepBefore * rate));
  const to = Math.min(x.length, last + 1 + Math.round(keepAfter * rate));
  if (from === 0 && to === x.length) return x;
  const y = x.slice(from, to);
  fade(y, rate);
  return y;
}

export function fade(y, rate, seconds = 0.005) {
  const n = Math.min(Math.round(seconds * rate), y.length >> 1);
  for (let i = 0; i < n; i++) {
    const g = i / n;
    y[i] *= g;
    y[y.length - 1 - i] *= g;
  }
  return y;
}

/** Linear-interpolation resampling by `ratio` (> 1 shorter). Used for sample-rate conversion only. */
export function resample(x, ratio) {
  if (Math.abs(ratio - 1) < 1e-9 || x.length < 2) return x;
  const y = new Float32Array(Math.floor((x.length - 1) / ratio) + 1);
  for (let k = 0; k < y.length; k++) {
    const pos = k * ratio;
    const i = Math.floor(pos);
    const b = i + 1 < x.length ? x[i + 1] : x[i];
    y[k] = x[i] + (b - x[i]) * (pos - i);
  }
  return y;
}

/**
 * Perde kaydırma (süre değişmeden): önce metni `speed / k` ile sentezleyin (k kat uzun çıkar), sonra çıktıyı k oranında
 * yeniden örnekleyin: k > 1 → hem kısalır hem perde k kat yükselir, yani süre başlangıç hızındaki süreye döner.
 * (Doğrusal aradeğerleme; ±4 yarım tonda yeterli. Biçimlenti de aynı oranda kayar, bu yüzden küçük tutulur.)
 * Zaman esnetmeden (WSOLA) farklı olarak ek hesap yükü yoktur. k = 2 ** (yarımTon / 12).
 */
export function shiftPitch(x, k) {
  if (!x.length || !(k > 0)) return x;
  return resample(x, k);
}

/**
 * Yumuşak sınırlayıcı: |x| eşiğin altında dokunulmaz, üstü tanh ile tavana (<= ceiling) yaklaşır; hiçbir örnek
 * ceiling'i aşmaz. Taşmaya karşı güvenlik; yerinde değiştirir.
 */
export function softLimit(x, ceiling = 0.98, threshold = 0.89) {
  const room = ceiling - threshold;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > threshold) x[i] = Math.sign(x[i]) * (threshold + room * Math.tanh((a - threshold) / room));
  }
  return x;
}

/** Windowed-sinc low-pass taps (Blackman), cutoff as a fraction of the sample rate. */
function lowpassTaps(cutoff, n) {
  const h = new Float32Array(n);
  const m = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = i - m;
    const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum;
  return h;
}
const TAPS_HALF = lowpassTaps(0.23, 47);

/** Exact 2:1 decimation with an anti-alias FIR (48 kHz -> 24 kHz). */
export function downsample2(x) {
  const h = TAPS_HALF;
  const n = h.length;
  const m = (n - 1) >> 1;
  const y = new Float32Array(Math.floor(x.length / 2));
  for (let k = 0; k < y.length; k++) {
    const c = 2 * k;
    let s = 0;
    for (let j = 0; j < n; j++) {
      const i = c + j - m;
      if (i >= 0 && i < x.length) s += x[i] * h[j];
    }
    y[k] = s;
  }
  return y;
}

/** Convert `x` from rate `from` to rate `to` (2:1 with a proper low-pass, otherwise linear interpolation). */
export function convertRate(x, from, to) {
  if (from === to) return x;
  if (from === 2 * to) return downsample2(x);
  return resample(x, from / to);
}

/**
 * WSOLA time-stretch: plays `x` `factor` times faster (> 1 shorter) at the same pitch. Only used for the part of a
 * requested speed beyond what the models do natively (their duration control is cleaner).
 * Frames of 25 ms, 50% overlap (Hann), +-8 ms similarity search.
 */
export function timeStretch(x, factor, rate) {
  if (Math.abs(factor - 1) < 0.01 || x.length < rate * 0.05) return x;
  const N = Math.round(0.025 * rate) & ~1; // frame
  const Hs = N >> 1; // synthesis hop
  const Ha = Hs * factor; // analysis hop
  const tol = Math.round(0.008 * rate);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const outLen = Math.ceil(x.length / factor) + N;
  const y = new Float32Array(outLen);
  const norm = new Float32Array(outLen);
  let prev = 0; // analysis position of the previous frame (after its delta)
  let k = 0;
  for (; ; k++) {
    const target = Math.round(k * Ha);
    if (target + N >= x.length) break;
    let best = target;
    if (k > 0) {
      // natural continuation of the previous frame, compared against candidates around the target
      const nat = prev + Hs;
      let bestScore = -Infinity;
      const lo = Math.max(0, target - tol);
      const hi = Math.min(x.length - N - 1, target + tol);
      for (let c = lo; c <= hi; c += 2) {
        let s = 0;
        for (let i = 0; i < Hs; i += 2) s += x[c + i] * (nat + i < x.length ? x[nat + i] : 0);
        if (s > bestScore) {
          bestScore = s;
          best = c;
        }
      }
    }
    const o = k * Hs;
    for (let i = 0; i < N && o + i < outLen; i++) {
      y[o + i] += x[best + i] * win[i];
      norm[o + i] += win[i];
    }
    prev = best;
  }
  const len = Math.min(outLen, k * Hs + N);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = norm[i] > 1e-3 ? y[i] / norm[i] : y[i];
  return fade(out, rate);
}

export function concat(parts) {
  const all = new Float32Array(parts.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of parts) {
    all.set(c, o);
    o += c.length;
  }
  return all;
}

/** Mono float PCM -> 16-bit PCM WAV bytes. */
export function encodeWav(pcm, rate) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Uint8Array(buf);
}
