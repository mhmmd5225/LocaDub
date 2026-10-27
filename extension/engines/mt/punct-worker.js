// Module Web Worker: noktalama/büyük harf geri kazanım modeli (punct.js) onnxruntime-web wasm ile.
// Model baytlarını restore-engine.js indirir ve buraya aktarır.
//
// Protokol (postMessage):
//   → {type:'load', id, onnx:ArrayBuffer, spm:ArrayBuffer}     ← {type:'ready', id}
//   → {type:'restore', id, texts:string[]}                      ← {type:'result', id, result:string[]}
//   → {type:'dispose', id}                                      ← {type:'disposed', id}
//   ← {type:'error', id, message}

import * as ort from '../../lib/ort/ort.webgpu.min.mjs';
import { PunctRestorer } from './punct.js';

ort.env.wasm.wasmPaths = new URL('../../lib/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

let restorer = null;
let queue = Promise.resolve();

const post = (m) => self.postMessage(m);

self.onmessage = (ev) => {
  const m = ev.data || {};
  queue = queue.then(async () => {
    try {
      if (m.type === 'load') {
        await restorer?.release();
        restorer = await PunctRestorer.create(ort, {
          onnx: m.onnx, spm: m.spm, sessionOptions: { executionProviders: ['wasm'], graphOptimizationLevel: 'all' },
        });
        post({ type: 'ready', id: m.id });
      } else if (m.type === 'restore') {
        if (!restorer) throw new Error('punct: model yüklenmedi');
        const result = [];
        for (const t of m.texts) result.push(await restorer.restore(t));
        post({ type: 'result', id: m.id, result });
      } else if (m.type === 'dispose') {
        await restorer?.release();
        restorer = null;
        post({ type: 'disposed', id: m.id });
      }
    } catch (e) {
      post({ type: 'error', id: m.id, message: String(e?.message || e), name: e?.name });
    }
  });
};
