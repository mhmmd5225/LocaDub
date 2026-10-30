// Gerçek dublaj (ses ayırma) için saf yardımcılar; DOM'a dokunmaz, node testleriyle sınanır.
// - PacketStore: kodlanmış ses paketleri (opus / AAC), medya zamanına göre (MSE eklemelerinden, content/sep-demux.js)
// - PcmTimeline: ayrılmış PCM önbelleği (örnek dizini → Float32 L/R), birleşme ve çakışmada çapraz geçiş
// - planNext: sıradaki ayırma parçası (oynatma konumundan ileri, en yakın önce)
// - HoldGate: başta ön tampon, oynatırken "< 2 sn kaldıysa duraklat, ≥ 8 sn olunca sür" (histerezis)
// Zamanlar saniye (medya zamanı), PCM konumları örnek dizini.

export const SEP = Object.freeze({
  chunkSec: 12,   // parça boyu
  minSec: 2,      // girdi az gelirse (acil) en kısa parça
  ctxSec: 1,      // her iki yandaki bağlam (sonuçtan kırpılır); işçi 'loaded' içinde contextSec bildirirse o
  xfSec: 0.05,    // parça eklerinde çapraz geçiş (sondaki bağlamdan)
  low: 2,         // oynatırken bundan az ayrılmış ses kaldıysa video bekletilir
  high: 8,        // bekleyen video bu kadar hazır olunca sürer
  eps: 0.02,
  keepBehindSec: 15,     // oynatma konumunun gerisinde tutulan ayrılmış ses
  packetsBehindSec: 300, // gerisinde tutulan kodlanmış ses (geri sarınca yeniden ayırmak için)
  driftSec: 0.04,        // |kayma| bunu aşarsa yeniden eşitle
});

/** İleriye işlenecek pencere: ön tampon (ya da sürme eşiği) + bir parça. */
export const windowFor = (prebufferSec) => Math.max(prebufferSec, SEP.high) + SEP.chunkSec;

// ---- kodlanmış paketler ----

/** Kodlanmış paketler { t, dur, data, cfg } — t'ye göre sıralı; aynı zamana yeniden eklenen (kalite değişimi, tekrar) eskisinin yerine geçer. */
export class PacketStore {
  constructor({ tol = 0.005 } = {}) {
    this.tol = tol;
    this.list = [];
    this._ranges = null;
  }

  get size() { return this.list.length; }

  _lower(t) { // t'den küçük olmayan ilk paket
    let lo = 0, hi = this.list.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.list[m].t < t) lo = m + 1; else hi = m; }
    return lo;
  }

  add(p) {
    if (!(p.dur > 0) || !Number.isFinite(p.t)) return;
    const L = this.list;
    const tol = this.tol;
    // yenisinin örttüğü eski paketler atılır (yeni kazanır)
    let i = this._lower(p.t - tol);
    let j = i;
    while (j < L.length && L[j].t < p.t + p.dur - tol) j++;
    if (i === L.length && (!L.length || L[L.length - 1].t < p.t)) L.push(p); // olağan: sona ekleme
    else L.splice(i, j - i, p);
    this._ranges = null;
  }

  /** Kesintisiz aralıklar [[s, e]] (tol içindeki boşluklar yok sayılır). */
  ranges() {
    if (this._ranges) return this._ranges;
    const out = [];
    for (const p of this.list) {
      const last = out[out.length - 1];
      if (last && p.t <= last[1] + this.tol) last[1] = Math.max(last[1], p.t + p.dur);
      else out.push([p.t, p.t + p.dur]);
    }
    return (this._ranges = out);
  }

  /** t'yi içeren aralık (ya da null). */
  rangeAt(t) {
    return rangeAt(this.ranges(), t, this.tol);
  }

  /** [a, b) ile kesişen paketler. */
  packetsIn(a, b) {
    const out = [];
    for (let i = Math.max(0, this._lower(a) - 8); i < this.list.length && this.list[i].t < b; i++) {
      const p = this.list[i];
      if (p.t + p.dur > a) out.push(p);
    }
    return out;
  }

  prune(before) {
    const i = this._lower(before);
    if (i > 0) { this.list.splice(0, i); this._ranges = null; }
  }

  clear() { this.list = []; this._ranges = null; }
}

