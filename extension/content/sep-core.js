// Gerçek dublaj (ses ayırma) için saf yardımcılar; DOM'a dokunmaz, node testleriyle sınanır.
// - PacketStore: kodlanmış ses paketleri (opus / AAC), medya zamanına göre (MSE eklemelerinden, content/sep-demux.js)
// - PcmTimeline: ayrılmış PCM önbelleği (örnek dizini → Float32 L/R), birleşme ve çakışmada çapraz geçiş
// - planNext: sıradaki ayırma parçası (tek parça kipi: bağlam + çapraz geçiş)
// - planStream / writeStreamResult: akış kipi (mutlak pencere ızgarası; engines/sep/separator.js başı)
// - HoldGate: başta gereken ön tampon, oynatırken ölçülen hıza (rtf) uyan histerezis
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
  gpuChunkSec: 24,       // WebGPU'da akış parçası (pencere adımına ve batch'e hizalanır); WASM'da chunkSec
  firstSec: 8,           // yeni akışın ilk parçası (hızlı başlangıç, rtf erken ölçülür)
  inflight: 2,           // aynı anda gönderilmiş iş (çözme + aktarım model çalışırken yapılır)
  highSlow: 30,          // rtf ≥ slowRtf iken sürme eşiği: seyrek ama uzun bekleme
  slowRtf: 0.9,
  holdMaxSec: 60,        // rtf < 1 iken başlangıç bekletmesi ön tamponu en çok bu kadar aşar
  streamLat: 0.005,      // akışta yeniden örnekleme payı (sn)
});

/** İleriye işlenecek pencere: ön tampon (ya da sürme eşiği) + bir parça. */
export const windowFor = (prebufferSec, highSec = SEP.high, chunkSec = SEP.chunkSec) =>
  Math.max(prebufferSec, highSec) + chunkSec;

/** Akış parçası (sn): pencere adımının batch katı (son grup boş kalmasın); WebGPU'da ≈ 24, diğerlerinde ≈ 12 sn. */
export function streamChunkSec(backend, stepSec, batch = 1) {
  const target = backend === 'webgpu' ? SEP.gpuChunkSec : SEP.chunkSec;
  const g = Math.max(1, batch) * stepSec;
  return Math.max(1, Math.round(target / g)) * g;
}

/** Sıralı aralık birleşimi. */
export function mergeRanges(...lists) {
  const all = lists.flat().filter((r) => r[1] > r[0]).map((r) => [r[0], r[1]]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of all) {
    const l = out[out.length - 1];
    if (l && a <= l[1] + 1e-6) l[1] = Math.max(l[1], b);
    else out.push([a, b]);
  }
  return out;
}

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
  const p = firstGap(t, sep, end, xfSec);
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

/** t'den itibaren ayrılmamış ilk nokta (t'yi içeren parçanın, xf kuyruğu hariç, sonu). */
function firstGap(t, sep, end, xfSec) {
  let p = Math.max(0, t);
  for (let guard = 0; guard < 4; guard++) {
    const r = rangeAt(sep, p, SEP.eps);
    if (!r) break;
    const ce = committedEnd(r[1], end, xfSec);
    if (p < ce) return ce; // parçanın sonundan devam (sondaki xf ile çapraz geçer)
    p = r[1]; // konum xf kuyruğunda: kuyruktan sonra
  }
  return p;
}

/**
 * Akış kipinde sıradaki iş. sep: yazılmış + gönderilmiş işlerin beklenen aralıkları (mergeRanges). stream: süren akış
 * { inEnd: gönderilen girdinin sonu, out: gönderilenler bitince kesinleşecek son } (sn) ya da null. geo: işçinin
 * ızgarası { win: pencere, step: adım, lat?: pay } (sn): pencere k, girdi k·step + win'e varınca çalışır;
 * (k+1)·step'e kadar kesinleşir.
 * - devam (ayrılmamış ilk nokta akışın kesinleşecek sonuysa): girdi [inEnd, ..), chunkSec'lik tam pencereler
 * - yeni akış: p'den, önünde ctxSec bağlamla; acilken ilk parça firstSec
 * - sonraki ayrılmış parça ya da video sonu yakınsa final: o sınıra kadar (+ ctxSec sağ bağlam) kesinleşir, akış biter
 * - girdi yetmezse acil değilken beklenir; acilken eldeki tam pencereler, o da yoksa en az minSec'lik final iş
 * → null | { a, b, ra, rb, ctxL, reset, final, cont } (a..b beklenen çıktı, ra..rb gönderilecek girdi; sn)
 */
