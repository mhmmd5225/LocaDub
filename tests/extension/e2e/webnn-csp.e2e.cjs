// WebNN oturumu eklenti CSP'si altında kurulabilmeli (lib/ort/ort-wasm-simd-threaded.jsep.mjs yaması: eval'siz method caller).
// Gerçek NPU gerekmez: Chromium'un WebNN 'cpu' bağlamı kullanılır; WebNN yoksa test atlanır.
//   xvfb-run -a node tests/extension/e2e/webnn-csp.e2e.cjs
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { launch } = require('./common.cjs');

(async () => {
  const { ctx, opt } = await launch({ extraArgs: ['--enable-features=WebMachineLearningNeuralNetwork'] });
  try {
    const model = Array.from(fs.readFileSync(path.resolve(__dirname, '../fixtures/add.onnx')));
    const r = await opt.evaluate(async (bytes) => {
      if (!navigator.ml) return { skip: 'navigator.ml yok' };
      try { await navigator.ml.createContext({ deviceType: 'cpu' }); } catch (e) { return { skip: 'WebNN cpu bağlamı yok: ' + e.message }; }
      const ort = await import('../lib/ort/ort.webgpu.min.mjs');
      ort.env.wasm.wasmPaths = new URL('../lib/ort/', location.href).href;
      ort.env.wasm.numThreads = 1;
      const violations = [];
      document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective));
      try {
        const s = await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: [{ name: 'webnn', deviceType: 'cpu' }], freeDimensionOverrides: {} });
        const out = await s.run({ x: new ort.Tensor('float32', Float32Array.from([1, 2, 3, 4]), [1, 4]) });
        return { y: Array.from(out.y.data), violations };
      } catch (e) { return { error: String(e?.message || e), violations }; }
    }, model);
    if (r.skip) { console.log('atlandı —', r.skip); return; }
    assert.ok(!r.error, 'WebNN oturumu kurulamadı: ' + r.error);
    assert.deepEqual(r.y, [2, 4, 6, 8]);
    assert.deepEqual(r.violations, []);
    console.log('ok — webnn-csp (WebNN cpu, CSP ihlali yok)');
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
