// Üslup tablosu: "Doğal / Canlı / Sakin" seçeneklerinin sese göre parametreleri. Saf veri + küçük yardımcılar
// (DOM yok, chrome.* yok); ayarlar sayfası, içerik betiği, motor ve Node testleri aynı dosyayı kullanır.
//
// DÜRÜST NOT: bunlar ince ayardır, robot hissini ortadan kaldırmaz. Değerler "başlangıç tahmini"dir ve DİNLEYEREK
// ayarlanmalıdır; tüm sabitler bu tabloda durur, başka yerde kopyası yoktur.
//   - Ahenk Cep: yalnızca stil gömmesi (neutral/cheerful/calm). Model kartına göre etkisi zayıftır; 'laughter'
//     gömmesi vardır ama kahkaha eğitilmediği için sunulmaz.
//   - Antalia Mini: yalnızca örnekleme sıcaklığı (düşük = düz/kararlı, yüksek = daha değişken tonlama).
//   - Ortak: hız çarpanı (içerik betiğinde temel hıza katılır, bkz. content/timing.js) ve perde kaydırma.

export const STYLE_IDS = ['natural', 'lively', 'calm'];
export const DEFAULT_STYLE = 'natural';
export const QUALITIES = ['fast', 'high'];
export const DEFAULT_QUALITY = 'fast';

/** Kullanıcı perdesi (yarım ton) ve üslup perdesiyle birlikte toplam sınır. */
export const PITCH_RANGE = [-3, 3];
export const PITCH_STEP = 0.5;
export const TOTAL_PITCH_LIMIT = 4;
/** quality: 'high' için flow adımı (varsayılan: Ahenk 8, Antalia 8). */
export const HIGH_STEPS = 16;

// başlangıç tahmini: hepsi dinleyerek ayarlanacak
export const STYLES = Object.freeze({
  natural: Object.freeze({ label: 'Doğal', ahenk: 'neutral', temperature: 0.6, speed: 1.0, pitch: 0 }),
  lively: Object.freeze({ label: 'Canlı', ahenk: 'cheerful', temperature: 0.8, speed: 1.05, pitch: 1 }),
  calm: Object.freeze({ label: 'Sakin', ahenk: 'calm', temperature: 0.4, speed: 0.95, pitch: -1 }),
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const normalizeStyle = (s) => (STYLE_IDS.includes(s) ? s : DEFAULT_STYLE);
export const normalizeQuality = (q) => (QUALITIES.includes(q) ? q : DEFAULT_QUALITY);

/** Kullanıcı perdesi: sayıya çevrilir, 0.5 adıma yuvarlanır, −3…+3 aralığına kırpılır. */
export function normalizePitch(p) {
  if (p === null || p === '' || typeof p === 'boolean') return 0;
  const n = Number(p);
  if (!Number.isFinite(n)) return 0;
  return clamp(Math.round(n / PITCH_STEP) * PITCH_STEP, ...PITCH_RANGE) + 0; // +0: -0'ı 0 yapar
}

/** Ham { style, pitch, quality } → temiz hâli (bilinmeyen/eksik değer varsayılana düşer). */
export function normalizeTone(t) {
  return { style: normalizeStyle(t?.style), pitch: normalizePitch(t?.pitch), quality: normalizeQuality(t?.quality) };
}

/** Üslubun hız çarpanı (içerik betiği temel hıza katar; motor ayrıca çarpmaz). */
export const styleSpeed = (style) => STYLES[normalizeStyle(style)].speed;

/** Toplam perde (yarım ton): üslubun perdesi + kullanıcınınki, ±TOTAL_PITCH_LIMIT ile sınırlı. */
export function totalPitch(style, pitch) {
  return clamp(STYLES[normalizeStyle(style)].pitch + normalizePitch(pitch), -TOTAL_PITCH_LIMIT, TOTAL_PITCH_LIMIT) + 0;
}

/** Yarım tonun frekans oranı. */
export const pitchRatio = (semitones) => 2 ** (semitones / 12);

/**
 * Motorun kullanacağı parametreler.
 * @param tone { style, pitch, quality } (ham olabilir)
 * @param ahenkStyles Ahenk manifestindeki stil adları; üslubun stili yoksa 'neutral'e düşülür
 * @returns {{ style, pitch, quality, ahenkStyle:string, temperature:number, semitones:number, steps:number|null }}
 *   steps: null → sesin kendi varsayılanı
 */
export function resolveTone(tone, ahenkStyles = []) {
  const t = normalizeTone(tone);
  const def = STYLES[t.style];
  return {
    ...t,
    ahenkStyle: ahenkStyles.includes(def.ahenk) ? def.ahenk : 'neutral',
    temperature: def.temperature,
    semitones: totalPitch(t.style, t.pitch),
    steps: t.quality === 'high' ? HIGH_STEPS : null,
  };
}

/** Ayarlardan (settings) motora gidecek ton. */
export function toneFromSettings(s) {
  return normalizeTone({ style: s.style, pitch: s.pitch, quality: s.quality });
}
