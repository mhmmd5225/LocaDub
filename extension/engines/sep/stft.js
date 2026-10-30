// Saf JS FFT / STFT / ISTFT (bağımlılıksız; işçide ve Node'da aynı kod).
//
// FFT: karışık tabanlı Stockham (2, 3, 4, 5 kelebekleri; diğer asal çarpanlar genel DFT ile). MDX-Net
// modellerinin n_fft'i 2'nin kuvveti değil (6144 = 2^11·3, 7680 = 2^9·3·5, 5120 = 2^10·5), bu yüzden yalnızca
// radix-2 yetmez; 2'nin kuvvetlerinde radix-4/2 yolu çalışır.
// STFT, torch.stft(center=True, pad_mode='reflect', periyodik Hann, normalize yok) ile aynıdır; ISTFT
// torch.istft gibi pencere karesi toplamına böler. Yerleşim: [bin][kare] (f * frames + t), modelin
// [ch, f, t] düzeniyle aynı. İki gerçek sinyal tek karmaşık FFT'ye paketlenir (x + i·y).

const ffts = new Map();

/** n noktalı karmaşık FFT (önbellekli). */
export function getFFT(n) {
  let f = ffts.get(n);
  if (!f) { f = new FFT(n); ffts.set(n, f); }
  return f;
}

function factorize(n) {
  const out = [];
  while (n % 4 === 0) { out.push(4); n /= 4; }
  while (n % 2 === 0) { out.push(2); n /= 2; }
  for (let p = 3; n > 1; p += 2) while (n % p === 0) { out.push(p); n /= p; }
  return out;
}

