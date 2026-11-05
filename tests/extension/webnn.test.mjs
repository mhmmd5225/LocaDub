import test from 'node:test';
import assert from 'node:assert/strict';
import { probeWebNNAll, formatProbeAll, probeWebNN, backendChoice, normalizeSepBackend, webnnProvider } from '../../extension/common/webnn.js';
import { createSeparator } from '../../extension/engines/sep/separator.js';
import { SEP_MODELS, sepModelById } from '../../extension/engines/sep/models.js';
import { normalizeSettings } from '../../extension/common/settings.js';
import { separationLines } from '../../extension/common/diagnostics.js';
import { formatBench } from '../../extension/common/bench.js';

test('probeWebNN: yok / bağlam kurulamıyor / başarılı', async () => {
  assert.equal((await probeWebNN('npu', {})).ok, false);
  assert.match((await probeWebNN('npu', {})).reason, /bayrağını/);
  const bad = { ml: { createContext: async () => { throw new Error('NPU yok'); } } };
  const r = await probeWebNN('npu', bad);
  assert.equal(r.ok, false);
  assert.match(r.reason, /NPU yok/);
  assert.deepEqual(await probeWebNN('npu', { ml: { createContext: async (o) => ({ o }) } }), { ok: true, deviceType: 'npu' });
});

test('ayar eşlemesi ve doğrulama', () => {
  assert.deepEqual(backendChoice('webnn-npu'), { kind: 'webnn', deviceType: 'npu' });
  assert.deepEqual(backendChoice('wasm'), { kind: 'wasm' });
  assert.deepEqual(backendChoice('saçma'), { kind: 'auto' });
  assert.equal(normalizeSepBackend('saçma'), 'auto');
  assert.equal(normalizeSettings({ sepBackend: 'webnn-npu' }).sepBackend, 'webnn-npu');
  assert.equal(normalizeSettings({}).sepBackend, 'auto');
  assert.deepEqual(webnnProvider('npu'), { name: 'webnn', deviceType: 'npu', powerPreference: 'default' });
});

// sahte oturum: identity benzeri; yalnız load/warmUp yolunu sınar
const model = sepModelById('kim-vocal-2');
const fetchModel = async (url) => new ArrayBuffer(SEP_MODELS.find((x) => x.url === url).bytes);
function fakeOrtWith(createImpl) {
  const created = [];
  return {
    created,
    ort: {
      Tensor: class { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } },
      InferenceSession: {
        async create(bytes, so) {
          created.push(so);
          return createImpl(so, created.length);
        },
      },
    },
  };
}
const okSession = () => ({ inputNames: ['input'], outputNames: ['output'], async run(feeds) { return { output: Object.values(feeds)[0] }; } });

async function withMl(ml, fn) {
  const nav = globalThis.navigator;
  const had = Object.getOwnPropertyDescriptor(nav, 'ml');
  Object.defineProperty(nav, 'ml', { value: ml, configurable: true });
  try { return await fn(); } finally { if (had) Object.defineProperty(nav, 'ml', had); else delete nav.ml; }
}

test('Ayırıcı: WebNN NPU oturumu kurulursa webnn kullanılır', async () => {
  const { ort, created } = fakeOrtWith(() => okSession());
  await withMl({ createContext: async () => ({}) }, async () => {
    const sep = createSeparator({ model: 'kim-vocal-2', backend: 'webnn', webnnDevice: 'npu', ort, fetchModel });
    const r = await sep.load();
    assert.equal(r.backend, 'webnn');
    assert.equal(r.batch, 1);
    assert.deepEqual(created[0].executionProviders, [{ name: 'webnn', deviceType: 'npu', powerPreference: 'default' }]);
    assert.equal(sep.adapter, 'WebNN npu');
  });
});

test('Ayırıcı: WebNN oturumu hata verirse WASM yedeği ve neden', async () => {
  const { ort, created } = fakeOrtWith((so) => {
    if (so.executionProviders[0]?.name === 'webnn') throw new Error('desteklenmeyen işlem: STFT');
    return okSession();
  });
  await withMl({ createContext: async () => ({}) }, async () => {
    const sep = createSeparator({ model: 'auto', backend: 'webnn', webnnDevice: 'npu', ort, fetchModel });
    const r = await sep.load();
    assert.equal(r.backend, 'wasm');
    assert.match(sep.fallbackReason, /WebNN \(npu\) kurulamadı.*STFT/);
    assert.equal(created.length, 2);
    assert.deepEqual(created[1].executionProviders, ['wasm']);
  });
});

test('Ayırıcı: WebNN yoksa (bayrak kapalı) hiç denenmez, neden yazılır', async () => {
  const { ort, created } = fakeOrtWith(() => okSession());
  await withMl(undefined, async () => {
    const sep = createSeparator({ model: 'auto', backend: 'webnn', webnnDevice: 'npu', ort, fetchModel });
    const r = await sep.load();
    assert.equal(r.backend, 'wasm');
    assert.match(sep.fallbackReason, /WebNN yok/);
    assert.deepEqual(created.map((c) => c.executionProviders), [['wasm']]);
  });
});

test('Hız testi çıktısı: WebNN satırı', () => {
  const base = { sep: { runs: [] }, tts: null, mt: null };
  const line = (x) => formatBench({ ...base, sepNpu: { runs: [x] } }).find((l) => l.includes('WebNN'));
  assert.match(line({ backend: 'webnn', rtf: 0.5, loadMs: 2000 }), /0\.50 rtf \(2\.0× gerçek zaman\)/);
  assert.match(line({ backend: 'wasm', fallbackReason: 'WebNN yok' }), /kullanılamadı, wasm çalıştı \(WebNN yok\)/);
  assert.match(line({ error: 'x' }), /hata — x/);
});

test('probeWebNNAll: NPU hata, GPU/CPU tamam', async () => {
  const nav = { ml: { createContext: async ({ deviceType }) => { if (deviceType === 'npu') throw new Error('NPU sunulmuyor'); return {}; } } };
  const all = await probeWebNNAll(nav);
  assert.equal(all.npu.ok, false);
  assert.equal(all.gpu.ok, true);
  assert.match(formatProbeAll(all), /NPU: .*NPU sunulmuyor · GPU: tamam · CPU: tamam/);
});

test('Ayırıcı: WebNN yedeğe düşünce webnn bilgisi adımı ve nedeni verir; rapora girer', async () => {
  const { ort } = fakeOrtWith((so) => { if (so.executionProviders[0]?.name === 'webnn') throw new Error('Conv desteklenmiyor'); return okSession(); });
  await withMl({ createContext: async () => ({}) }, async () => {
    const sep = createSeparator({ model: 'auto', backend: 'webnn', webnnDevice: 'npu', ort, fetchModel });
    await sep.load();
    assert.deepEqual({ ...sep.webnn }, { requested: true, used: false, device: 'npu', step: 'oturum', reason: 'Conv desteklenmiyor' });
    const lines = separationLines({ status: 'playing', backend: 'wasm', model: 'x', webnn: sep.webnn });
    assert.ok(lines.some((l) => /webnn \(npu\): kullanılamadı \(oturum adımı\) — Conv desteklenmiyor/.test(l)), lines.join('\n'));
  });
  await withMl(undefined, async () => {
    const { ort: o2 } = fakeOrtWith(() => okSession());
    const sep = createSeparator({ model: 'auto', backend: 'webnn', ort: o2, fetchModel });
    await sep.load();
    assert.equal(sep.webnn.step, 'bağlam');
  });
});
