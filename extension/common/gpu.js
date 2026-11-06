// WebGPU adaptör seçimi (saf yardımcılar; sahte navigator.gpu ile node testleri). WebGPU adaptörleri adla listelemez:
// yalnız iki tercih vardır ('high-performance' = harici kart, 'low-power' = dahili kart). Hibrit dizüstünde ORT kendi
// requestAdapter() çağrısını tercihsiz yapınca dahili kart gelir; bu yüzden adaptörü biz seçip ORT'ye veririz (env.webgpu.adapter).

export const normalizeGpuPreference = (v) => (v === 'low-power' ? 'low-power' : 'high-performance');

/** adapter.info → "nvidia ada lovelace" biçiminde kısa özet (yoksa 'bilinmiyor'). */
export function describeAdapter(a) {
  const i = a?.info || {};
  return [i.vendor, i.architecture, i.description].filter(Boolean).join(' ').slice(0, 120) || 'bilinmiyor';
}

/** Tercihe göre adaptör ister; olmazsa tercihsiz dener. Asla fırlatmaz; yoksa null. */
export async function pickAdapter(pref = 'high-performance', gpu = globalThis.navigator?.gpu) {
  if (!gpu) return null;
  const a = await gpu.requestAdapter({ powerPreference: normalizeGpuPreference(pref) }).catch(() => null);
  return a || (await gpu.requestAdapter().catch(() => null));
}

/** İki tercihin hangi kartı verdiği (ayarlar sayfası): { high, low, same }. */
export async function probeGpuPreferences(gpu = globalThis.navigator?.gpu) {
  const one = async (p) => { const a = gpu ? await gpu.requestAdapter({ powerPreference: p }).catch(() => null) : null; return a ? describeAdapter(a) : null; };
  const high = await one('high-performance'), low = await one('low-power');
  return { high, low, same: !!high && high === low };
}

/** Rapor/panel: Intel kart kullanılıyor ve ayırma yetişemiyorsa hibrit GPU ipucu. */
export const integratedHint = (adapter, rtf) => /intel/i.test(String(adapter || '')) && rtf > 1.2;

// ---------- hibrit dizüstü: otomatik kart seçimi ----------
// Chrome Windows'ta WebGPU powerPreference'ı yok sayar (crbug 369219127): tüm tarayıcı tek kartta (genelde dahili Intel).
// WebNN ise Chrome'un WebGPU adaptöründen bağımsız cihaz seçer (Windows ML harici kartı tercih eder); bu yüzden Intel kartta
// WebGPU ile WebNN-GPU kısa ölçümle karşılaştırılır, hızlı olan kullanılır. Karar önbelleğe alınır (AUTO_PICK_DAYS).

export const AUTO_PICK_DAYS = 14;

/** Otomatik karşılaştırma yapılsın mı: WebGPU kartı Intel ve WebNN var. */
export const shouldAutoPick = (adapter, hasMl) => !!hasMl && /intel/i.test(String(adapter || ''));

/** { webgpu: ms, webnn: ms|null } → 'webnn' | 'webgpu'. WebNN ancak %15'ten fazla hızlıysa seçilir (ölçüm gürültüsü). */
export function chooseFaster({ webgpu, webnn }) {
  if (!(webnn > 0)) return 'webgpu';
  if (!(webgpu > 0)) return 'webnn';
  return webnn < webgpu * 0.85 ? 'webnn' : 'webgpu';
}

/** Önbellek anahtarı: kart özeti + Chrome ana sürümü (sürücü/Chrome değişince yeniden ölçülür). */
export function autoPickKey(adapter, ua = globalThis.navigator?.userAgent || '') {
  const v = /Chrome\/(\d+)/.exec(ua)?.[1] || '?';
  return `${String(adapter || '?')}|chrome ${v}`;
}

/** Önbellekteki karar geçerli mi → 'webnn' | 'webgpu' | null. */
export function cachedPick(entry, key, now = Date.now()) {
  if (!entry || entry.key !== key || !(now - entry.at < AUTO_PICK_DAYS * 86400000)) return null;
  return entry.backend === 'webnn' || entry.backend === 'webgpu' ? entry.backend : null;
}