export class FFT {
  constructor(n) {
    if (!(n >= 1) || n !== Math.floor(n)) throw new Error(`Geçersiz FFT boyu: ${n}`);
    this.n = n;
    this.factors = factorize(n);
    this.cos = new Float64Array(n);
    this.sin = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      const a = (-2 * Math.PI * j) / n;
      this.cos[j] = Math.cos(a);
      this.sin[j] = Math.sin(a);
    }
    this.tr = new Float64Array(n);
    this.ti = new Float64Array(n);
  }

  /** Yerinde ileri FFT (re, im: Float64Array(n)). inverse=true → ters yön, 1/n ölçeksiz. */
  transform(re, im, inverse = false) {
    const n = this.n;
    if (n === 1) return;
    const C = this.cos, Sn = this.sin;
    const sg = inverse ? -1 : 1; // ters yönde sin işareti çevrilir
    let xr = re, xi = im, yr = this.tr, yi = this.ti;
    let len = n, s = 1;
    for (const p of this.factors) {
      const m = len / p;
      if (p === 2) {
        for (let q = 0; q < m; q++) {
          const wi = q * s, cr = C[wi], ci = sg * Sn[wi];
          for (let k = 0; k < s; k++) {
            const a = k + s * q, b = a + s * m;
            const ar = xr[a], ai = xi[a], br = xr[b], bi = xi[b];
            const o = k + s * 2 * q;
            yr[o] = ar + br; yi[o] = ai + bi;
            const dr = ar - br, di = ai - bi;
            yr[o + s] = dr * cr - di * ci; yi[o + s] = dr * ci + di * cr;
          }
        }
      } else if (p === 4) {
        const sm = s * m;
        for (let q = 0; q < m; q++) {
          const w1 = q * s, w2 = 2 * w1, w3 = 3 * w1;
          const c1 = C[w1], s1 = sg * Sn[w1], c2 = C[w2], s2 = sg * Sn[w2], c3 = C[w3], s3 = sg * Sn[w3];
          for (let k = 0; k < s; k++) {
            const a = k + s * q;
            const r0 = xr[a], i0 = xi[a], r1 = xr[a + sm], i1 = xi[a + sm];
            const r2 = xr[a + 2 * sm], i2 = xi[a + 2 * sm], r3 = xr[a + 3 * sm], i3 = xi[a + 3 * sm];
            const t0r = r0 + r2, t0i = i0 + i2, t1r = r0 - r2, t1i = i0 - i2;
            const t2r = r1 + r3, t2i = i1 + i3;
            // ileri: -i·(x1 - x3); ters: +i·(x1 - x3)
            const t3r = sg * (i1 - i3), t3i = -sg * (r1 - r3);
            const o = k + s * 4 * q;
            yr[o] = t0r + t2r; yi[o] = t0i + t2i;
            let br = t1r + t3r, bi = t1i + t3i;
            yr[o + s] = br * c1 - bi * s1; yi[o + s] = br * s1 + bi * c1;
            br = t0r - t2r; bi = t0i - t2i;
            yr[o + 2 * s] = br * c2 - bi * s2; yi[o + 2 * s] = br * s2 + bi * c2;
            br = t1r - t3r; bi = t1i - t3i;
            yr[o + 3 * s] = br * c3 - bi * s3; yi[o + 3 * s] = br * s3 + bi * c3;
          }
        }
      } else if (p === 3) {
        const sm = s * m;
        const c3 = -0.5, s3 = sg * -Math.sqrt(3) / 2; // e^(∓2πi/3)
        for (let q = 0; q < m; q++) {
          const w1 = q * s, w2 = 2 * w1;
          const c1 = C[w1], s1 = sg * Sn[w1], c2 = C[w2], s2 = sg * Sn[w2];
          for (let k = 0; k < s; k++) {
            const a = k + s * q;
            const r0 = xr[a], i0 = xi[a], r1 = xr[a + sm], i1 = xi[a + sm], r2 = xr[a + 2 * sm], i2 = xi[a + 2 * sm];
            const sr = r1 + r2, si = i1 + i2, dr = r1 - r2, di = i1 - i2;
            const mr = r0 + c3 * sr, mi = i0 + c3 * si;
            const o = k + s * 3 * q;
            yr[o] = r0 + sr; yi[o] = i0 + si;
            // x1·w + x2·w² = c3·(x1+x2) + i·s3·(x1-x2)
            let br = mr - s3 * di, bi = mi + s3 * dr;
            yr[o + s] = br * c1 - bi * s1; yi[o + s] = br * s1 + bi * c1;
            br = mr + s3 * di; bi = mi - s3 * dr;
            yr[o + 2 * s] = br * c2 - bi * s2; yi[o + 2 * s] = br * s2 + bi * c2;
          }
        }
      } else if (p === 5) {
        const sm = s * m;
        const c1 = Math.cos((2 * Math.PI) / 5), c2 = Math.cos((4 * Math.PI) / 5);
        const s1 = Math.sin((2 * Math.PI) / 5), s2 = Math.sin((4 * Math.PI) / 5);
        for (let q = 0; q < m; q++) {
          const w1 = q * s;
          const tc1 = C[w1], ts1 = sg * Sn[w1], tc2 = C[2 * w1], ts2 = sg * Sn[2 * w1];
          const tc3 = C[3 * w1], ts3 = sg * Sn[3 * w1], tc4 = C[4 * w1], ts4 = sg * Sn[4 * w1];
          for (let k = 0; k < s; k++) {
            const a = k + s * q;
            const r0 = xr[a], i0 = xi[a];
            const r1 = xr[a + sm], i1 = xi[a + sm], r2 = xr[a + 2 * sm], i2 = xi[a + 2 * sm];
            const r3 = xr[a + 3 * sm], i3 = xi[a + 3 * sm], r4 = xr[a + 4 * sm], i4 = xi[a + 4 * sm];
            const a1r = r1 + r4, a1i = i1 + i4, b1r = r1 - r4, b1i = i1 - i4;
            const a2r = r2 + r3, a2i = i2 + i3, b2r = r2 - r3, b2i = i2 - i3;
            const m1r = r0 + c1 * a1r + c2 * a2r, m1i = i0 + c1 * a1i + c2 * a2i;
            const m2r = r0 + c2 * a1r + c1 * a2r, m2i = i0 + c2 * a1i + c1 * a2i;
            const tr = sg * (s1 * b1r + s2 * b2r), ti = sg * (s1 * b1i + s2 * b2i);
            const ur = sg * (s2 * b1r - s1 * b2r), ui = sg * (s2 * b1i - s1 * b2i);
            const o = k + s * 5 * q;
            yr[o] = r0 + a1r + a2r; yi[o] = i0 + a1i + a2i;
            let br = m1r + ti, bi = m1i - tr;
            yr[o + s] = br * tc1 - bi * ts1; yi[o + s] = br * ts1 + bi * tc1;
            br = m2r + ui; bi = m2i - ur;
            yr[o + 2 * s] = br * tc2 - bi * ts2; yi[o + 2 * s] = br * ts2 + bi * tc2;
            br = m2r - ui; bi = m2i + ur;
            yr[o + 3 * s] = br * tc3 - bi * ts3; yi[o + 3 * s] = br * ts3 + bi * tc3;
            br = m1r - ti; bi = m1i + tr;
            yr[o + 4 * s] = br * tc4 - bi * ts4; yi[o + 4 * s] = br * ts4 + bi * tc4;
          }
        }
      } else {
        // genel tek asal p (7, 11, …): doğrudan küçük DFT
        const sm = s * m, step = n / p;
        const ar = new Float64Array(p), ai = new Float64Array(p);
        for (let q = 0; q < m; q++) {
          for (let k = 0; k < s; k++) {
            const a = k + s * q;
            for (let r = 0; r < p; r++) { ar[r] = xr[a + r * sm]; ai[r] = xi[a + r * sm]; }
            const o = k + s * p * q;
            for (let u = 0; u < p; u++) {
              let br = 0, bi = 0;
              for (let r = 0; r < p; r++) {
                const wj = ((r * u) % p) * step, wc = C[wj], ws = sg * Sn[wj];
                br += ar[r] * wc - ai[r] * ws; bi += ar[r] * ws + ai[r] * wc;
              }
              const tw = u * q * s, cr = C[tw], ci = sg * Sn[tw];
              yr[o + u * s] = br * cr - bi * ci; yi[o + u * s] = br * ci + bi * cr;
            }
          }
        }
      }
      [xr, yr] = [yr, xr];
      [xi, yi] = [yi, xi];
      len = m;
      s *= p;
    }
    if (xr !== re) { re.set(xr); im.set(xi); }
  }
}