export function planStream({
  t, raw, sep, stream = null, geo, duration = Infinity, windowSec = 32, aheadSec = 0, chunkSec = SEP.chunkSec,
  firstSec = SEP.firstSec, minSec = SEP.minSec, ctxSec = SEP.ctxSec, xfSec = SEP.xfSec, urgentSec = SEP.high,
}) {
  const eps = SEP.eps;
  const end = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  let p = firstGap(t, sep, end, xfSec);
  const cont = !!stream && Math.abs(p - stream.out) <= xfSec + eps;
  if (cont) p = stream.out;
  if (p >= end - eps || p - t >= windowSec) return null;
  const { win, step } = geo;
  const lat = geo.lat ?? SEP.streamLat;
  const kOf = (e) => Math.floor((e - lat - win) / step + 1e-6); // e'ye kadarki girdiyle tamamlanan son pencere
  const inEnd = (k) => k * step + win + lat;
  const outEnd = (k) => (k + 1) * step;
  const rr = rangeAt(raw, cont ? stream.inEnd - 1e-3 : p, eps);
  if (!rr || (cont && rr[1] <= stream.inEnd + eps)) return null; // girdi yok
  const rawEnded = rr[1] >= end - eps;
  const ctxL = cont ? 0 : Math.max(0, Math.min(ctxSec, p - rr[0]));
  const ra = cont ? stream.inEnd : p - ctxL;
  const next = sep.find((r) => r[0] > p + eps);
  const B = Math.min(next ? next[0] : Infinity, end);
  const urgent = aheadSec <= urgentSec;
  const k0 = kOf(ra) + 1; // ilk yeni pencere
  let k1 = cont ? k0 - 1 + Math.max(1, Math.round(chunkSec / step))
    : Math.max(k0, Math.ceil((p + (urgent ? Math.min(firstSec, chunkSec) : chunkSec)) / step - 1e-6) - 1);
  const fin = (b, rb) => (b - p > eps ? { a: p, b, ra, rb, ctxL, reset: !cont, final: true, cont } : null);
  if (outEnd(k1) >= B - eps) { // sınıra varılıyor
    if (B >= end - eps) { if (rawEnded) return fin(end, end); } else if (rr[1] - ctxSec >= B - eps) return fin(B, B + ctxSec);
  }
  if (inEnd(k1) > rr[1] + eps) {
    if (rawEnded) return fin(Math.min(B, end), B >= end - eps ? end : Math.min(rr[1], B + ctxSec));
    const kMax = kOf(rr[1]);
    if (urgent && kMax >= k0 && (cont || outEnd(kMax) - p >= minSec)) k1 = kMax;
    else if (urgent && rr[1] - ctxSec - p >= minSec) return fin(rr[1] - ctxSec, rr[1]);
    else return null;
  }
  return { a: p, b: outEnd(k1), ra, rb: inEnd(k1), ctxL, reset: !cont, final: false, cont };
}

/**
 * Akış sonucunu önbelleğe yazar. res: { left, right, startSample (tl.sr ızgarasında), reset }. Yeni akışın başındaki
 * bağlam atılır (a − xf'den yazılır: önceki parçayla çapraz geçiş); final işte b + xf'ye kadar (sonraki parçayla
 * çapraz geçiş). Akışın ortası dikişsiz, ardışık yazılır. İşçi akışı beklenmedik biçimde sıfırladıysa (önceki iş
 * düştü) ilk ctxSec güvenilmez sayılıp atılır. → yazılan [lo, hi) (örnek) ya da null
 */
