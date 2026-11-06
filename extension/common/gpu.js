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