/** Periyodik Hann penceresi (torch.hann_window varsayılanı). */
export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

const windows = new Map();
function hannCached(n) {
  let w = windows.get(n);
  if (!w) { w = hann(n); windows.set(n, w); }
  return w;
}

/** center=True için yansıtmalı dolgu indeksi (numpy/torch 'reflect'). */
function reflect(i, len) {
  if (len === 1) return 0;
  const period = 2 * (len - 1);
  i = ((i % period) + period) % period;
  return i < len ? i : period - i;
}

export const frameCount = (len, hop) => 1 + Math.floor(len / hop);

/**
 * İki gerçek sinyalin STFT'si (b boş olabilir). Dönüş: { frames, bins, a:{re,im}, b?:{re,im} }, her biri
 * Float32Array(bins * frames), yerleşim f * frames + t. maxBins: yalnızca ilk maxBins bin (MDX: dim_f).
 */
export function stftPair(a, b, { nFft, hop, maxBins } = {}) {
  const len = a.length;
  const frames = frameCount(len, hop);
  const bins = Math.min(maxBins || Infinity, nFft / 2 + 1);
  const fft = getFFT(nFft), win = hannCached(nFft);
  const half = nFft / 2;
  const re = new Float64Array(nFft), im = new Float64Array(nFft);
  const A = { re: new Float32Array(bins * frames), im: new Float32Array(bins * frames) };
  const B = b ? { re: new Float32Array(bins * frames), im: new Float32Array(bins * frames) } : null;
  const inner = len > nFft; // dolgu gerekmeyen kareler için hızlı yol
  for (let t = 0; t < frames; t++) {
    const start = t * hop - half;
    const fast = inner && start >= 0 && start + nFft <= len;
    for (let i = 0; i < nFft; i++) {
      const j = fast ? start + i : reflect(start + i, len);
      re[i] = a[j] * win[i];
      im[i] = b ? b[j] * win[i] : 0;
    }
    fft.transform(re, im);
    for (let f = 0; f < bins; f++) {
      const g = f === 0 ? 0 : nFft - f;
      const zr = re[f], zi = im[f], cr = re[g], ci = -im[g]; // Z[f], conj(Z[N-f])
      const o = f * frames + t;
      if (b) {
        A.re[o] = 0.5 * (zr + cr); A.im[o] = 0.5 * (zi + ci);
        // (Z - conj(Z'))/(2i)
        B.re[o] = 0.5 * (zi - ci); B.im[o] = -0.5 * (zr - cr);
      } else {
        A.re[o] = zr; A.im[o] = zi;
      }
    }
  }
  return { frames, bins, a: A, b: B };
}

