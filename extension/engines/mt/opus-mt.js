// 'opus-mt' backend, main-thread side: downloads the model (Cache Storage), starts worker.js and
// talks to it. Inference itself happens in the worker.

import { HF_BASE, TOKENIZER_FILES, VARIANTS, DEFAULT_VARIANT } from './models.js';
import { fetchRange, isRangeCached } from './range-cache.js';
import { keptRanges } from './onnx-patch.js';

export const label = 'OPUS-MT tc-big EN→TR (yerel, çevrimdışı)';

const urlOf = (f, base = HF_BASE) => base + f.path;

let worker = null;
let nextId = 1;
const pending = new Map();
let loaded = null; // { variant, info }

function startWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'yt-tr-dub-mt' });
  worker.onmessage = (ev) => {
    const m = ev.data;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') { p.onProgress?.(m); return; }
    pending.delete(m.id);
    if (m.type === 'error') p.reject(Object.assign(new Error(m.message), { name: m.name }));
    else p.resolve(m);
  };
  worker.onerror = (ev) => {
    const err = new Error(`opus-mt worker: ${ev.message || 'failed to start'}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker?.terminate();
    worker = null;
    loaded = null;
  };
  return worker;
}

function call(msg, { transfer, signal, onProgress } = {}) {
  const w = startWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => w.postMessage({ type: 'cancel', id });
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(id, {
      onProgress,
      resolve: (v) => { signal?.removeEventListener('abort', onAbort); resolve(v); },
      reject: (e) => { signal?.removeEventListener('abort', onAbort); reject(e); },
    });
    w.postMessage({ ...msg, id }, transfer ?? []);
  });
}

/** Download plan for a variant: whole files and decoder ranges with their sizes. */
function plan(variantId, base) {
  const v = VARIANTS[variantId];
  if (!v) throw new Error(`opus-mt: unknown variant ${variantId}`);
  const dec = v.decoder;
  const holes = (dec.holes ?? []).map((h) => h.range);
  return {
    v,
    whole: [
      { key: 'encoder', url: urlOf(v.encoder, base), size: v.encoder.size },
      { key: 'spm', url: urlOf(TOKENIZER_FILES.spm, base), size: TOKENIZER_FILES.spm.size },
      { key: 'vocab', url: urlOf(TOKENIZER_FILES.vocab, base), size: TOKENIZER_FILES.vocab.size },
    ],
    decoderUrl: urlOf(dec, base),
    ranges: holes.length ? keptRanges(dec.size, holes) : null,
  };
}

export function sizeMB(variantId = DEFAULT_VARIANT) {
  return VARIANTS[variantId].downloadMB;
}

/** Whether every file of the variant is already in Cache Storage. */
export async function isDownloaded(variantId = DEFAULT_VARIANT, base = HF_BASE) {
  try {
    const p = plan(variantId, base);
    const { isCached } = await import('../common/model-cache.js');
    for (const f of p.whole) if (!(await isCached(f.url))) return false;
    if (p.ranges) {
      for (const [a, b] of p.ranges) if (!(await isRangeCached(p.decoderUrl, a, b))) return false;
    } else if (!(await isCached(p.decoderUrl))) return false;
    return true;
  } catch {
    return false;
  }
}

export function isSupported() {
  return typeof WebAssembly === 'object' && typeof Worker === 'function';
}

/**
 * Downloads (or reads from cache) and loads the model in the worker. Idempotent.
 * @param {{onProgress?:Function, variant?:string, modelBaseUrl?:string, numThreads?:number, signal?:AbortSignal}} o
 */
export async function init({ onProgress, variant = DEFAULT_VARIANT, modelBaseUrl = HF_BASE, numThreads, signal } = {}) {
  if (loaded && loaded.variant === variant && loaded.base === modelBaseUrl) return loaded.info;
  const { fetchModel } = await import('../common/model-cache.js');
  const p = plan(variant, modelBaseUrl);
  const progress = new Map();
  const total = p.v.downloadMB * 1e6;
  let cached = true; // all parts served from Cache Storage so far
  const report = (key, n, hit) => {
    progress.set(key, n);
    if (hit === false) cached = false;
    let sum = 0;
    for (const x of progress.values()) sum += x;
    onProgress?.({ backend: 'opus-mt', phase: 'download', loaded: Math.min(sum, total), total, cached });
  };

  const files = {};
  // Sequential downloads: steadier progress and less memory pressure than all at once.
  for (const f of p.whole) {
    files[f.key] = await fetchModel(f.url, { onProgress: (e) => report(f.url, e.loaded ?? 0, !!e.cached) });
    report(f.url, files[f.key].byteLength);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }
  let decoder;
  if (p.ranges) {
    const parts = [];
    for (const [a, b] of p.ranges) {
      const data = await fetchRange(p.decoderUrl, a, b, { signal, onProgress: (e) => report(e.url, e.loaded, !!e.cached) });
      parts.push({ start: a, data });
    }
    decoder = { size: p.v.decoder.size, parts, holes: p.v.decoder.holes };
  } else {
    const data = await fetchModel(p.decoderUrl, { onProgress: (e) => report(p.decoderUrl, e.loaded ?? 0, !!e.cached) });
    decoder = { size: data.byteLength, parts: [{ start: 0, data }], holes: [] };
  }
  onProgress?.({ backend: 'opus-mt', phase: 'load', loaded: total, total, cached: true });

  const transfer = [files.encoder, files.spm, files.vocab, ...decoder.parts.map((x) => x.data)];
  const res = await call(
    { type: 'init', encoder: files.encoder, decoder, spm: files.spm, vocab: files.vocab, numThreads },
    { transfer, signal },
  );
  loaded = { variant, base: modelBaseUrl, info: res.info };
  onProgress?.({ backend: 'opus-mt', phase: 'ready', loaded: total, total });
  return res.info;
}

/** Translates cleaned-up spans (see preprocess.js). */
export async function translate(texts, { signal, maxBatch = 8 } = {}) {
  if (!loaded) throw new Error('opus-mt: init() first');
  if (!texts.length) return [];
  const res = await call({ type: 'translate', texts, maxBatch }, { signal });
  return res.result;
}

export async function dispose() {
  if (!worker) return;
  try {
    await Promise.race([call({ type: 'dispose' }), new Promise((r) => setTimeout(r, 2000))]);
  } catch { /* terminate anyway */ }
  worker?.terminate();
  worker = null;
  loaded = null;
  for (const p of pending.values()) p.reject(new DOMException('Disposed', 'AbortError'));
  pending.clear();
}