/** Sıralı aralıklarda t'yi içeren [s, e] (s − tol ≤ t < e). */
export function rangeAt(ranges, t, tol = SEP.eps) {
  for (const r of ranges) {
    if (r[0] - tol <= t && t < r[1]) return r;
    if (r[0] - tol > t) break;
  }
  return null;
}

// ---- ayrılmış PCM ----

export class PcmTimeline {
  /** runs: { s, L, R } — s örnek dizini; birbirine değen (tol örnek) parçalar birleşir. */
  constructor(sampleRate, { tol = 2 } = {}) {
    this.sr = sampleRate;
    this.tol = tol;
    this.runs = [];
  }

  get bytes() { return this.runs.reduce((n, r) => n + r.L.byteLength * 2, 0); }

  ranges() { return this.runs.map((r) => [r.s, r.s + r.L.length]); }

  rangesSec() { return this.runs.map((r) => [r.s / this.sr, (r.s + r.L.length) / this.sr]); }

  /** i örneğini içeren parçanın sonu (ya da −1). */
  contiguousEnd(i) {
    for (const r of this.runs) if (r.s - this.tol <= i && i < r.s + r.L.length) return r.s + r.L.length;
    return -1;
  }

  /**
   * [s, s + L.length) yazar. Var olan veri çakışmada kazanır; ancak var olan parçanın yeni verinin içinde başladığı
   * ya da bittiği kenarda `xf` örneklik doğrusal çapraz geçiş yapılır (önceki parçanın sondaki bağlamı → yeni parça;
   * boşluk doldururken yeni parça → sonraki parça). Değen parçalar tek parçada birleşir.
   */
  write(s, L, R = L, { xf = 0 } = {}) {
    const n = L.length;
    if (!n) return;
    const e = s + n;
    const tol = this.tol;
    const hit = [], keep = [];
    for (const r of this.runs) (r.s <= e + tol && r.s + r.L.length >= s - tol ? hit : keep).push(r);
    let lo = s, hi = e;
    for (const r of hit) { lo = Math.min(lo, r.s); hi = Math.max(hi, r.s + r.L.length); }
    const oL = new Float32Array(hi - lo), oR = new Float32Array(hi - lo);
    oL.set(L, s - lo); oR.set(R, s - lo);
    for (const r of hit) {
      const rs = r.s, re = r.s + r.L.length;
      const os = Math.max(rs, s), oe = Math.min(re, e);
      // örtüşme dışı: olduğu gibi
      if (rs < s) { oL.set(r.L.subarray(0, Math.min(re, s) - rs), rs - lo); oR.set(r.R.subarray(0, Math.min(re, s) - rs), rs - lo); }
      if (re > e) { const k = Math.max(e, rs) - rs; oL.set(r.L.subarray(k), rs + k - lo); oR.set(r.R.subarray(k), rs + k - lo); }
      if (oe <= os) continue;
      const len = oe - os;
      const leftEdge = rs > s, rightEdge = re < e;
      const x = Math.min(xf, leftEdge && rightEdge ? len >> 1 : len);
      for (let i = os; i < oe; i++) {
        let w = 1; // var olan verinin ağırlığı
        if (x > 0 && leftEdge && i < os + x) w = (i - os + 0.5) / x;
        if (x > 0 && rightEdge && i >= oe - x) w = Math.min(w, (oe - i - 0.5) / x);
        const k = i - lo, ri = i - rs, ni = i - s;
        oL[k] = r.L[ri] * w + L[ni] * (1 - w);
        oR[k] = r.R[ri] * w + R[ni] * (1 - w);
      }
    }
    keep.push({ s: lo, L: oL, R: oR });
    keep.sort((a, b) => a.s - b.s);
    this.runs = keep;
  }

  /** [s, e) aralığı; veri olmayan yerler sıfır. */
  read(s, e) {
    const n = Math.max(0, e - s);
    const L = new Float32Array(n), R = new Float32Array(n);
    for (const r of this.runs) {
      const rs = r.s, re = r.s + r.L.length;
      const a = Math.max(s, rs), b = Math.min(e, re);
      if (b <= a) continue;
      L.set(r.L.subarray(a - rs, b - rs), a - s);
      R.set(r.R.subarray(a - rs, b - rs), a - s);
    }
    return { L, R };
  }

