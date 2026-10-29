// Ortak ayarlar: varsayılanlar + chrome.storage.local yardımcıları.

import { DEFAULT_STYLE, DEFAULT_QUALITY, normalizeStyle, normalizePitch, normalizeQuality, normalizeBlend, normalizeTone } from '../engines/tts/styles.js';
import { DEFAULT_VOICE, VOICES, voiceById } from '../engines/tts/voices.js';

export const DEFAULTS = Object.freeze({
  enabled: false,          // dublaj açık mı (TR düğmesi / popup)
  engineMode: 'real',      // 'real' | 'mock' (test motoru)
  modelsApproved: false,   // kullanıcı model indirmeyi onayladı mı
  mtBackend: null,         // null → motorun varsayılanı
  voice: null,             // null → motorun varsayılanı; 'system' → chrome.tts
  systemVoiceName: null,   // chrome.tts ses adı (isteğe bağlı)
  speakerVoices: false,    // konuşmacı değişince (>>) ikinci sesle konuş
  voice2: null,            // ikinci ses; null → birinci sesin karşıt cinsiyetlisi
  voice3: null,            // üçüncü / dördüncü konuşmacı sesi (speakerCount > 2); null → kendiliğinden seçilir
  voice4: null,
  speakerCount: 2,         // konuşmacı değişimlerinde (>>) sırayla dönen ses sayısı (2–4)
  voiceBlend: null,        // ses karıştırma (yalnızca Supertonic): { with: 'F1'…'M5', amount: 0…0.9 } | null
  genderVoices: true,      // konuşanın cinsiyetine göre kadın / erkek sesi (videonun sesinden perde ölçülür, content/gender.js)
  favFemale: null,         // favori kadın sesi ve tonu: { voice, style, pitch } | null (otomatik seçimde öncelikli)
  favMale: null,           // favori erkek sesi ve tonu
  glossaryMt: '',          // çeviri düzeltmeleri ("yanlış => doğru" satırları, common/glossary.js)
  glossaryTts: '',         // okunuşlar (yalnızca seslendirmeden önce)
  style: DEFAULT_STYLE,    // üslup: 'natural' | 'lively' | 'calm' (engines/tts/styles.js; sistem sesinde yok)
  pitch: 0,                // perde, yarım ton (−3…+3, adım 0.5); üslubun perdesine eklenir
  quality: DEFAULT_QUALITY, // 'fast' | 'high' (yüksek: 16 flow adımı, daha yavaş)
  originalVolume: 0.25,    // TTS sırasında orijinal ses çarpanı (0..1)
  ttsVolume: 1.0,          // TTS ses seviyesi (0..2)
  ttsSpeed: 1.0,           // temel TTS hızı (0.8..2.0)
  showSubtitles: true,     // Türkçe altyazı overlay'i
  lookaheadSec: 30,        // ileri-bakış penceresi
  holdStart: true,         // dublaj başlarken video, ilk cümlenin sesi hazır olana kadar bekletilir (en fazla 25 sn)
  fixAsrPunct: false,      // otomatik altyazıda çeviriden önce noktalama/büyük harf (isteğe bağlı model indirilince açılır)
  checkUpdates: true,      // günde iki kez sitedeki version.json'a bak (common/version.js)
});

