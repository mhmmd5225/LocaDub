import test from 'node:test';
import assert from 'node:assert/strict';
import { pickAdapter, describeAdapter, probeGpuPreferences, normalizeGpuPreference, integratedHint } from '../../extension/common/gpu.js';
import { createSeparator } from '../../extension/engines/sep/separator.js';
import { SEP_MODELS } from '../../extension/engines/sep/models.js';
import { normalizeSettings } from '../../extension/common/settings.js';
import { separationLines } from '../../extension/common/diagnostics.js';

const nv = { info: { vendor: 'nvidia', architecture: 'ada', description: 'RTX' } };
const intel = { info: { vendor: 'intel', architecture: 'gen-12lp', description: '' } };
// hibrit dizüstü: tercihsiz istek dahili kartı, high-performance harici kartı verir
const hybrid = () => {
  const calls = [];
  return { calls, requestAdapter: async (o) => { calls.push(o?.powerPreference); return o?.powerPreference === 'high-performance' ? nv : intel; } };
};

test('pickAdapter: tercih iletilir, başarısızsa tercihsiz denenir', async () => {
  const g = hybrid();
  assert.equal(await pickAdapter('high-performance', g), nv);
  assert.equal(await pickAdapter('low-power', g), intel);
  assert.deepEqual(g.calls, ['high-performance', 'low-power']);
  let n = 0;
  const flaky = { requestAdapter: async (o) => (o ? null : (n++, intel)) };
  assert.equal(await pickAdapter('high-performance', flaky), intel);
  assert.equal(await pickAdapter('x', undefined), null);
});

test('describeAdapter / probeGpuPreferences / normalize', async () => {
  assert.equal(describeAdapter(nv), 'nvidia ada RTX');
  assert.equal(describeAdapter({}), 'bilinmiyor');
  assert.deepEqual(await probeGpuPreferences(hybrid()), { high: 'nvidia ada RTX', low: 'intel gen-12lp', same: false });
  const single = { requestAdapter: async () => intel };
  assert.equal((await probeGpuPreferences(single)).same, true);
  assert.equal((await probeGpuPreferences(undefined)).high, null);
  assert.equal(normalizeGpuPreference('x'), 'high-performance');
  assert.equal(normalizeSettings({ gpuPreference: 'low-power' }).gpuPreference, 'low-power');
  assert.equal(normalizeSettings({}).gpuPreference, 'high-performance');
});

test('Ayırıcı: seçilen adaptör ORT env.webgpu.adapter olarak verilir (hibrit dizüstü)', async () => {
  const g = hybrid();
  const nav = globalThis.navigator;
  const had = Object.getOwnPropertyDescriptor(nav, 'gpu');
  Object.defineProperty(nav, 'gpu', { value: g, configurable: true });
  try {
    const env = { webgpu: {}, wasm: {} };
    const ort = {
      env, Tensor: class {},
      InferenceSession: { create: async () => ({ inputNames: ['i'], outputNames: ['o'], run: async (f) => ({ o: Object.values(f)[0] }) }) },
    };
    const fetchModel = async (url) => new ArrayBuffer(SEP_MODELS.find((x) => x.url === url).bytes);
    const hi = createSeparator({ model: 'kim-vocal-2', backend: 'auto', ort, fetchModel });
    await hi.load();
    assert.equal(env.webgpu.adapter, nv);
    assert.equal(env.webgpu.powerPreference, 'high-performance');
    assert.equal(hi.adapter, 'nvidia ada RTX');
    const lo = createSeparator({ model: 'kim-vocal-2', backend: 'auto', gpuPreference: 'low-power', ort, fetchModel });
    await lo.load();
    assert.equal(env.webgpu.adapter, intel);
    assert.equal(lo.adapter, 'intel gen-12lp');
  } finally { if (had) Object.defineProperty(nav, 'gpu', had); else delete nav.gpu; }
});

test('Rapor: yavaş Intel kartta hibrit GPU uyarısı', () => {
  assert.equal(integratedHint('intel gen-12lp', 2.4), true);
  assert.equal(integratedHint('nvidia ada', 2.4), false);
  assert.equal(integratedHint('intel xe', 0.5), false);
  const l = separationLines({ status: 'playing', backend: 'webgpu', model: 'm', rtf: 2.4, gpuAdapter: 'intel gen-12lp' });
  assert.ok(l.some((x) => /^uyarı: Intel ekran kartı.*Yüksek performans/.test(x)), l.join('\n'));
  assert.ok(!separationLines({ status: 'playing', backend: 'webgpu', model: 'm', rtf: 0.5, gpuAdapter: 'nvidia' }).some((x) => /^uyarı:/.test(x)));
});
