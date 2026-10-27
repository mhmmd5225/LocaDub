// TTS inference worker (module Web Worker, spawned by ./index.js). Runs onnxruntime-web and the synthesis core.
//
// Protocol (all requests carry reqId; replies echo it):
//   -> { type:'load',  reqId, voiceId, files:{ [name]: ArrayBuffer }, options:{ device, threads, steps } }
//   <- { type:'loaded', reqId, info }
//   -> { type:'synth', reqId, voiceId, text, speed, outputRate, tone:{ style, pitch, quality } }
//   <- { type:'done',  reqId, pcm:Float32Array (transferred), sampleRate, stats }
//   -> { type:'cancel', reqId }                 (queued: dropped; running: stops at the next chunk)
//   -> { type:'unload', reqId, voiceId }        <- { type:'unloaded', reqId }
//   <- { type:'error', reqId, name, message }
//
// Requests run one at a time (onnxruntime-web sessions must not run concurrently).

import * as ort from '../../lib/ort/ort.webgpu.min.mjs';
import { voiceById } from './voices.js';
import { loadVoice, releaseVoice, synthesizeText } from './core.js';

ort.env.wasm.wasmPaths = new URL('../../lib/ort/', import.meta.url).href;
ort.env.logLevel = 'error';

const voices = new Map(); // voiceId -> loaded voice
const cancelled = new Set();
let configured = false;
let device = 'wasm';
let queue = Promise.resolve();

function configure(options = {}) {
  if (configured) return;
  configured = true;
  // Single-threaded by default. Measured (Chromium, onnxruntime-web 1.22.0, cross-origin isolated): numThreads > 1
  // inside a module Worker hangs InferenceSession.create (tests/tts/browser/threads-worker.js), while 1 thread meets
  // the RTF target with the default voice. Threads only when explicitly requested (and SharedArrayBuffer exists).
  ort.env.wasm.numThreads = self.crossOriginIsolated && options.threads > 1 ? Math.min(8, options.threads) : 1;
  ort.env.wasm.proxy = false;
}

async function providersFor(requested) {
  if (requested === 'webgpu' && self.navigator?.gpu) {
    const adapter = await navigator.gpu.requestAdapter().catch(() => null);
    if (adapter) return ['webgpu', 'wasm'];
  }
  return ['wasm'];
}

async function load({ voiceId, files, options = {} }) {
  configure(options);
  if (voices.has(voiceId)) return info(voices.get(voiceId));
  const def = voiceById(voiceId);
  if (!def) throw new Error(`Bilinmeyen ses: ${voiceId}`);
  const providers = await providersFor(options.device);
  let voice;
  try {
    voice = await loadVoice(ort, def, files, { sessionOptions: { executionProviders: providers }, steps: options.steps });
  } catch (e) {
    if (providers[0] !== 'webgpu') throw e;
    console.warn('[tts] WebGPU session failed, falling back to WASM', e);
    voice = await loadVoice(ort, def, files, { sessionOptions: { executionProviders: ['wasm'] }, steps: options.steps });
    providers.splice(0, providers.length, 'wasm');
  }
  device = providers[0];
  voice.providers = providers;
  voices.set(voiceId, voice);
  // warm-up: the first run of each graph allocates and picks kernels
  await synthesizeText(voice, 'Merhaba.', {});
  return info(voice);
}

const info = (v) => ({
  voiceId: v.id,
  sampleRate: v.sampleRate,
  providers: v.providers,
  device,
  threads: ort.env.wasm.numThreads,
  crossOriginIsolated: !!self.crossOriginIsolated,
});

async function synth({ reqId, voiceId, text, speed, outputRate, tone }) {
  const voice = voices.get(voiceId);
  if (!voice) throw new Error(`Ses yüklenmedi: ${voiceId}`);
  return synthesizeText(voice, text, { speed, outputRate, tone, isCancelled: () => cancelled.has(reqId) });
}

function reply(msg, transfer = []) {
  self.postMessage(msg, transfer);
}

self.onmessage = (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'cancel') {
    cancelled.add(msg.reqId);
    return;
  }
  queue = queue.then(async () => {
    const { reqId } = msg;
    try {
      if (cancelled.has(reqId)) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      if (msg.type === 'load') reply({ type: 'loaded', reqId, info: await load(msg) });
      else if (msg.type === 'synth') {
        const { pcm, sampleRate, stats } = await synth(msg);
        reply({ type: 'done', reqId, pcm, sampleRate, stats }, [pcm.buffer]);
      } else if (msg.type === 'unload') {
        const v = voices.get(msg.voiceId);
        voices.delete(msg.voiceId);
        await releaseVoice(v);
        reply({ type: 'unloaded', reqId });
      } else throw new Error(`unknown message ${msg.type}`);
    } catch (e) {
      reply({ type: 'error', reqId, name: e?.name || 'Error', message: e?.message || String(e) });
    } finally {
      cancelled.delete(reqId);
    }
  });
};
