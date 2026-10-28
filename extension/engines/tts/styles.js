// Üslup tablosu: "Doğal / Canlı / Sakin" seçeneklerinin sese göre parametreleri. Saf veri + küçük yardımcılar
// (DOM yok, chrome.* yok); ayarlar sayfası, içerik betiği, motor ve Node testleri aynı dosyayı kullanır.
//
// DÜRÜST NOT: bunlar ince ayardır, robot hissini ortadan kaldırmaz. Değerler "başlangıç tahmini"dir ve DİNLEYEREK
// ayarlanmalıdır; tüm sabitler bu tabloda durur, başka yerde kopyası yoktur.
//   - Ahenk Cep: yalnızca stil gömmesi (neutral/cheerful/calm). Model kartına göre etkisi zayıftır; 'laughter'
//     gömmesi vardır ama kahkaha eğitilmediği için sunulmaz.
//   - Antalia Mini: yalnızca örnekleme sıcaklığı. Ölçüldü (docs/TTS-KIYAS.md): ezgiyi değiştirmiyor (F0 sapması 0.6 ve
//     0.9'da ≈ 2 yarım ton); Canlı/Sakin farkını Antalia'da hız ve perde payı taşır.
//   - EMA Lightning: stil girdisi yok, akış adımları grafiğin içinde; yalnızca ortak denetimler.
//   - Supertonic 3: stil girdisi yok (ses = hazır stil vektörü). Kalite = gürültü giderme adımı (SUPERTONIC_STEPS);
//     ses karıştırma (blend) yalnızca burada: iki hazır sesin vektörleri doğrusal harmanlanır.
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
/** Supertonic 3 gürültü giderme adımları (resmî örneklerin varsayılanı 8; 16 adım tek iş parçacığında çok yavaş). */
export const SUPERTONIC_STEPS = Object.freeze({ fast: 5, high: 8 });

/** Ses karıştırma: Supertonic hazır ses anahtarları ve oran adımı. */
export const BLEND_PRESETS = Object.freeze(['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5']);
export const BLEND_STEP = 0.05;
export const BLEND_MAX = 0.9;

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

/**
 * Ses karıştırma: { with: hazır ses anahtarı, amount: 0…0.9 } ya da null (karıştırma yok). Bilinmeyen anahtar, sıfır
 * ya da geçersiz oran null olur; oran 0.05 adıma yuvarlanır.
 */
export function normalizeBlend(b) {
  if (!b || typeof b !== 'object' || !BLEND_PRESETS.includes(b.with)) return null;
  const n = Number(b.amount);
  if (!Number.isFinite(n)) return null;
  const amount = clamp(Math.round(n / BLEND_STEP) * BLEND_STEP, 0, BLEND_MAX);
  return amount > 0 ? { with: b.with, amount: Math.round(amount * 100) / 100 } : null;
}

/** Ham { style, pitch, quality, blend } → temiz hâli (bilinmeyen/eksik değer varsayılana düşer). */
export function normalizeTone(t) {
  const out = { style: normalizeStyle(t?.style), pitch: normalizePitch(t?.pitch), quality: normalizeQuality(t?.quality) };
  const blend = normalizeBlend(t?.blend);
  if (blend) out.blend = blend;
  return out;
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
 * @param model sesin modeli (voices.js `model`): 'supertonic' kendi adım tablosunu kullanır
 * @returns {{ style, pitch, quality, blend?, ahenkStyle:string, temperature:number, semitones:number, steps:number|null }}
 *   steps: null → sesin kendi varsayılanı
 */
export function resolveTone(tone, ahenkStyles = [], model = null) {
  const t = normalizeTone(tone);
  const def = STYLES[t.style];
  return {
    ...t,
    ahenkStyle: ahenkStyles.includes(def.ahenk) ? def.ahenk : 'neutral',
    temperature: def.temperature,
    semitones: totalPitch(t.style, t.pitch),
    steps: model === 'supertonic' ? SUPERTONIC_STEPS[t.quality] : t.quality === 'high' ? HIGH_STEPS : null,
  };
}

/** Ayarlardan (settings) motora gidecek ton. blend yalnızca Supertonic seslerinde etkilidir (diğerleri yok sayar). */
export function toneFromSettings(s) {
  return normalizeTone({ style: s.style, pitch: s.pitch, quality: s.quality, blend: s.voiceBlend });
}