export const LIMITS = Object.freeze({
  ttsSpeed: [0.8, 2.0],
  originalVolume: [0, 1],
  ttsVolume: [0, 2],
  maxFitSpeed: 1.6,
  speakerCount: [2, 4],
});

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Bilinmeyen anahtarları atar, türleri/aralıkları düzeltir.
export function normalizeSettings(raw = {}) {
  const s = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (raw[k] !== undefined) s[k] = raw[k];
  s.enabled = !!s.enabled;
  s.showSubtitles = !!s.showSubtitles;
  s.modelsApproved = !!s.modelsApproved;
  s.speakerVoices = !!s.speakerVoices;
  s.checkUpdates = !!s.checkUpdates;
  s.fixAsrPunct = !!s.fixAsrPunct;
  s.holdStart = !!s.holdStart;
  s.glossaryMt = String(s.glossaryMt ?? '').slice(0, 20000);
  s.glossaryTts = String(s.glossaryTts ?? '').slice(0, 20000);
  s.engineMode = s.engineMode === 'mock' ? 'mock' : 'real';
  s.style = normalizeStyle(s.style);
  s.pitch = normalizePitch(s.pitch);
  s.quality = normalizeQuality(s.quality);
  s.voiceBlend = normalizeBlend(s.voiceBlend);
  s.genderVoices = !!s.genderVoices;
  s.favFemale = normalizeFavorite(s.favFemale, 'female');
  s.favMale = normalizeFavorite(s.favMale, 'male');
  s.speakerCount = clamp(Math.round(Number(s.speakerCount)) || 2, ...LIMITS.speakerCount);
  s.ttsSpeed = clamp(Number(s.ttsSpeed) || 1, ...LIMITS.ttsSpeed);
  s.originalVolume = clamp(Number(s.originalVolume), ...LIMITS.originalVolume);
  if (!Number.isFinite(s.originalVolume)) s.originalVolume = DEFAULTS.originalVolume;
  s.ttsVolume = clamp(Number(s.ttsVolume), ...LIMITS.ttsVolume);
  if (!Number.isFinite(s.ttsVolume)) s.ttsVolume = DEFAULTS.ttsVolume;
  s.lookaheadSec = clamp(Number(s.lookaheadSec) || 30, 10, 120);
  return s;
}

/** Favori: { voice, style, pitch } ya da null. Katalogda cinsiyeti başka olan ses o cinsiyetin favorisi olamaz. */
export function normalizeFavorite(f, gender) {
  if (!f || typeof f !== 'object' || typeof f.voice !== 'string' || !f.voice || f.voice === 'system') return null;
  const def = voiceById(f.voice);
  if (def && def.gender !== gender) return null;
  return { voice: f.voice, style: normalizeStyle(f.style), pitch: normalizePitch(f.pitch) };
}

/** Bir sesin cinsiyeti: katalogdan, yoksa (test motoru) favori yuvasından; bilinmiyorsa null. */
export function voiceGender(s, id) {
  const def = voiceById(id);
  if (def) return def.gender === 'female' || def.gender === 'male' ? def.gender : null;
  if (s.favFemale?.voice === id) return 'female';
  if (s.favMale?.voice === id) return 'male';
  return null;
}

// Konuşmacı sesleri. Kendiliğinden seçimde önce karşıt cinsiyet, sonra aynı cinsiyetten başka bir ses gelir;
// Supertonic hazır sesinde aynı paketin diğer sesleri (ek indirme yok), küçük seslerde diğer küçük sesler.
const SMALL_VOICES = ['antalia-mini', 'ahenk-cep', 'ema-lightning'];

function autoVoices(primary) {
  const def = voiceById(primary);
  const pool = def?.pack
    ? VOICES.filter((v) => v.pack === def.pack && v.id !== primary)
    : SMALL_VOICES.filter((id) => id !== primary).map(voiceById);
  const gender = def?.gender || 'male';
  const opposite = pool.filter((v) => v.gender !== gender);
  const same = pool.filter((v) => v.gender === gender);
  const out = [];
  for (let i = 0; i < Math.max(opposite.length, same.length); i++) {
    if (opposite[i]) out.push(opposite[i].id);
    if (same[i]) out.push(same[i].id);
  }
  return out;
}

/** n. konuşmacının sesi (0 = birinci ses). Seçilmemiş ya da önceki seslerden biriyle aynı seçilmişse kendiliğinden. */
export function speakerVoice(s, n) {
  const primary = s.voice || DEFAULT_VOICE;
  const explicit = [null, s.voice2, s.voice3, s.voice4];
  const chosen = [primary];
  const auto = autoVoices(primary);
  for (let i = 1; i <= n; i++) {
    const want = explicit[i];
    const next = want && !chosen.includes(want) ? want : auto.find((id) => !chosen.includes(id));
    chosen.push(next || chosen[i % chosen.length]);
  }
  return chosen[n];
}

// İkinci konuşmacının varsayılan sesi: birinci ses kadınsa erkek, değilse kadın.
export const secondVoice = (s) => speakerVoice(s, 1);

