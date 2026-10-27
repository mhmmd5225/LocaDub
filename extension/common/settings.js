// Ortak ayarlar: varsayılanlar + chrome.storage.local yardımcıları.

export const DEFAULTS = Object.freeze({
  enabled: false,          // dublaj açık mı (TR düğmesi / popup)
  engineMode: 'real',      // 'real' | 'mock' (test motoru)
  modelsApproved: false,   // kullanıcı model indirmeyi onayladı mı
  mtBackend: null,         // null → motorun varsayılanı
  voice: null,             // null → motorun varsayılanı; 'system' → chrome.tts
  systemVoiceName: null,   // chrome.tts ses adı (isteğe bağlı)
  speakerVoices: false,    // konuşmacı değişince (>>) ikinci sesle konuş
  voice2: null,            // ikinci ses; null → birinci sesin karşıt cinsiyetlisi
  glossaryMt: '',          // çeviri düzeltmeleri ("yanlış => doğru" satırları, common/glossary.js)
  glossaryTts: '',         // okunuşlar (yalnızca seslendirmeden önce)
  originalVolume: 0.25,    // TTS sırasında orijinal ses çarpanı (0..1)
  ttsVolume: 1.0,          // TTS ses seviyesi (0..2)
  ttsSpeed: 1.0,           // temel TTS hızı (0.8..2.0)
  showSubtitles: true,     // Türkçe altyazı overlay'i
  lookaheadSec: 30,        // ileri-bakış penceresi
  fixAsrPunct: false,      // otomatik altyazıda çeviriden önce noktalama/büyük harf (isteğe bağlı model indirilince açılır)
  checkUpdates: true,      // günde iki kez sitedeki version.json'a bak (common/version.js)
});

export const LIMITS = Object.freeze({
  ttsSpeed: [0.8, 2.0],
  originalVolume: [0, 1],
  ttsVolume: [0, 2],
  maxFitSpeed: 1.6,
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
  s.glossaryMt = String(s.glossaryMt ?? '').slice(0, 20000);
  s.glossaryTts = String(s.glossaryTts ?? '').slice(0, 20000);
  s.engineMode = s.engineMode === 'mock' ? 'mock' : 'real';
  s.ttsSpeed = clamp(Number(s.ttsSpeed) || 1, ...LIMITS.ttsSpeed);
  s.originalVolume = clamp(Number(s.originalVolume), ...LIMITS.originalVolume);
  if (!Number.isFinite(s.originalVolume)) s.originalVolume = DEFAULTS.originalVolume;
  s.ttsVolume = clamp(Number(s.ttsVolume), ...LIMITS.ttsVolume);
  if (!Number.isFinite(s.ttsVolume)) s.ttsVolume = DEFAULTS.ttsVolume;
  s.lookaheadSec = clamp(Number(s.lookaheadSec) || 30, 10, 120);
  return s;
}

// İkinci konuşmacının varsayılan sesi: birinci ses kadınsa erkek, değilse kadın.
const FEMALE = 'ahenk-cep';
const MALE = 'antalia-mini';
export function secondVoice(s) {
  if (s.voice2 && s.voice2 !== s.voice) return s.voice2;
  return s.voice === FEMALE ? MALE : FEMALE;
}

// Cümleyi seslendirecek ses (undefined → motorun varsayılanı). Sistem sesinde konuşmacı ayrımı yapılmaz.
export function voiceForSpeaker(s, speaker) {
  if (!s.speakerVoices || !speaker || s.voice === 'system') return s.voice || undefined;
  if (s.engineMode === 'mock' && !s.voice2) return s.voice || undefined; // test motorunda gerçek ses adları yok
  return secondVoice(s);
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