export function writeStreamResult(tl, job, res, { xfSec = SEP.xfSec, ctxSec = SEP.ctxSec, duration = Infinity } = {}) {
  const sr = tl.sr;
  const s0 = res.startSample, n = res.left.length;
  if (!n) return null;
  const xf = Math.round(xfSec * sr);
  let lo = s0, hi = s0 + n;
  if (job.reset) lo = Math.round(job.a * sr) - (job.ctxL >= xfSec ? xf : 0);
  else if (res.reset) lo = s0 + Math.round(ctxSec * sr);
  if (job.final && job.b < duration - SEP.eps) hi = Math.min(hi, Math.round(job.b * sr) + xf);
  lo = Math.max(lo, s0);
  if (hi <= lo) return null;
  const edge = job.reset || job.final || res.reset;
  tl.write(lo, res.left.subarray(lo - s0, hi - s0), res.right.subarray(lo - s0, hi - s0), { xf: edge ? xf : 0 });
  return [lo, hi];
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
 * Ayırmanın video bekletme kararı (kalite sabit: model ve örtüşme düşürülmez, yetişmezse beklenir). update() → true:
 * video duraklatılmalı. rtf: ölçülen işlem süresi / ses süresi (0: bilinmiyor); chunkSec: bir sonucun getirdiği ses.
 * Ayrılmış ses parça parça gelir: sonraki sonuç beklenirken hazır süre chunkSec·rtf kadar düşer (dip).
 * - başta (initial): gereken = rtf < 1 biliniyorsa min(prebufferSec, low + dip + 1), değilse prebufferSec; hazır süre
 *   gerekene ulaşınca sürer (süre dolmasını beklemez). prebufferSec dolunca: rtf < 1 ve iş sürüyorsa gereken dolana
 *   dek (en çok holdMaxSec fazladan) beklenir; aksi halde olağan kurala geçilir (bekliyorsa sürme eşiğine dek sürer).
 *   İşlenecek girdi yoksa (pending değil) bekletilmez ama başlangıç evresi bitmez.
 * - sonra: ayırma darboğazsa (pending) ahead < low → beklet, ahead ≥ high → sür. high: rtf < slowRtf iken
 *   max(8, low + dip + 1); rtf ≥ slowRtf iken highSlow (30): seyrek ama uzun bekleme. Eşikler kalan süreyle sınırlı.
 *   Girdi darboğazsa (YouTube henüz indirmedi) bekletilmez: oynatıcı kendisi bekler.
 * - kullanıcı bekletme sırasında oynatırsa (userOverride) ahead yeniden high'a ulaşana dek bekletilmez.
 * update sonrası: needSec (şu anki sürme hedefi), etaSec (bekliyorsa tahmini kalan sn: bekletmede ayrılmış ses
 * 1/rtf sn/sn büyür → (need − ahead)·rtf; rtf bilinmiyorsa ya da beklemiyorsa null).
 */
export class HoldGate {
  constructor({ low = SEP.low, high = SEP.high, highSlow = SEP.highSlow, slowRtf = SEP.slowRtf } = {}) {
    this.low = low;
    this.high = high;
    this.highSlow = highSlow;
    this.slowRtf = slowRtf;
    this.initial = true;
    this.holding = false;
    this.override = false;
    this.needSec = high;
    this.etaSec = null;
  }

  /** Oynarken sürme eşiği. */
  highFor(rtf, chunkSec = SEP.chunkSec) {
    if (!(rtf > 0)) return this.high;
    if (rtf >= this.slowRtf) return this.highSlow;
    return Math.min(this.highSlow, Math.max(this.high, this.low + chunkSec * rtf + 1));
  }

  /** Başlangıçta gereken hazır süre. */
  startNeed(prebufferSec, rtf, chunkSec = SEP.chunkSec) {
    if (rtf > 0 && rtf < 1) return Math.min(prebufferSec, this.low + chunkSec * rtf + 1);
    return prebufferSec;
  }

  update({
    elapsedMs, prebufferSec, aheadSec, pending, ready, failed = false, rtf = 0, chunkSec = SEP.chunkSec,
    remainingSec = Infinity,
  }) {
    const cap = (x) => Math.min(x, Math.max(0, remainingSec - 0.1));
    const done = (v) => {
      this.holding = v;
      this.etaSec = v && ready && rtf > 0 ? Math.round(Math.max(0, this.needSec - aheadSec) * rtf * 10) / 10 : null;
      return v;
    };
    const high = cap(this.highFor(rtf, chunkSec));
    this.needSec = high;
    if (failed) { this.initial = false; this.override = false; return done(false); }
    if (this.override) {
      if (aheadSec >= high || !pending) this.override = false;
      else return done(false);
    }
    if (this.initial) {
      const need = cap(this.startNeed(prebufferSec, rtf, chunkSec));
      this.needSec = need;
      if (ready && aheadSec >= need - SEP.eps) { this.initial = false; return done(false); }
      const fast = ready && rtf > 0 && rtf < 1 && pending;
      if (elapsedMs < prebufferSec * 1000 || (fast && elapsedMs < (prebufferSec + SEP.holdMaxSec) * 1000)) {
        return done(!!pending); // girdi yoksa bekletme; başlangıç evresi sürer
      }
      this.initial = false; // süre doldu: olağan kurala geç (bekliyorsa sürme eşiğine dek sürer)
      this.needSec = high;
    }
    if (!ready) return done(false);
    return done(!!pending && aheadSec < (this.holding ? high : this.low));
  }

  userOverride() {
    this.override = true;
    this.initial = false;
    this.holding = false;
    this.etaSec = null;
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
