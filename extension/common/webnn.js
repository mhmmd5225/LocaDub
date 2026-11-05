// Deneysel WebNN (NPU) desteği: algılama ve ayar eşlemesi (saf; node testleriyle sınanır).
// WebNN Chrome'da çoğu sürümde chrome://flags/#web-machine-learning-neural-network bayrağı ister; NPU desteği sürücüye bağlıdır.

/** sepBackend ayarı → { kind: 'auto'|'webgpu'|'wasm'|'webnn', deviceType?: 'npu' } */
export function backendChoice(v) {
  if (v === 'webnn-npu') return { kind: 'webnn', deviceType: 'npu' };
  if (v === 'webgpu' || v === 'wasm') return { kind: v };
  return { kind: 'auto' };
}

export const normalizeSepBackend = (v) => (['auto', 'webgpu', 'webnn-npu', 'wasm'].includes(v) ? v : 'auto');

/**
 * navigator.ml üzerinden istenen aygıtta bağlam kurulabiliyor mu? → { ok, deviceType, reason? }
 * Bağlam kurulumu hata verirse ya da navigator.ml yoksa ok:false ve nedeni döner (asla fırlatmaz).
 */
export async function probeWebNN(deviceType = 'npu', nav = globalThis.navigator) {
  const ml = nav?.ml;
  if (!ml || typeof ml.createContext !== 'function') {
    return { ok: false, deviceType, reason: 'WebNN yok (Chrome\'da chrome://flags/#web-machine-learning-neural-network bayrağını açın)' };
  }
  try {
    const ctx = await ml.createContext({ deviceType });
    if (!ctx) return { ok: false, deviceType, reason: `WebNN ${deviceType} bağlamı kurulamadı` };
    return { ok: true, deviceType };
  } catch (e) {
    return { ok: false, deviceType, reason: `WebNN ${deviceType} bağlamı kurulamadı: ${String(e?.message || e).slice(0, 140)}` };
  }
}

/** ort oturumu için yürütme sağlayıcısı girdisi. */
export const webnnProvider = (deviceType = 'npu') => ({ name: 'webnn', deviceType, powerPreference: 'default' });

/** NPU, GPU ve CPU için ayrı ayrı bağlam dener (tanılama: hangisi sunuluyor?) → { npu, gpu, cpu } her biri { ok, reason? }. */
export async function probeWebNNAll(nav = globalThis.navigator) {
  const out = {};
  for (const d of ['npu', 'gpu', 'cpu']) {
    const r = await probeWebNN(d, nav);
    out[d] = r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }
  return out;
}

export function formatProbeAll(all) {
  return ['npu', 'gpu', 'cpu'].map((d) => `${d.toUpperCase()}: ${all[d]?.ok ? 'tamam' : (all[d]?.reason || 'yok')}`).join(' · ');
}
