// Translation engine (EN → TR) — public API, see docs/CONTRACT.md "Çeviri motoru API".
//
// Backends:
//   'chrome-translator'  Chrome's built-in on-device Translator API (no download by us; Chrome 138+)
//   'opus-mt'            Helsinki-NLP/opus-mt-tc-big-en-tr, ONNX int8 (onnx-community), ≈300 MB sliced
//                        download from Hugging Face, onnxruntime-web WASM in a module worker.
// 'auto' (default): chrome-translator if its availability is 'available', otherwise opus-mt.
//
// Extra exports beyond the contract: status(), prepareChromeTranslator() (call from a popup click).

import * as opus from './opus-mt.js';
import { HF_BASE } from './models.js';
import * as chromeMt from './chrome-translator.js';
import { prepareBatch, finishBatch } from './preprocess.js';

export const id = 'mt';
export { prepareChromeTranslator } from './chrome-translator.js';

const BACKENDS = { 'opus-mt': opus, 'chrome-translator': chromeMt };

let current = null; // backend id once ready
let initPromise = null;
let initFor = null;
let lastOptions = {};
let queue = Promise.resolve();

// Translations of cleaned-up spans, per backend (LRU).
const CACHE_MAX = 4000;
const memo = new Map();
const memoGet = (k) => {
  const v = memo.get(k);
  if (v !== undefined) { memo.delete(k); memo.set(k, v); }
  return v;
};
const memoSet = (k, v) => {
  memo.set(k, v);
  if (memo.size > CACHE_MAX) memo.delete(memo.keys().next().value);
};

export async function listBackends() {
  const chromeStatus = await chromeMt.availability();
  const opusEntry = {
    id: 'opus-mt',
    label: opus.label,
    sizeMB: opus.sizeMB(),
    available: opus.isSupported(),
    downloaded: await opus.isDownloaded(),
    license: 'CC-BY-4.0',
    cachePrefix: HF_BASE, // whole files and Range parts are all cached under this URL
  };
  const chromeEntry = {
    id: 'chrome-translator',
    label: chromeMt.label,
    sizeMB: 0, // language pack is managed (and downloaded) by Chrome
    available: chromeStatus !== 'unavailable',
    status: chromeStatus,
    needsUserActivation: chromeStatus === 'downloadable' || chromeStatus === 'downloading',
  };
  return chromeStatus === 'available' ? [chromeEntry, opusEntry] : [opusEntry, chromeEntry];
}

async function resolveBackend(backend) {
  if (backend && backend !== 'auto') {
    if (!BACKENDS[backend]) throw new Error(`mt: unknown backend ${backend}`);
    return backend;
  }
  return (await chromeMt.availability()) === 'available' ? 'chrome-translator' : 'opus-mt';
}

/**
 * Loads a backend (downloads the model if needed). Idempotent; switching backend disposes the old one.
 * @param {{backend?:'auto'|'opus-mt'|'chrome-translator', onProgress?:Function, variant?:string,
 *          modelBaseUrl?:string, numThreads?:number}} [options]
 */
export async function init(options = {}) {
  lastOptions = options;
  const backend = await resolveBackend(options.backend);
  if (current === backend && !initPromise) return { backend };
  if (initPromise && initFor === backend) return initPromise;
  if (initPromise) await initPromise.catch(() => {});
  if (current && current !== backend) {
    await BACKENDS[current].dispose();
    current = null;
  }
  initFor = backend;
  initPromise = (async () => {
    await BACKENDS[backend].init(options);
    current = backend;
    return { backend };
  })();
  try {
    return await initPromise;
  } finally {
    initPromise = null;
    initFor = null;
  }
}

export function status() {
  return { ready: !!current, backend: current };
}

async function runBatch(sentences, signal) {
  if (!current) await init(lastOptions);
  const backend = current;
  const { units, plan } = prepareBatch(sentences);
  const results = new Array(units.length);
  const todo = [];
  units.forEach((u, i) => {
    const hit = memoGet(`${backend}\u0001${u}`);
    if (hit !== undefined) results[i] = hit;
    else todo.push(i);
  });
  if (todo.length) {
    const out = await BACKENDS[backend].translate(todo.map((i) => units[i]), { signal });
    todo.forEach((i, j) => {
      results[i] = out[j] ?? '';
      memoSet(`${backend}\u0001${units[i]}`, results[i]);
    });
  }
  return finishBatch(plan, results);
}

/**
 * @param {string[]} sentences English
 * @param {{signal?:AbortSignal}} [o]
 * @returns {Promise<string[]>} Turkish, same length and order; '' for empty input
 */
export function translateBatch(sentences, { signal } = {}) {
  const list = Array.from(sentences ?? [], (s) => (typeof s === 'string' ? s : String(s ?? '')));
  const job = queue.then(() => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!list.some((s) => s.trim())) return list.map(() => '');
    return runBatch(list, signal);
  });
  queue = job.catch(() => {});
  return job;
}

export async function dispose() {
  if (initPromise) await initPromise.catch(() => {});
  await Promise.allSettled([opus.dispose(), chromeMt.dispose()]);
  current = null;
  memo.clear();
}
