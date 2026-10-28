// Turkish TTS engine — docs/CONTRACT.md "Seslendirme motoru API". Runs in the offscreen document; inference happens
// in a module Web Worker (./worker.js). Model files are downloaded once through the shared model cache and
// transferred to the worker as ArrayBuffers.
//
//   listVoices() -> [{ id, label, gender, sizeMB, license, available, cached?, default?, system? }]
//   init({ voice, onProgress, device?, threads?, steps?, outputRate? })
//   synthesize(text, { voice, speed = 1.0, tone, signal }) -> { pcm: Float32Array, sampleRate } | { system: true }
//   dispose()
//
// Voices: 'antalia-mini' (male, Apache-2.0, default), 'ahenk-cep' (female, CC BY 4.0), 'ema-lightning' (female, Apache-2.0),
// 'supertonic-3:F1'…'supertonic-3:M5' (experimental, ten presets of one shared pack, OpenRAIL-M), 'system' (chrome.tts /
// speechSynthesis fallback, played by the extension). See README.md in this folder.

import { fetchModel, isCached } from '../common/model-cache.js';
import { normalizeTone } from './styles.js';
import { DEFAULT_VOICE, SYSTEM_VOICE, VOICES, packOf, voiceById, voiceBytes } from './voices.js';

export const id = 'tts';

/** Default output rate: the models speak at 48 kHz; 24 kHz halves what crosses extension messages, speech-safe. */
const DEFAULT_OUTPUT_RATE = 24000;

let worker = null;
let seq = 0;
const pending = new Map(); // reqId -> { resolve, reject }
const loaded = new Map(); // pack (voiceId, or the shared pack of Supertonic presets) -> Promise<info>
let options = { device: 'wasm', threads: 0, steps: 0, outputRate: DEFAULT_OUTPUT_RATE };
let currentVoice = null;
// WASM threads are fixed when the worker creates its first session. Voices that need more than one (catalog
// `threads`: Supertonic) restart a single-threaded worker; if a multi-threaded load ever hangs (seen with
// onnxruntime-web 1.22 in some Chromium builds, tests/tts/browser/threads-worker.js) we fall back to one thread.
let workerThreads = 0; // 0: the worker has not loaded anything yet
let threadsBroken = false;
const THREADED_LOAD_TIMEOUT_MS = 90000;

const abortError = () => new DOMException('İptal edildi', 'AbortError');

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'tts' });
  worker.onmessage = (ev) => {
    const msg = ev.data || {};
    const p = pending.get(msg.reqId);
    if (!p) return;
    pending.delete(msg.reqId);
    if (msg.type === 'error') {
      const e = msg.name === 'AbortError' ? abortError() : new Error(msg.message);
      p.reject(e);
    } else p.resolve(msg);
  };
  worker.onerror = (ev) => stopWorker(new Error(`TTS worker hatası: ${ev.message || 'bilinmiyor'}`));
  return worker;
}

function stopWorker(e) {
  for (const p of pending.values()) p.reject(e);
  pending.clear();
  loaded.clear();
  worker?.terminate();
  worker = null;
  workerThreads = 0;
}

/** WASM threads for a voice: an explicit init({ threads }) wins; otherwise the catalog hint, capped by the CPU. */
function threadsFor(def) {
  if (options.threads) return options.threads;
  if (!def.threads || threadsBroken || !globalThis.crossOriginIsolated) return 1;
  return Math.max(1, Math.min(def.threads, (globalThis.navigator?.hardwareConcurrency || 2) - 1));
}

/** Send the voice's files to the worker; with threads, give up after a while and retry on one thread. */
async function loadInWorker(def, onProgress, signal) {
  for (;;) {
    const threads = threadsFor(def);
    if (workerThreads && threads > workerThreads) stopWorker(new Error('TTS motoru iş parçacığı sayısını değiştirmek için yeniden başlatıldı'));
    const files = {};
    // sequential downloads keep the progress readable and memory flat (largest file: Supertonic's 257 MB graph)
    for (const f of def.files) files[f.name] = await fetchModel(f.url, { onProgress, signal });
    if (!workerThreads) workerThreads = threads;
    const req = request(
      { type: 'load', voiceId: def.id, files, options: { device: options.device, threads: workerThreads, steps: options.steps } },
      Object.values(files),
    );
    if (workerThreads <= 1) return (await req).info;
    let timer;
    const hung = new Promise((resolve) => { timer = setTimeout(resolve, THREADED_LOAD_TIMEOUT_MS, 'hung'); });
    try {
      const r = await Promise.race([req, hung]);
      if (r !== 'hung') return r.info;
    } finally {
      clearTimeout(timer);
    }
    console.warn('[tts] multi-threaded load did not finish, retrying with one thread');
    threadsBroken = true;
    stopWorker(new Error('TTS motoru tek iş parçacığıyla yeniden başlatıldı'));
  }
}

