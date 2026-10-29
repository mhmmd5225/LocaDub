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
const KEEP_SEC = 120;
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

  /** [start, end] aralığının ölçümü → { hz, gender } ya da yeterli konuşma yoksa null. */
  measure(start, end) {
    const f = this.samples.filter(([t]) => t >= start && t <= end).map(([, f0]) => f0);
    if (f.length < MIN_VOICED) return null;
    f.sort((a, b) => a - b);
    // oktav hatalarına karşı ortancanın iki katı/yarısı dışını at, sonra yeniden ortanca
    const m0 = f[f.length >> 1];
    const g = f.filter((v) => v > m0 / 1.8 && v < m0 * 1.8);
    const hz = g[g.length >> 1] ?? m0;
    return { hz: Math.round(hz), gender: genderOf(hz) };
  }
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
