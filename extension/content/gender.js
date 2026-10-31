// Konuşanın cinsiyeti: videonun orijinal sesinden perde (F0) ölçülür, cümle başına kadın / erkek tahmini yapılır.
// Saf modül (DOM yok): içerik betiği AnalyserNode çerçevelerini verir, Node testleri sentetik ve gerçek konuşmayla sınar.
//
// Altyazı konuşanın kim olduğunu söylemez; perde ancak o an çalan sesten ölçülebilir. Bu yüzden bir cümlenin cinsiyeti
// o cümle duyulduktan sonra bilinir; ilerideki cümleler için tahmin, konuşmacı sırası (>>) ve en son duyulan sesten yapılır.

const FMIN = 70;
const FMAX = 400;
const THRESHOLD = 0.25;
/** Bunun altı erkek, `FEMALE_MIN_HZ` üstü kadın; arası belirsiz (ölçüm sayılmaz). */
export const MALE_MAX_HZ = 155;
export const FEMALE_MIN_HZ = 170;
/** Bir cümlenin ölçülmesi için gereken ötümlü çerçeve sayısı (50 ms'de bir → ≈ 0.75 sn konuşma). */
export const MIN_VOICED = 15;
/** Erken karar (cümle sürerken) için yeterli ötümlü çerçeve (≈ 0.4–0.5 sn konuşma). */
export const EARLY_VOICED = 8;
const KEEP_SEC = 120;
// Tutulan nota: art arda bu kadar çerçeve perdesi bu oranda sabit kalırsa müzik sayılır (konuşmada perde hep kayar).
const HELD_FRAMES = 6;
const HELD_TOL = 0.01;
const HELD_GAP_SEC = 0.08;
// Aralıkta hem erkek hem kadın bandında bu paydan fazla örnek: üst üste konuşma ya da müzik → belirsiz.
const MIXED_SHARE = 0.45;
/** Eşikten bu kadar uzak ölçüm tek başına yeter (sınıra yakın olanlarda son ölçümlerin çoğunluğu aranır). */
export const CLEAR_MALE_HZ = 140;
export const CLEAR_FEMALE_HZ = 185;

/**
 * Bir ses çerçevesinin perdesi (Hz), sessiz/ötümsüzse 0. `rate` örnek hızı; çerçeve ≈ 40 ms (48 kHz'te 2048 örnek).
 * Hız için önce ortalama alınarak seyreltilir (≈ 12 kHz), sonra YIN.
 */
