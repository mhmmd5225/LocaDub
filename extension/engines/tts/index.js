// Turkish TTS engine — docs/CONTRACT.md "Seslendirme motoru API". Runs in the offscreen document; inference happens
// in a module Web Worker (./worker.js). Model files are downloaded once through the shared model cache and
// transferred to the worker as ArrayBuffers.
//
//   listVoices() -> [{ id, label, gender, sizeMB, license, available, cached?, default?, system? }]
//   init({ voice, onProgress, device?, threads?, steps?, outputRate? })
//   synthesize(text, { voice, speed = 1.0, tone, signal }) -> { pcm: Float32Array, sampleRate } | { system: true }
//   dispose()
//
// Voices: 'antalia-mini' (male, Apache-2.0, default), 'ahenk-cep' (female, CC BY 4.0), 'system' (chrome.tts /
// speechSynthesis fallback, played by the extension). See README.md in this folder.

import { fetchModel, isCached } from '../common/model-cache.js';
import { normalizeTone } from './styles.js';
import { DEFAULT_VOICE, SYSTEM_VOICE, VOICES, voiceById, voiceBytes } from './voices.js';

export const id = 'tts';

/** Default output rate: the models speak at 48 kHz; 24 kHz halves what crosses extension messages, speech-safe. */
const DEFAULT_OUTPUT_RATE = 24000;

let worker = null;
let seq = 0;
const pending = new Map(); // reqId -> { resolve, reject }
const loaded = new Map(); // voiceId -> Promise<info>
let options = { device: 'wasm', threads: 0, steps: 0, outputRate: DEFAULT_OUTPUT_RATE };
let currentVoice = null;

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
  worker.onerror = (ev) => {
    const e = new Error(`TTS worker hatası: ${ev.message || 'bilinmiyor'}`);
    for (const p of pending.values()) p.reject(e);
    pending.clear();
    loaded.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
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
      cachePrefix: commonPrefix(v.files.map((f) => f.url)),
    });
  }
  out.push({ ...SYSTEM_VOICE });
  return out;
}

async function loadVoice(voiceId, onProgress, signal) {
  if (loaded.has(voiceId)) return loaded.get(voiceId);
  const def = voiceById(voiceId);
  if (!def) throw new Error(`Bilinmeyen ses: ${voiceId}`);
  const p = (async () => {
    const files = {};
    // sequential downloads keep the progress readable and memory flat; the files are small (≤ 11 MB)
    for (const f of def.files) files[f.name] = await fetchModel(f.url, { onProgress, signal });
    const { info } = await request(
      { type: 'load', voiceId, files, options: { device: options.device, threads: options.threads, steps: options.steps } },
      Object.values(files),
    );
    return info;
  })();
  loaded.set(voiceId, p);
  p.catch(() => loaded.delete(voiceId));
  // keep at most two voices in memory
  if (loaded.size > 2) {
    for (const k of loaded.keys()) {
      if (k === voiceId || k === currentVoice) continue;
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
}
