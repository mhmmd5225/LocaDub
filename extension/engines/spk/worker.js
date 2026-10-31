// Konuşmacı gömme işçisi (modül Web Worker, ./index.js açar). onnxruntime-web WASM, tek iş parçacığı.
//
// İletiler (istekler reqId taşır, yanıtlar aynısını):
//   -> { type:'load', reqId, model, bytes:ArrayBuffer, head:{w,b}|null }      <- { type:'loaded', reqId }
//   -> { type:'embed', reqId, pcm:Float32Array (16 kHz mono) }
//   <- { type:'done', reqId, vector:Float32Array|null, voicedSec, score:number|null, f0:number[], ms }
//   <- { type:'error', reqId, message }
// İstekler sırayla çalışır.

import * as ort from '../../lib/ort/ort.wasm.min.mjs';
import { createEmbedder, RATE } from './embedder.js';
import { genderScore } from './gender-head.js';
import { estimateF0, voicedF0 } from '../../content/gender.js';

ort.env.wasm.wasmPaths = new URL('../../lib/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.logLevel = 'error';

let emb = null;
let head = null;
let queue = Promise.resolve();

// Tarayıcıdaki analizör gibi 50 ms'de bir ≈ 43 ms'lik çerçevenin perdesi; tutulan notalar atılmış.
function pitch(pcm) {
  const W = Math.round(0.0427 * RATE);
  const H = Math.round(0.05 * RATE);
  const fr = [];
  for (let s = 0; s + W <= pcm.length; s += H) fr.push([s / RATE, estimateF0(pcm.subarray(s, s + W), RATE)]);
  return voicedF0(fr).map((v) => Math.round(v));
}

async function handle(m) {
  if (m.type === 'load') {
    if (!emb || emb.model.id !== m.model.id) {
      await emb?.dispose();
      emb = createEmbedder({ model: m.model, ort, modelData: m.bytes });
      await emb.load();
    }
    head = m.head || null;
    return { type: 'loaded' };
  }
  if (m.type === 'embed') {
    if (!emb) throw new Error('Konuşmacı modeli yüklenmedi');
    const t = performance.now();
    const { vector, voicedSec } = await emb.embed(m.pcm);
    return { type: 'done', vector, voicedSec, score: vector && head ? genderScore(head, vector) : null, f0: pitch(m.pcm), ms: Math.round(performance.now() - t) };
  }
  throw new Error('Bilinmeyen istek: ' + m.type);
}

self.onmessage = (ev) => {
  const m = ev.data || {};
  queue = queue.then(() => handle(m)).then(
    (r) => self.postMessage({ ...r, reqId: m.reqId }, r.vector ? [r.vector.buffer] : []),
    (e) => self.postMessage({ type: 'error', reqId: m.reqId, message: e?.message || String(e) }),
  );
};