export function estimateF0(frame, rate) {
  const step = Math.max(1, Math.floor(rate / 12000));
  const r = rate / step;
  const n = Math.floor(frame.length / step);
  const x = new Float32Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < step; j++) s += frame[i * step + j];
    x[i] = s / step;
    energy += x[i] * x[i];
  }
  if (Math.sqrt(energy / Math.max(1, n)) < 0.01) return 0; // ≈ −40 dBFS altı: sessizlik
  const tMin = Math.floor(r / FMAX);
  const tMax = Math.min(Math.ceil(r / FMIN), n >> 1);
  const W = n - tMax;
  if (W < tMax) return 0;
  const d = new Float32Array(tMax + 1);
  for (let tau = 1; tau <= tMax; tau++) {
    let sum = 0;
    for (let i = 0; i < W; i++) {
      const diff = x[i] - x[i + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  let run = 0;
  for (let tau = 1; tau <= tMax; tau++) {
    run += d[tau];
    d[tau] = run ? (d[tau] * tau) / run : 1;
  }
  for (let tau = tMin; tau <= tMax; tau++) {
    if (d[tau] < THRESHOLD) {
      while (tau + 1 <= tMax && d[tau + 1] < d[tau]) tau++;
      const a = d[tau - 1] ?? d[tau];
      const b = d[tau];
      const c = d[tau + 1] ?? d[tau];
      const den = a - 2 * b + c;
      return r / (den ? tau + (0.5 * (a - c)) / den : tau);
    }
  }
  return 0;
}

/** Ortanca perdeden cinsiyet: 'male' | 'female' | null (belirsiz). */
export function genderOf(hz) {
  if (!(hz > 0)) return null;
  if (hz < MALE_MAX_HZ) return 'male';
  if (hz > FEMALE_MIN_HZ) return 'female';
  return null;
}

/** Video zamanına göre perde örnekleri; bir aralığın ortanca perdesi ve cinsiyeti. */
export class GenderTracker {
  constructor() {
    this.samples = []; // [videoTime, f0] (f0 > 0, zamana göre sıralı tutulmaz: ileri sarmada karışabilir)
  }

  push(t, f0) {
    if (!(f0 > 0)) return;
    this.samples.push([t, f0]);
    if (this.samples.length > 4000) this.samples.splice(0, 1000);
  }

  /** İleri/geri sarma sonrası uzaktaki örnekleri at. */
  prune(t) {
    this.samples = this.samples.filter(([st]) => Math.abs(st - t) < KEEP_SEC);
  }

  /**
   * [start, end] aralığının ölçümü → { hz, gender } ya da yeterli konuşma yoksa null. Tutulan notalar (müzik) atılır;
   * hem erkek hem kadın bandı kalabalıksa gender null (belirsiz). opts.min: gereken örnek (erken karar: EARLY_VOICED).
   */
  measure(start, end, { min = MIN_VOICED } = {}) {
    const f = dropHeld(this.samples.filter(([t]) => t >= start && t <= end).sort((a, b) => a[0] - b[0]));
    if (f.length < min) return null;
    const male = f.filter((v) => v < MALE_MAX_HZ).length;
    const female = f.filter((v) => v > FEMALE_MIN_HZ).length;
    const mixed = male > f.length * MIXED_SHARE && female > f.length * MIXED_SHARE;
    f.sort((a, b) => a - b);
    // oktav hatalarına karşı ortancanın iki katı/yarısı dışını at, sonra yeniden ortanca
    const m0 = f[f.length >> 1];
    const g = f.filter((v) => v > m0 / 1.8 && v < m0 * 1.8);
    const hz = g[g.length >> 1] ?? m0;
    return { hz: Math.round(hz), gender: mixed ? null : genderOf(hz) };
  }
}

/** [t, f0] çerçevelerinden ötümlü olanların perdeleri, tutulan notalar (müzik) atılmış: küme kanıtı için. */
export function voicedF0(frames) {
  return dropHeld(frames.filter(([, f]) => f > 0).sort((a, b) => a[0] - b[0]));
}

// Zamana göre sıralı [t, f0] örneklerinden tutulan nota dizilerini at → kalan perdeler.
function dropHeld(s) {
  const out = [];
  let run = [];
  let lastT = -Infinity;
  const flush = () => { if (run.length < HELD_FRAMES) out.push(...run); run = []; };
  for (const [t, f0] of s) {
    if (run.length && (t - lastT > HELD_GAP_SEC || Math.abs(f0 / run[0] - 1) > HELD_TOL)) flush();
    run.push(f0);
    lastT = t;
  }
  flush();
  return out;
}

/**
 * Konuşmacı sırasının cinsiyeti, yeni ölçümle: belirgin ölçüm (eşikten uzak) hemen geçerli; sınıra yakınsa son 3
 * ölçümün çoğunluğu (eşitlikte en yenisi). recent: o sıranın son ölçümleri (en fazla 3, yerinde güncellenir).
 */
export function turnGender(recent, m) {
  recent.push(m.gender);
  while (recent.length > 3) recent.shift();
  if (m.hz < CLEAR_MALE_HZ || m.hz > CLEAR_FEMALE_HZ) return m.gender;
  const f = recent.filter((g) => g === 'female').length;
  return f * 2 > recent.length ? 'female' : f * 2 < recent.length ? 'male' : m.gender;
}

/**
 * Bir cümlenin konuşanının cinsiyet tahmini. Sıra: cümlenin kendi ölçümü → konuşmacı sırasının (speaker sayacı)
 * öğrenilmiş cinsiyeti → iki sıra öncekinin (iki kişilik konuşma) → en son duyulan → varsayılan (birinci ses).
 * @param st { turns: Map<speaker, gender>, last: gender|null, fallback: gender|null }
 */
export function predictGender(sentence, st) {
  if (sentence.gender) return sentence.gender;
  const turn = sentence.speaker || 0;
  if (st.turns.has(turn)) return st.turns.get(turn);
  if (turn >= 2 && st.turns.has(turn - 2)) return st.turns.get(turn - 2);
  return st.last || st.fallback || null;
}

// ---------------------------------------------------------------------------------------------------------------
// Konuşmacı kümeleri: cümle başına konuşmacı vektörü (engines/spk, birim uzunluk) → çevrimiçi kümeleme → küme başına
// tek cinsiyet. Perde tek cümlede müzik/bağırma/fısıltıyla kayar; aynı kişinin bütün cümlelerinin kanıtı birlikte
// tartılınca karar kararlı olur ve aynı küme hep aynı sesle konuşur. Eşikler tools/spk-eval.mjs ölçümünden.

/** En yakın kümeye benzerlik bundan büyükse katılır (kosinüs). */
export const SPK_JOIN = 0.5;
/** Bundan küçükse yeni küme; arası belirsiz: en yakına yarım ağırlıkla katılır (yeni kişi açmakta tutucu). */
export const SPK_NEW = 0.3;
/** İki kümenin merkezleri bu kadar benzerse birleşir. */
export const SPK_MERGE = 0.55;
/** Küme cinsiyeti için gereken toplam kanıt (ötümlü perde çerçevesi; 50 ms'de bir). */
export const SPK_MIN_F0 = 10;

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function unit(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}

// Log-perde kutuları (70–400 Hz, yarım ton): kümenin bütün çerçevelerinin ortancası bellek sınırlı tutulur.
const F0_LO = 70;
const F0_BINS = 31;
const f0Bin = (hz) => Math.min(F0_BINS - 1, Math.max(0, Math.round(12 * Math.log2(hz / F0_LO))));
const binHz = (b) => F0_LO * 2 ** (b / 12);

/**
 * Kümesi olmayan tek cümlenin cinsiyeti ({ f0: perde çerçeveleri, score: sınıflandırıcı logiti }): küme kararıyla
 * aynı puan, aynı eşik; kanıt az ya da belirsizse null.
 */
export function sentenceGender({ f0 = [], score = null } = {}) {
  const c = new SpeakerClusters();
  const z = c.evidence(c._empty(f0, score));
  return z == null || Math.abs(z) < 1 ? null : z > 0 ? 'female' : 'male';
}

/**
 * Çevrimiçi konuşmacı kümeleme ve küme cinsiyeti. Kimlikler kalıcıdır: birleşen kümenin kimliği takma ad olur
 * (resolve). Cinsiyet kanıtı: cümlelerin ötümlü perde çerçeveleri (tutulan notalar atılmış) ve varsa sınıflandırıcı
 * puanı (> 0 kadın, logit). Karar yeterli kanıtla bir kez verilir; yalnız birikmiş kanıt açıkça tersini gösterirse döner.
 */
export class SpeakerClusters {
  constructor({ join = SPK_JOIN, fresh = SPK_NEW, merge = SPK_MERGE, minF0 = SPK_MIN_F0 } = {}) {
    Object.assign(this, { joinThr: join, newThr: fresh, mergeThr: merge, minF0 });
    this.clusters = new Map(); // id → { id, sum, centroid, n, hist, nf0, score, nscore, gender, order }
    this.alias = new Map();
    this.next = 1;
  }

  // Boş küme kaydı (isteğe bağlı kanıtla; sentenceGender kimliksiz kullanır).
  _empty(f0 = null, score = null) {
    const c = { id: null, sum: null, centroid: null, n: 0, w: 0, hist: new Float32Array(F0_BINS), nf0: 0, score: 0, nscore: 0, gender: null };
    if (f0) for (const hz of f0) if (hz > 0) { c.hist[f0Bin(hz)]++; c.nf0++; }
    if (Number.isFinite(score)) { c.score = score; c.nscore = 1; }
    return c;
  }

  resolve(id) {
    while (this.alias.has(id)) id = this.alias.get(id);
    return id;
  }

  get(id) { return this.clusters.get(this.resolve(id)) || null; }

  /** En yakın küme ve benzerliği. */
  nearest(v) {
    let best = null;
    let sim = -1;
    for (const c of this.clusters.values()) {
      const s = cosine(v, c.centroid);
      if (s > sim) { sim = s; best = c; }
    }
    return { cluster: best, sim };
  }

  /**
   * Bir cümlenin vektörünü küme ata → küme kimliği. w: güven ağırlığı (ör. konuşma süresi, sn).
   * ev: { f0?: number[], score?: number } cinsiyet kanıtı (addEvidence).
   */
  assign(v, { w = 1, ev = null } = {}) {
    const { cluster, sim } = this.nearest(v);
    let c = cluster;
    if (!c || sim < this.newThr) {
      c = this._empty();
      c.id = this.next++;
      c.sum = new Float32Array(v.length);
      this.clusters.set(c.id, c);
    } else if (sim < this.joinThr) w *= 0.5;
    for (let i = 0; i < v.length; i++) c.sum[i] += w * v[i];
    c.centroid = unit(c.sum);
    c.n++;
    c.w += w;
    if (ev) this.addEvidence(c.id, ev);
    this._merge();
    return this.resolve(c.id);
  }

  // Merkezleri yakınlaşan kümeleri birleştir (küçük olan büyüğe).
  _merge() {
    for (;;) {
      const cs = [...this.clusters.values()];
      let pair = null;
      let best = this.mergeThr;
      for (let i = 0; i < cs.length; i++) {
        for (let j = i + 1; j < cs.length; j++) {
          const s = cosine(cs[i].centroid, cs[j].centroid);
          if (s > best) { best = s; pair = cs[i].w >= cs[j].w ? [cs[i], cs[j]] : [cs[j], cs[i]]; }
        }
      }
      if (!pair) return;
      const [a, b] = pair;
      for (let i = 0; i < a.sum.length; i++) a.sum[i] += b.sum[i];
      a.centroid = unit(a.sum);
      a.n += b.n;
      a.w += b.w;
      for (let i = 0; i < F0_BINS; i++) a.hist[i] += b.hist[i];
      a.nf0 += b.nf0;
      a.score += b.score;
      a.nscore += b.nscore;
      a.gender = a.gender || b.gender;
      this.clusters.delete(b.id);
      this.alias.set(b.id, a.id);
      this._decide(a, true);
    }
  }

  /** Kümeye cinsiyet kanıtı ekle (perde çerçeveleri, Hz; sınıflandırıcı logiti). Karar değiştiyse true. */
  addEvidence(id, { f0 = null, score = null } = {}) {
    const c = this.get(id);
    if (!c) return false;
    if (f0) for (const hz of f0) if (hz > 0) { c.hist[f0Bin(hz)]++; c.nf0++; }
    if (Number.isFinite(score)) { c.score += score; c.nscore++; }
    return this._decide(c, false);
  }

  /** Kümenin ortanca perdesi (Hz) ya da yeterli kanıt yoksa 0. Oktav hataları (ortancanın ±10 yarım ton dışı) atılır. */
  medianHz(id) {
    const c = typeof id === 'object' ? id : this.get(id);
    if (!c || c.nf0 < this.minF0) return 0;
    const med = (lo, hi) => {
      let n = 0;
      for (let b = lo; b <= hi; b++) n += c.hist[b];
      let acc = 0;
      for (let b = lo; b <= hi; b++) {
        acc += c.hist[b];
        if (acc >= n / 2) return b;
      }
      return lo;
    };
    const m0 = med(0, F0_BINS - 1);
    return binHz(med(Math.max(0, m0 - 10), Math.min(F0_BINS - 1, m0 + 10)));
  }

  /**
   * Kanıtın cinsiyet puanı (> 0 kadın): sınıflandırıcı varsa ortalama logiti, perde ortancasının eşik ortasına
   * (162 Hz) uzaklığıyla (yarım ton başına 0.5) toplanır. Kanıt yoksa null.
   */
  evidence(c) {
    const hz = c.nf0 >= this.minF0 ? this.medianHz(c) : 0;
    if (!hz && !c.nscore) return null;
    let z = 0;
    if (hz) z += 0.5 * 12 * Math.log2(hz / 162);
    if (c.nscore) z += c.score / c.nscore;
    return z;
  }

  // Yapışkan karar: ilk karar |z| ≥ 1 ile; sonra yön ancak |z| ≥ 3 ile döner.
  _decide(c, force) {
    const z = this.evidence(c);
    if (z == null) return false;
    const g = z > 0 ? 'female' : 'male';
    if (g === c.gender) return false;
    if (!c.gender ? Math.abs(z) < 1 : Math.abs(z) < 3 && !force) return false;
    c.gender = g;
    return true;
  }

  genderOf(id) { return this.get(id)?.gender || null; }

  /** Aynı cinsiyetin kaçıncı kümesi (görülme sırasıyla, 0'dan): aynı cinsiyetten iki konuşmacıya iki ses. */
  altOf(id) {
    const c = this.get(id);
    if (!c?.gender) return 0;
    let k = 0;
    for (const o of this.clusters.values()) {
      if (o === c) return k;
      if (o.gender === c.gender && o.n >= 2) k++;
    }
    return 0;
  }
}
