// Konuşmacı gömücü: 16 kHz mono PCM → birim uzunlukta konuşmacı vektörü. Ortamdan bağımsız çekirdek: offscreen
// işçisinde onnxruntime-web, Node değerlendirmesinde (tools/spk-eval.mjs) onnxruntime-node ile aynı kod.
//
//   const e = createEmbedder({ model: 'wespeaker-r34', onProgress });
//   await e.load();
//   const { vector, voicedSec } = await e.embed(pcm16k);   // vector: Float32Array (|v| = 1) ya da çok kısaysa null

import { spkModelById } from './models.js';
import { fbank, subtractMean } from './fbank.js';

export const RATE = 16000;
/** Bundan az konuşma (sn, sessiz çerçeveler hariç) gömülmez: vektör güvenilmez. */
export const MIN_SPEECH_SEC = 0.6;
/** Uzun cümlelerin yalnızca bu kadarı kullanılır (sn): süre sınırlı, ayrım için yeterli. */
export const MAX_SEC = 8;
// Sessiz çerçeve: toplam log-mel enerjisi, cümlenin en gürül çerçevelerinin bu kadar altı (doğal log, ≈ 35 dB)
const SILENCE_DROP = 8;

/**
 * Sessiz çerçeveleri at (konuşma aralarındaki boşluk vektörü sulandırmasın). Çerçeve "enerjisi" log-mel
 * değerlerinin log-toplam-üssü; eşik en gürül %5'lik dilimden SILENCE_DROP aşağıda.
 */
export function dropSilence(fb) {
  const { data, frames, bins } = fb;
  if (frames < 10) return fb;
  const e = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let mx = -Infinity;
    for (let b = 0; b < bins; b++) mx = Math.max(mx, data[f * bins + b]);
    let s = 0;
    for (let b = 0; b < bins; b++) s += Math.exp(data[f * bins + b] - mx);
    e[f] = mx + Math.log(s);
  }
  const sorted = Float32Array.from(e).sort();
  const thr = sorted[Math.floor(frames * 0.95)] - SILENCE_DROP;
  let n = 0;
  for (let f = 0; f < frames; f++) if (e[f] >= thr) n++;
  if (n === frames) return fb;
  const out = new Float32Array(n * bins);
  let k = 0;
  for (let f = 0; f < frames; f++) {
    if (e[f] < thr) continue;
    out.set(data.subarray(f * bins, (f + 1) * bins), k * bins);
    k++;
  }
  return { data: out, frames: n, bins };
}

/** Modelin girdisi: fbank → sessizlik atılmış → ortalama çıkarılmış. */
export function features(pcm, model) {
  const x = pcm.length > MAX_SEC * RATE ? pcm.subarray(0, MAX_SEC * RATE) : pcm;
  const fb = dropSilence(fbank(x, { rate: RATE, window: model.window, scale: model.scale }));
  subtractMean(fb);
  return fb;
}

export function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/**
 * @param {object} opts
 * @param {string|object} [opts.model] katalog kimliği (models.js) ya da model nesnesi
 * @param {object} [opts.ort] onnxruntime modülü (yoksa paketli ort.wasm.min.mjs)
 * @param {(url:string, o:object)=>Promise<ArrayBuffer>} [opts.fetchModel] (yoksa model-cache.js)
 * @param {ArrayBuffer|Uint8Array} [opts.modelData] model baytları (indirmeyi atlar)
 * @param {(p:{loaded:number,total:number,url?:string,cached?:boolean})=>void} [opts.onProgress]
 * @param {object} [opts.sessionOptions]
 */
export function createEmbedder(opts = {}) {
  const model = typeof opts.model === 'object' && opts.model ? opts.model : spkModelById(opts.model);
  if (!model) throw new Error(`Bilinmeyen konuşmacı modeli: ${opts.model}`);
  let ort = opts.ort || null;
  let session = null;
  let loading = null;
  let queue = Promise.resolve();

  async function getOrt() {
    if (!ort) {
      ort = await import('../../lib/ort/ort.wasm.min.mjs');
      ort.env.wasm.wasmPaths = new URL('../../lib/ort/', import.meta.url).href;
      ort.env.wasm.numThreads = 1;
    }
    return ort;
  }

  async function modelBytes() {
    if (opts.modelData) return opts.modelData;
    const fetchModel = opts.fetchModel || (await import('../common/model-cache.js')).fetchModel;
    const buf = await fetchModel(model.url, {
      onProgress: (p) => opts.onProgress?.({ ...p, total: p.total || model.bytes }),
    });
    if (model.bytes && buf.byteLength !== model.bytes) {
      throw new Error(`Konuşmacı modeli bozuk indi (${buf.byteLength}/${model.bytes} bayt)`);
    }
    return buf;
  }

  async function load() {
    if (session) return;
    if (!loading) {
      loading = (async () => {
        const o = await getOrt();
        const bytes = await modelBytes();
        session = await o.InferenceSession.create(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), {
          executionProviders: ['wasm'], graphOptimizationLevel: 'all', ...(opts.sessionOptions || {}),
        });
      })().catch((e) => { loading = null; throw e; });
    }
    await loading;
  }

  async function run(pcm) {
    await load();
    const fb = features(pcm, model);
    const voicedSec = fb.frames / 100;
    if (voicedSec < MIN_SPEECH_SEC) return { vector: null, voicedSec };
    const o = await getOrt();
    const out = await session.run({ [model.input]: new o.Tensor('float32', fb.data, [1, fb.frames, fb.bins]) });
    const t = out[model.output] || out[Object.keys(out)[0]];
    return { vector: normalize(t.data), voicedSec };
  }

  return {
    model,
    load,
    /** Çağrılar sıraya girer (tek oturum). */
    embed(pcm) {
      const p = queue.then(() => run(pcm));
      queue = p.catch(() => {});
      return p;
    },
    async dispose() {
      try { await session?.release?.(); } catch { /* yoksay */ }
      session = null;
      loading = null;
    },
  };
}