// Cümleyi seslendirecek ses (undefined → motorun varsayılanı). Sistem sesinde konuşmacı ayrımı yapılmaz.
// speaker: altyazıdaki konuşmacı değişimi sayacı (captions.js); ses = sayaç mod speakerCount.
export function voiceForSpeaker(s, speaker) {
  const n = s.speakerVoices && speaker ? speaker % s.speakerCount : 0;
  if (!n || s.voice === 'system') return s.voice || undefined;
  if (s.engineMode === 'mock') return [s.voice, s.voice2, s.voice3, s.voice4][n] || s.voice || undefined; // test motorunda gerçek ses adları yok
  return speakerVoice(s, n);
}

/**
 * Bir cinsiyetin sesleri, öncelik sırasıyla: favori → birinci ses (o cinsiyettense) → kendiliğinden seçilenler
 * (Supertonic'te aynı paket, küçük seslerde Antalia ↔ Ahenk/EMA). Test motorunda yalnızca favori (cinsiyet bilgisi yok).
 */
export function genderVoiceList(s, gender) {
  const primary = s.voice || DEFAULT_VOICE;
  const fav = gender === 'female' ? s.favFemale : s.favMale;
  const out = [];
  if (fav) out.push(fav.voice);
  if (s.engineMode !== 'mock') {
    if (voiceGender(s, primary) === gender) out.push(primary);
    for (const id of autoVoices(primary)) if (voiceGender(s, id) === gender) out.push(id);
  }
  return [...new Set(out)];
}

/** O cinsiyetin `alt`. sesi (sırayla modunda aynı cinsiyetten ikinci konuşmacı için 1); yoksa undefined. */
export function genderVoice(s, gender, alt = 0) {
  const list = genderVoiceList(s, gender);
  return list.length ? list[alt % list.length] : undefined;
}

/**
 * Cümlenin sesi. Cinsiyet modu açıksa ve cinsiyet tahmini varsa o cinsiyetin sesi (favori öncelikli); yoksa konuşmacı
 * sırasına göre (voiceForSpeaker). alt: aynı cinsiyetten farklı konuşmacı (sırayla modunda).
 */
export function chooseVoice(s, { speaker, gender, alt = 0 } = {}) {
  if (s.voice === 'system') return 'system';
  if (s.genderVoices && gender) {
    const v = genderVoice(s, gender, s.speakerVoices ? alt : 0);
    if (v) return v;
  }
  return voiceForSpeaker(s, speaker);
}

/** Cümlenin tonu: ses favoriyse favorinin üslubu ve perdesi, değilse genel ayar (kalite ve karıştırma ortak). */
export function toneFor(s, voice) {
  const fav = [s.favFemale, s.favMale].find((f) => f && f.voice === voice);
  const base = fav || s;
  return normalizeTone({ style: base.style, pitch: base.pitch, quality: s.quality, blend: s.voiceBlend });
}

/** Seçili ayarlarla konuşabilecek bütün sesler (indirme denetimi için): birinci ses + açıksa konuşmacı ve cinsiyet sesleri. */
export function voicesInUse(s) {
  const out = [s.voice || DEFAULT_VOICE];
  if (s.voice === 'system' || s.engineMode === 'mock') return out;
  if (s.speakerVoices) for (let n = 1; n < s.speakerCount; n++) out.push(speakerVoice(s, n));
  if (s.genderVoices) {
    for (const g of ['female', 'male']) {
      out.push(genderVoice(s, g));
      if (s.speakerVoices) out.push(genderVoice(s, g, 1));
    }
  }
  return [...new Set(out.filter(Boolean))];
}

export async function getSettings() {
  const raw = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return normalizeSettings(raw);
}

export async function setSettings(patch) {
  await chrome.storage.local.set(patch);
}

// Değişiklikleri dinler; callback(yeniAyarlar, değişenAnahtarlar). Aboneliği kaldıran fonksiyon döner.
export function onSettingsChanged(callback) {
  const fn = async (changes, area) => {
    if (area !== 'local') return;
    const keys = Object.keys(changes).filter((k) => k in DEFAULTS);
    if (!keys.length) return;
    callback(await getSettings(), keys);
  };
  chrome.storage.onChanged.addListener(fn);
  return () => chrome.storage.onChanged.removeListener(fn);
}