  /** [lo, hi) dışını at (örnek dizini). */
  prune(lo, hi = Infinity) {
    const out = [];
    for (const r of this.runs) {
      const rs = r.s, re = r.s + r.L.length;
      if (re <= lo || rs >= hi) continue;
      if (rs >= lo && re <= hi) { out.push(r); continue; }
      const a = Math.max(lo, rs), b = Math.min(hi, re);
      out.push({ s: a, L: r.L.slice(a - rs, b - rs), R: r.R.slice(a - rs, b - rs) });
    }
    this.runs = out;
  }

  clear() { this.runs = []; }
}

/**
 * Ayrılmış ses t'den itibaren kesintisiz kaç sn hazır. Video sonu değilse son xf (sondaki bağlam, bir sonraki parçayla
 * çapraz geçecek) sayılmaz.
 */
export function aheadOf(sepRanges, t, { duration = Infinity, xfSec = SEP.xfSec } = {}) {
  const r = rangeAt(sepRanges, t);
  if (!r) return 0;
  return Math.max(0, committedEnd(r[1], duration, xfSec) - t);
}

export const committedEnd = (e, duration, xfSec) => (e >= duration - SEP.eps ? e : e - xfSec);

/**
 * Sıradaki parça: oynatma konumundaki (ya da hemen ilerisindeki) ayrılmamış ilk nokta p'den başlar (en yakın önce);
 * en çok chunkSec, sonraki ayrılmış parçaya, girdinin bittiği yere (− sondaki bağlam) ve video sonuna kadar.
 * Girdi tam parçaya yetmiyorsa acil değilken (ahead > urgent) beklenir, acilken en az minSec ile başlanır.
 * → null | { a, b, ctxL, ctxR }
 */
export function planNext({
  t, raw, sep, duration = Infinity, windowSec = 32, aheadSec = 0,
  chunkSec = SEP.chunkSec, minSec = SEP.minSec, ctxSec = SEP.ctxSec, xfSec = SEP.xfSec, urgentSec = SEP.high,
}) {
  const eps = SEP.eps;
  const end = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  let p = Math.max(0, t);
  for (let guard = 0; guard < 4; guard++) {
    const r = rangeAt(sep, p, eps);
    if (!r) break;
    const ce = committedEnd(r[1], end, xfSec);
    if (p < ce) { p = ce; break; } // parçanın sonundan devam (sondaki xf ile çapraz geçer)
    p = r[1]; // konum xf kuyruğunda: kuyruktan sonra
  }
  if (p >= end - eps || p - t >= windowSec) return null;
  const rr = rangeAt(raw, p, eps);
  if (!rr) return null; // girdi yok (ağ ya da oynatıcı)
  const rawEnded = rr[1] >= end - eps;
  let b = Math.min(p + chunkSec, end);
  let bounded = b >= end - eps;
  const next = sep.find((r) => r[0] > p + eps);
  if (next && next[0] <= b) { b = next[0]; bounded = true; }
  const rawLimit = rawEnded ? rr[1] : rr[1] - ctxSec;
  let partial = false;
  if (b > rawLimit) { b = rawLimit; partial = true; bounded = rawEnded && b >= end - eps; }
  const len = b - p;
  if (len <= eps) return null;
  if (partial && !bounded) {
    if (len < minSec) return null;
    if (len < chunkSec - eps && aheadSec > urgentSec) return null;
  }
  return { a: p, b, ctxL: Math.max(0, Math.min(ctxSec, p - rr[0])), ctxR: Math.max(0, Math.min(ctxSec, rr[1] - b)) };
}

/** İşin ham örnek aralığı (bağlamla) ve çekirdeği; hepsi örnek dizini. */
export function jobSamples(job, sr) {
  const as = Math.round(job.a * sr), bs = Math.round(job.b * sr);
  return { ra: as - Math.round(job.ctxL * sr), as, bs, rb: bs + Math.round(job.ctxR * sr) };
}

/**
 * İşçinin sonucunu bağlamdan kırpıp önbelleğe yazar: [a, b + xf] (sondaki bağlamın ilk xf'si bir sonraki parçayla
 * çapraz geçiş içindir). left/right uzunluğu girdiyle aynı ([a − ctxL, b + ctxR]).
 */