function request(msg, transfer = [], signal) {
  const w = getWorker();
  const reqId = ++seq;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    pending.set(reqId, { resolve, reject });
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          if (!pending.has(reqId)) return;
          pending.delete(reqId);
          w.postMessage({ type: 'cancel', reqId });
          reject(abortError());
        },
        { once: true },
      );
    }
    w.postMessage({ ...msg, reqId }, transfer);
  });
}

// Longest shared URL prefix up to a '/', so the settings page can find/delete a voice's cached files.
function commonPrefix(urls) {
  let p = urls[0] || '';
  for (const u of urls) while (!u.startsWith(p)) p = p.slice(0, -1);
  return p.slice(0, p.lastIndexOf('/') + 1);
}

export async function listVoices() {
  const out = [];
  for (const v of VOICES) {
    let cached = false;
    try {
      cached = (await Promise.all(v.files.map((f) => isCached(f.url)))).every(Boolean);
    } catch {
      /* no Cache Storage here */
    }
    out.push({
      id: v.id,
      label: v.label,
      gender: v.gender,
      sizeMB: Math.round((voiceBytes(v) / 1e6) * 10) / 10,
      license: v.license,
      available: typeof WebAssembly === 'object',
      cached,
      default: v.id === DEFAULT_VOICE,
      homepage: v.homepage,
      attribution: v.attribution,
      ...(v.pack ? { pack: v.pack, preset: v.preset } : {}),
      ...(v.experimental ? { experimental: true } : {}),
      cachePrefix: commonPrefix(v.files.map((f) => f.url)),
    });
  }
  out.push({ ...SYSTEM_VOICE });
  return out;
}

async function loadVoice(voiceId, onProgress, signal) {
  const def = voiceById(voiceId);
  if (!def) throw new Error(`Bilinmeyen ses: ${voiceId}`);
  const key = packOf(def);
  if (loaded.has(key)) return loaded.get(key);
  const p = loadInWorker(def, onProgress, signal);
  loaded.set(key, p);
  p.catch(() => loaded.delete(key));
  // keep at most two models in memory (all presets of a pack count as one)
  const current = voiceById(currentVoice);
  if (loaded.size > 2) {
    for (const k of loaded.keys()) {
      if (k === key || (current && k === packOf(current))) continue;
      loaded.delete(k);
      request({ type: 'unload', voiceId: k }).catch(() => {});
      break;
    }
  }
  return p;
}

/**
 * Download (or read from cache) and load a voice. Idempotent.
 * Extra options: device 'wasm' (default) | 'webgpu', threads (only with crossOriginIsolated), steps (flow steps;
 * fewer = faster), outputRate (Hz, default 24000; 48000 = the models' native rate).
 */
export async function init({ voice, onProgress, device, threads, steps, outputRate, signal } = {}) {
  if (device) options.device = device;
  if (threads) options.threads = threads;
  if (steps) options.steps = steps;
  if (outputRate) options.outputRate = outputRate;
  const v = voice || currentVoice || DEFAULT_VOICE;
  if (v === 'system') {
    currentVoice = 'system';
    return { voice: 'system', system: true };
  }
  const info = await loadVoice(v, onProgress, signal);
  currentVoice = v;
  return info;
}

/**
 * Turkish text -> mono PCM. Normalization (numbers, %, times, money, abbreviations, English names) happens inside.
 * speed: 0.8–2.0 (clamped to 0.5–3); up to 1.6 the model's duration control is used, beyond that time-stretch.
 * tone: { style: 'natural'|'lively'|'calm', pitch: semitones, quality: 'fast'|'high' } (styles.js); invalid -> defaults.
 */
export async function synthesize(text, { voice, speed = 1.0, tone, signal } = {}) {
  const v = voice || currentVoice || DEFAULT_VOICE;
  if (v === 'system') return { system: true };
  if (signal?.aborted) throw abortError();
  const t = String(text ?? '').trim();
  if (!t) return { pcm: new Float32Array(0), sampleRate: options.outputRate };
  await loadVoice(v, undefined, signal);
  currentVoice = v;
  const res = await request({ type: 'synth', voiceId: v, text: t, speed: Number(speed) || 1, outputRate: options.outputRate, tone: normalizeTone(tone) }, [], signal);
  return { pcm: res.pcm, sampleRate: res.sampleRate, stats: res.stats };
}

export async function dispose() {
  for (const p of pending.values()) p.reject(abortError());
  pending.clear();
  loaded.clear();
  currentVoice = null;
  worker?.terminate();
  worker = null;
  workerThreads = 0;
}
