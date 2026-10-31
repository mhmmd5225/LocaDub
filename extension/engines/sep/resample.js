// Çok fazlı (polyphase) pencereli-sinc örnekleme hızı dönüştürücü: 48 kHz ↔ 44.1 kHz gibi rasyonel oranlar.
// Kaiser penceresi (β 8, ~-80 dB), geçiş bandı Nyquist'in %95'i; uçlar sıfırla dolgulanır (bağlam çağıran
// tarafın işi: separator.js'deki contextSec). Saf JS, bağımlılıksız.

const ZERO_CROSSINGS = 24;
const BETA = 8;
const ROLLOFF = 0.95;
const MAX_TABLE_PHASES = 4096;

const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };

function besselI0(x) {
  let sum = 1, term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-16) break;
  }
  return sum;
}

const tables = new Map();

function design(L, M) {
  const key = L + '/' + M;
  let t = tables.get(key);
  if (t) return t;
  const fc = ROLLOFF * Math.min(1, L / M); // giriş örnek hızına göre kesim (1 = giriş Nyquist'i)
  const half = Math.ceil(ZERO_CROSSINGS / fc); // girişte yarım genişlik (örnek)
  const taps = 2 * half;
  const i0b = besselI0(BETA);
  const kernel = (tau) => {
    const r = tau / half;
    if (r <= -1 || r >= 1) return 0;
    const x = Math.PI * fc * tau;
    const sinc = x === 0 ? 1 : Math.sin(x) / x;
    return fc * sinc * besselI0(BETA * Math.sqrt(1 - r * r)) / i0b;
  };
  const phases = L <= MAX_TABLE_PHASES ? L : 0;
  let coef = null;
  if (phases) {
    coef = new Float32Array(phases * taps);
    for (let p = 0; p < phases; p++) {
      const frac = p / L;
      let sum = 0;
      for (let k = 0; k < taps; k++) sum += kernel(k - half + 1 - frac);
      // DC kazancını tam 1 yap (fazlar arasında küçük genlik dalgalanmasını önler)
      for (let k = 0; k < taps; k++) coef[p * taps + k] = kernel(k - half + 1 - frac) / sum;
    }
  }
  t = { half, taps, coef, kernel };
  tables.set(key, t);
  return t;
}

/**
 * x'i from Hz'den to Hz'e dönüştürür. length: çıktı uzunluğu (varsayılan round(x.length * to / from)).
 * Aynı hızda kopya döner.
 */
export function resample(x, from, to, length) {
  from = Math.round(from); to = Math.round(to);
  const outLen = length ?? Math.round((x.length * to) / from);
  if (from === to) {
    const y = new Float32Array(outLen);
    y.set(x.length > outLen ? x.subarray(0, outLen) : x);
    return y;
  }
  const g = gcd(from, to);
  const L = to / g, M = from / g;
  const { half, taps, coef, kernel } = design(L, M);
  const y = new Float32Array(outLen);
  const n = x.length;
  for (let o = 0; o < outLen; o++) {
    const num = o * M;
    const base = Math.floor(num / L);
    const phase = num - base * L;
    const start = base - half + 1;
    let acc = 0;
    if (coef) {
      const c0 = phase * taps;
      if (start >= 0 && start + taps <= n) {
        for (let k = 0; k < taps; k++) acc += x[start + k] * coef[c0 + k];
      } else {
        for (let k = 0; k < taps; k++) {
          const j = start + k;
          if (j >= 0 && j < n) acc += x[j] * coef[c0 + k];
        }
      }
    } else {
      const frac = phase / L;
      for (let k = 0; k < taps; k++) {
        const j = start + k;
        if (j >= 0 && j < n) acc += x[j] * kernel(k - half + 1 - frac);
      }
    }
    y[o] = acc;
  }
  return y;
}