export function writeResult(tl, job, left, right, { xfSec = SEP.xfSec } = {}) {
  const { ra, as, bs, rb } = jobSamples(job, tl.sr);
  const xf = Math.round(xfSec * tl.sr);
  const tail = Math.min(xf, rb - bs);
  const from = as - ra, to = Math.min(left.length, bs - ra + tail);
  if (to <= from) return;
  tl.write(as, left.subarray(from, to), right.subarray(from, to), { xf });
}

/** Bir parçayı uçtan uca işler: ham girdi (bağlamla) → ayırıcı → kırp + çapraz geçişle yaz. → { ms, backend } */
export async function runJob(job, { timeline, readRaw, separate, xfSec = SEP.xfSec }) {
  const sr = timeline.sr;
  const { ra, rb } = jobSamples(job, sr);
  const { L, R } = await readRaw(ra, rb);
  const res = await separate(L, R, sr);
  writeResult(timeline, job, res.left, res.right, { xfSec });
  return { ms: res.ms, backend: res.backend };
}

// ---- bekletme ----

/**
 * Ayırmanın video bekletme kararı. update() → true: video duraklatılmalı.
 * - başta (initial): en çok prebufferSec boyunca, prebufferSec kadar ayrılmış ses hazır olana dek (model yüklenirken de)
 * - sonra: ayırma darboğazsa (pending) ahead < low → beklet, ahead ≥ high → sür. Girdi darboğazsa (YouTube henüz
 *   indirmedi, işlenecek bir şey yok) bekletilmez: oynatıcı kendisi bekler.
 * - kullanıcı bekletme sırasında oynatırsa (userOverride) ahead yeniden high'a ulaşana dek bekletilmez.
 */
export class HoldGate {
  constructor({ low = SEP.low, high = SEP.high } = {}) {
    this.low = low;
    this.high = high;
    this.initial = true;
    this.holding = false;
    this.override = false;
  }

  update({ elapsedMs, prebufferSec, aheadSec, pending, ready, failed = false }) {
    if (failed) { this.initial = false; this.override = false; return (this.holding = false); }
    if (this.override) {
      if (aheadSec >= this.high || !pending) this.override = false;
      else return (this.holding = false);
    }
    if (this.initial) {
      if (elapsedMs < prebufferSec * 1000) {
        const want = pending && (!ready || aheadSec < prebufferSec);
        if (!want) this.initial = false;
        return (this.holding = want);
      }
      this.initial = false; // süre doldu: olağan kurala geç (bekliyorsa high'a dek sürer)
    }
    if (!ready) return (this.holding = false);
    return (this.holding = pending && aheadSec < (this.holding ? this.high : this.low));
  }

  userOverride() {
    this.override = true;
    this.initial = false;
    this.holding = false;
  }
}

// ---- kayma ----

/** Ayrılmış sesin video zamanına kayması; son n ölçümün ortancası sınırı aşarsa yeniden eşitleme ister. */
export class DriftMeter {
  constructor({ n = 5, limit = SEP.driftSec } = {}) {
    this.n = n;
    this.limit = limit;
    this.xs = [];
  }

  /** → true: yeniden eşitle */
  push(d) {
    this.xs.push(d);
    if (this.xs.length > this.n) this.xs.shift();
    return this.xs.length >= this.n && Math.abs(this.median) > this.limit;
  }

  get median() {
    if (!this.xs.length) return 0;
    const s = [...this.xs].sort((a, b) => a - b);
    return s[s.length >> 1];
  }

  reset() { this.xs = []; }
}

/** İki sinyal arasındaki gecikme (örnek): b, a'ya göre kaç örnek geride (pozitif: b sonra). Normalize çapraz ilinti. */
export function bestLag(a, b, maxLag) {
  let best = 0, bestV = -Infinity;
  const n = Math.min(a.length, b.length);
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0, ea = 0, eb = 0;
    for (let i = Math.max(0, lag); i < n && i - lag < n; i++) {
      const x = a[i - lag], y = b[i];
      s += x * y; ea += x * x; eb += y * y;
    }
    const v = s / Math.sqrt(ea * eb + 1e-12);
    if (v > bestV) { bestV = v; best = lag; }
  }
  return { lag: best, score: bestV };
}
