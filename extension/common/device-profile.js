// Cihaz profili (saf; DOM/chrome yok). Docs/V1-PLAN.md §5. Profil bir ayar değil, ayarlar için BAŞLANGIÇ değerleri kümesidir:
// kullanıcı profili seçince ayarlar sayfası profileDefaults değerlerini ayarlara yazar; sonra her biri elle değiştirilebilir.
// NOT: tabloda TOPLU BOYUT ve HIZ SINIRI yoktur. Gerçek hız ölçümleri henüz yok; ölçülmemiş değer ölçülmüş gibi yazılmaz.
// rtx ve apple değerleri bugünkü varsayılanlarla aynıdır; hiçbir GPU zamanlama parametresi bu dosyada değişmez.

export const PROFILE_IDS = Object.freeze(['rtx', 'apple', 'igpu', 'cpu']);

export const PROFILES = Object.freeze({
  rtx: Object.freeze({ id: 'rtx', label: 'Ayrı ekran kartı (NVIDIA/AMD)', hint: 'Harici NVIDIA, AMD, Intel Arc', sepQuality: 'high', prebufferSec: 20, lookaheadSec: 30, fullSpeed: false }),
  apple: Object.freeze({ id: 'apple', label: 'Apple Silicon', hint: 'M1–M4', sepQuality: 'high', prebufferSec: 20, lookaheadSec: 30, fullSpeed: false }),
  igpu: Object.freeze({ id: 'igpu', label: 'Dahili ekran kartı', hint: 'Intel, tanınmayan kart', sepQuality: 'fast', prebufferSec: 30, lookaheadSec: 45, fullSpeed: false }),
  cpu: Object.freeze({ id: 'cpu', label: 'Yalnız işlemci', hint: 'WebGPU yok', sepQuality: 'fast', prebufferSec: 45, lookaheadSec: 60, fullSpeed: false }),
});

/** 'auto' | profil kimliği; geçersiz → 'auto'. */
export const normalizeDeviceProfile = (v) => (PROFILE_IDS.includes(v) ? v : 'auto');

/** Adaptör özeti ("nvidia ada lovelace") → profil kimliği. Belirsizse güvenli taraf: 'igpu'. */
export function detectProfile({ adapter } = {}) {
  if (!adapter) return 'cpu';
  const a = String(adapter).toLowerCase();
  if (/apple/.test(a)) return 'apple';
  if (/nvidia|amd|radeon|\barc\b/.test(a)) return 'rtx';
  return 'igpu';
}

/** Ayar ('auto' ya da kimlik) + ortam → { id, auto, ...PROFILES[id] }. */
export function resolveProfile(setting, env = {}) {
  const s = normalizeDeviceProfile(setting);
  const auto = s === 'auto';
  const id = auto ? detectProfile(env) : s;
  return { id, auto, ...PROFILES[id] };
}

/** Profil seçilince ayarlara yazılacak değerler. */
export function profileDefaults(id) {
  const p = PROFILES[id] || PROFILES.igpu;
  return { sepQuality: p.sepQuality, prebufferSec: p.prebufferSec, lookaheadSec: p.lookaheadSec };
}
