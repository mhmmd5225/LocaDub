// Diagnostic: can onnxruntime-web create a multi-threaded WASM session inside a module worker?
import * as ort from '../../../extension/lib/ort/ort.webgpu.min.mjs';
ort.env.wasm.wasmPaths = new URL('../../../extension/lib/ort/', import.meta.url).href;
self.onmessage = async (ev) => {
  ort.env.wasm.numThreads = ev.data.threads;
  if (ev.data.proxy !== undefined) ort.env.wasm.proxy = ev.data.proxy;
  if (ev.data.explicit) {
    const base = new URL('../../../extension/lib/ort/', import.meta.url);
    ort.env.wasm.wasmPaths = {
      mjs: new URL('ort-wasm-simd-threaded.jsep.mjs', base).href,
      wasm: new URL('ort-wasm-simd-threaded.jsep.wasm', base).href,
    };
  }
  const t0 = performance.now();
  try {
    const b = await (await fetch('../.models/ahenk-cep/cond.f16.onnx')).arrayBuffer();
    const s = await ort.InferenceSession.create(new Uint8Array(b), { executionProviders: ['wasm'] });
    postMessage(`ok ${Math.round(performance.now() - t0)} ms ${s.inputNames}`);
  } catch (e) {
    postMessage(`err ${e}`);
  }
};
