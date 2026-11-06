import test from 'node:test';
import assert from 'node:assert/strict';
import { pickAdapter, describeAdapter, probeGpuPreferences, normalizeGpuPreference, integratedHint, shouldAutoPick, chooseFaster, autoPickKey, cachedPick, AUTO_PICK_DAYS } from '../../extension/common/gpu.js';
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
  assert.ok(l.some((x) => /^uyarı: Intel ekran kartı.*force-high-performance-gpu/.test(x)), l.join('\n'));
  assert.ok(!separationLines({ status: 'playing', backend: 'webgpu', model: 'm', rtf: 0.5, gpuAdapter: 'nvidia' }).some((x) => /^uyarı:/.test(x)));
});

test('otomatik kart seçimi: yardımcılar', () => {
  assert.equal(shouldAutoPick('intel gen-12lp', true), true);
  assert.equal(shouldAutoPick('intel gen-12lp', false), false);
  assert.equal(shouldAutoPick('nvidia ada', true), false);
  assert.equal(chooseFaster({ webgpu: 1600, webnn: 400 }), 'webnn');
  assert.equal(chooseFaster({ webgpu: 1600, webnn: 1500 }), 'webgpu'); // %15'ten az fark: gürültü sayılır
  assert.equal(chooseFaster({ webgpu: 1600, webnn: null }), 'webgpu');
  const key = autoPickKey('auto', 'Mozilla/5.0 Chrome/156.0.8078.80 Safari');
  assert.equal(key, 'auto|chrome 156');
  const now = 1e12;
  assert.equal(cachedPick({ key, backend: 'webnn', at: now - 1000 }, key, now), 'webnn');
  assert.equal(cachedPick({ key, backend: 'webnn', at: now - (AUTO_PICK_DAYS + 1) * 86400000 }, key, now), null);
  assert.equal(cachedPick({ key: 'auto|chrome 155', backend: 'webnn', at: now }, key, now), null);
  assert.equal(cachedPick(null, key, now), null);
});

// sahte ort: oturum süreleri sağlayıcıya göre; WebNN GPU daha hızlı ya da kurulamıyor
function autoEnv({ nnMs, nnFails = false, intelOnly = true }) {
  const created = [];
  let clock = 0;
  const realNow = performance.now;
  const ort = {
    env: { webgpu: {}, wasm: {} }, Tensor: class { constructor(t, d, dims) { this.data = d; this.dims = dims; } },
    InferenceSession: {
      async create(bytes, so) {
        const ep = so.executionProviders[0];
        created.push(ep);
        if (ep?.name === 'webnn' && nnFails) throw new Error('Conv desteklenmiyor');
        const ms = ep?.name === 'webnn' ? nnMs : 1600;
        return { inputNames: ['i'], outputNames: ['o'], released: false, async release() { this.released = true; },
          async run(f) { clock += ms; return { o: Object.values(f)[0] }; } };
      },
    },
  };
  const gpu = { requestAdapter: async () => ({ info: { vendor: intelOnly ? 'intel' : 'nvidia', architecture: intelOnly ? 'gen-12lp' : 'ada' } }) };
  return { ort, created, gpu, now: () => clock, realNow };
}

async function withNav(gpu, ml, fn) {
  const nav = globalThis.navigator;
  const save = ['gpu', 'ml'].map((k) => [k, Object.getOwnPropertyDescriptor(nav, k)]);
  Object.defineProperty(nav, 'gpu', { value: gpu, configurable: true });
  Object.defineProperty(nav, 'ml', { value: ml, configurable: true });
  try { return await fn(); } finally { for (const [k, d] of save) { if (d) Object.defineProperty(nav, k, d); else delete nav[k]; } }
}

async function runAuto(e, extra = {}) {
  const orig = performance.now;
  performance.now = e.now;
  try {
    const fetchModel = async (url) => new ArrayBuffer(SEP_MODELS.find((x) => x.url === url).bytes);
    const sep = createSeparator({ model: 'kim-vocal-2', backend: 'auto', ort: e.ort, fetchModel, ...extra });
    const r = await sep.load();
    return { r, sep };
  } finally { performance.now = orig; }
}

test('Ayırıcı: Intel kartta WebNN-GPU daha hızlıysa otomatik seçilir', async () => {
  const e = autoEnv({ nnMs: 300 });
  await withNav(e.gpu, { createContext: async () => ({}) }, async () => {
    const { r, sep } = await runAuto(e);
    assert.equal(r.backend, 'webnn');
    assert.equal(sep.autoPick.chosen, 'webnn');
    assert.equal(sep.autoPick.webgpu, 1600);
    assert.equal(sep.autoPick.webnn, 300);
    assert.deepEqual(e.created.at(-1), { name: 'webnn', deviceType: 'gpu', powerPreference: 'high-performance' });
  });
});

test('Ayırıcı: WebNN-GPU kurulamazsa WebGPU kalır; NVIDIA kartta hiç ölçülmez; önbellek kararı ölçmeden uygulanır', async () => {
  const e1 = autoEnv({ nnMs: 300, nnFails: true });
  await withNav(e1.gpu, { createContext: async () => ({}) }, async () => {
    const { r, sep } = await runAuto(e1);
    assert.equal(r.backend, 'webgpu');
    assert.match(sep.autoPick.reason, /WebNN-GPU kurulamadı: Conv/);
  });
  const e2 = autoEnv({ nnMs: 300, intelOnly: false });
  await withNav(e2.gpu, { createContext: async () => ({}) }, async () => {
    const { r, sep } = await runAuto(e2);
    assert.equal(r.backend, 'webgpu');
    assert.equal(sep.autoPick, null);
    assert.deepEqual(e2.created, ['webgpu']);
  });
  const e3 = autoEnv({ nnMs: 300 });
  await withNav(e3.gpu, { createContext: async () => ({}) }, async () => {
    const { r, sep } = await runAuto(e3, { preferBackend: 'webnn' });
    assert.equal(r.backend, 'webnn');
    assert.deepEqual(sep.autoPick, { chosen: 'webnn', cached: true });
    assert.equal(e3.created.length, 1); // WebGPU hiç kurulmadı
  });
});

test('Rapor: otomatik kart seçimi satırı', () => {
  const l = separationLines({ status: 'playing', backend: 'webnn', model: 'm', autoPick: { webgpu: 1600, webnn: 300, chosen: 'webnn' } });
  assert.ok(l.some((x) => x === 'otomatik kart seçimi: WebNN-GPU (harici kart olabilir) (WebGPU 1600 ms/pencere · WebNN-GPU 300 ms/pencere)'), l.join('\n'));
});