/** Tek kanal STFT: { frames, bins, re, im }. */
export function stft(x, opts) {
  const r = stftPair(x, null, opts);
  return { frames: r.frames, bins: r.bins, re: r.a.re, im: r.a.im };
}

/**
 * İki spektrumun ISTFT'si (torch.istft, center=True). specA/specB: { re, im } yerleşim f * frames + t,
 * bins ≤ nFft/2+1 (eksik üst binler sıfır). length verilmezse hop * (frames - 1).
 * Dönüş: [Float32Array, Float32Array|null].
 */
export function istftPair(specA, specB, { nFft, hop, frames, bins, length } = {}) {
  const half = nFft / 2;
  const fft = getFFT(nFft), win = hannCached(nFft);
  const nb = Math.min(bins, half + 1);
  const outLen = length ?? hop * (frames - 1);
  const total = nFft + hop * (frames - 1);
  const ya = new Float64Array(total), yb = specB ? new Float64Array(total) : null;
  const norm = new Float64Array(total);
  const re = new Float64Array(nFft), im = new Float64Array(nFft);
  const inv = 1 / nFft;
  for (let t = 0; t < frames; t++) {
    re.fill(0); im.fill(0);
    // Z = A + i·B, Hermitsel simetriyle tam spektrum; DC ve Nyquist'in sanal kısmı yok sayılır (irfft gibi)
    for (let f = 0; f < nb; f++) {
      const o = f * frames + t;
      let ar = specA.re[o], ai = specA.im[o];
      let br = specB ? specB.re[o] : 0, bi = specB ? specB.im[o] : 0;
      if (f === 0 || f === half) { ai = 0; bi = 0; }
      re[f] = ar - bi; im[f] = ai + br;
      if (f > 0 && f < half) {
        const g = nFft - f; // conj(A) + i·conj(B)
        re[g] = ar + bi; im[g] = -ai + br;
      }
    }
    fft.transform(re, im, true);
    const off = t * hop;
    for (let i = 0; i < nFft; i++) {
      const w = win[i];
      ya[off + i] += re[i] * inv * w;
      if (yb) yb[off + i] += im[i] * inv * w;
      norm[off + i] += w * w;
    }
  }
  const outA = new Float32Array(outLen), outB = yb ? new Float32Array(outLen) : null;
  for (let i = 0; i < outLen; i++) {
    const j = i + half;
    if (j >= total) break;
    const nrm = norm[j] > 1e-11 ? 1 / norm[j] : 0;
    outA[i] = ya[j] * nrm;
    if (outB) outB[i] = yb[j] * nrm;
  }
  return [outA, outB];
}

/** Tek kanal ISTFT. */
export function istft(spec, opts) {
  return istftPair(spec, null, { frames: spec.frames, bins: spec.bins, ...opts })[0];
}
