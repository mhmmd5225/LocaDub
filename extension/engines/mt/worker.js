// Module Web Worker for the 'opus-mt' backend: builds the ONNX sessions and runs translation off the
// offscreen document's main thread. Model bytes are downloaded by opus-mt.js and transferred here.
//
// Structure follows Harfiyen's src/worker/mt.worker.ts (https://github.com/ozcancelik/harfiyen,
// Copyright (c) Ozcan Celik, MIT License): one job at a time, cancellable, wasm execution provider
// (the merged decoder's If node is not for WebGPU).
//
// Protocol (postMessage):
//   → {type:'init', id, encoder:ArrayBuffer, decoder:{size, parts:[{start, data:ArrayBuffer}], holes},
//      spm:ArrayBuffer, vocab:ArrayBuffer (vocab.json bytes), numThreads?}
//   ← {type:'ready', id, info:{threads, loadMs, patched:[...]}}
//   → {type:'translate', id, texts:string[], maxBatch?}
//   ← {type:'progress', id, done, total} … {type:'result', id, result:string[], ms}
//   → {type:'cancel', id}      ← {type:'error', id, message, name}
//   → {type:'dispose', id}     ← {type:'disposed', id}

import * as ort from '../../lib/ort/ort.webgpu.min.mjs';
import { MarianTranslator, TC_BIG_CONFIG } from './marian.js';
import { MarianTokenizer } from './spm.js';
import { assemble, fillDequantized } from './onnx-patch.js';

let translator = null;
let runtimeReady = false;
const cancelled = new Set();
let queue = Promise.resolve();

const post = (m, transfer) => self.postMessage(m, transfer ?? []);

function setUpRuntime(numThreads) {
  if (runtimeReady) return ort.env.wasm.numThreads;
  runtimeReady = true;
  ort.env.wasm.wasmPaths = new URL('../../lib/ort/', import.meta.url).href;
  // ort 1.22 hangs in InferenceSession.create with numThreads>1 inside a module Worker
  // (seen on a crossOriginIsolated page), so stay single-threaded unless explicitly asked.
  ort.env.wasm.numThreads = self.crossOriginIsolated && numThreads > 1
    ? Math.min(4, numThreads)
    : 1;
  ort.env.logLevel = 'error';
  return ort.env.wasm.numThreads;
}

async function init(m) {
  const t0 = performance.now();
  const threads = setUpRuntime(m.numThreads);
  if (translator) {
    await translator.release();
    translator = null;
  }
  const encoder = new Uint8Array(m.encoder);
  const decoder = assemble(m.decoder.size, m.decoder.parts);
  m.decoder.parts = null;
  const patched = [];
  for (const h of m.decoder.holes ?? []) {
    const src = h.from === 'encoder' ? encoder : decoder;
    fillDequantized(decoder, h.tensor, src, h.source, h.range);
    patched.push(h.tensor);
  }
  const vocab = JSON.parse(new TextDecoder().decode(m.vocab));
  const tokenizer = new MarianTokenizer(m.spm, vocab);
  translator = await MarianTranslator.create(ort, { encoder, decoder, tokenizer, config: TC_BIG_CONFIG });
  return { threads, loadMs: Math.round(performance.now() - t0), patched };
}

async function translate(m) {
  if (!translator) throw new Error('opus-mt: model is not loaded');
  const t0 = performance.now();
  const result = await translator.translate(m.texts, {
    maxBatch: m.maxBatch ?? 8,
    shouldStop: () => cancelled.has(m.id),
    onBatch: (done, total) => post({ type: 'progress', id: m.id, done, total }),
  });
  return { result, ms: Math.round(performance.now() - t0) };
}

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'cancel') {
    cancelled.add(m.id);
    return;
  }
  queue = queue.then(async () => {
    try {
      if (cancelled.has(m.id)) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      if (m.type === 'init') post({ type: 'ready', id: m.id, info: await init(m) });
      else if (m.type === 'translate') post({ type: 'result', id: m.id, ...(await translate(m)) });
      else if (m.type === 'dispose') {
        await translator?.release();
        translator = null;
        post({ type: 'disposed', id: m.id });
      }
    } catch (e) {
      post({ type: 'error', id: m.id, name: e?.name || 'Error', message: e?.message || String(e) });
    } finally {
      cancelled.delete(m.id);
    }
  });
};
