// Supertonic 3 inference (Supertone/supertonic-3; weights OpenRAIL-M, sample code MIT): 31 languages incl. Turkish,
// 44.1 kHz, unicode character input, ten preset voices (F1–F5, M1–M5) given as style vectors.
//
// Ported to plain JavaScript from the official web example (github.com/supertone-inc/supertonic, web/helper.js,
// MIT License, Copyright (c) 2025 Supertone Inc.): same text preprocessing and graph calls, but flat typed arrays
// instead of nested arrays, seeded noise and the speak() interface of the other voices.
//
// Pipeline per piece: duration_predictor (ids, style_dp) -> seconds; text_encoder (ids, style_ttl) -> text_emb;
// `steps` calls of vector_estimator from Gaussian noise; vocoder -> audio. Speed divides the predicted duration,
// i.e. natively. A voice is only a pair of style tensors, so presets are swapped (or blended) per call for free.

import { gaussian } from './ema.js';
import { concat } from './dsp.js';

export const LANG = 'tr';
/** Characters per model call (the official chunker's limit for alphabetic languages). */
const MAX_LEN = 300;
const PIECE_PAUSE = 0.2;
/** The release's own pace: the examples call the model with speed 1.05. */
const BASE_SPEED = 1.05;
export const DEFAULT_STEPS = 8;

const REPLACEMENTS = {
  '–': '-', '‑': '-', '—': '-', _: ' ', '“': '"', '”': '"', '‘': "'", '’': "'", '´': "'", '`': "'",
  '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ', '→': ' ', '←': ' ',
};
const EMOJI = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F7FF}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;

/** The official preprocessing (helper.js preprocessText), wrapped in language tags. */
export function preprocess(text, lang = LANG) {
  text = text.normalize('NFKD').replace(EMOJI, '');
  for (const [k, v] of Object.entries(REPLACEMENTS)) text = text.replaceAll(k, v);
  text = text.replace(/[♥☆♡©\\]/g, '').replaceAll('@', ' at ');
  text = text.replace(/ ([,.!?;:'])/g, '$1');
  text = text.replace(/"{2,}/g, '"').replace(/'{2,}/g, "'");
  text = text.replace(/\s+/g, ' ').trim();
  if (!/[.!?;:,'")\]}…]$/.test(text)) text += '.';
  return `<${lang}>${text}</${lang}>`;
}

/** Split at sentence ends into pieces of at most `max` characters (helper.js chunkText, one paragraph). */
export function chunk(text, max = MAX_LEN) {
  const out = [];
  let cur = '';
  for (const s of text.trim().split(/(?<=[.!?])\s+/)) {
    if (cur && cur.length + 1 + s.length > max) {
      out.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out.filter((p) => /\p{L}/u.test(p));
}

/** A voice-style JSON ({ style_ttl, style_dp: { data, dims } }) -> flat Float32Arrays. */
export function parseStyle(json) {
  const flat = (t) => ({ data: Float32Array.from(t.data.flat(Infinity)), dims: t.dims });
  return { ttl: flat(json.style_ttl), dp: flat(json.style_dp) };
}

/** Linear blend of two styles: (1 - amount)·a + amount·b. */
export function blendStyles(a, b, amount) {
  if (!b || !(amount > 0)) return a;
  const t = Math.min(1, amount);
  const mix = (x, y) => ({ data: x.data.map((v, i) => v + (y.data[i] - v) * t), dims: x.dims });
  return { ttl: mix(a.ttl, b.ttl), dp: mix(a.dp, b.dp) };
}

const tensorData = async (t) => (typeof t.getData === 'function' ? t.getData() : t.data);
const dispose = (t) => t && typeof t.dispose === 'function' && t.dispose();

export class Supertonic {
  /**
   * @param cfg tts.json; indexer unicode_indexer.json (code point -> id); styles { F1: parsed style, ... }
   * @param sessions { duration, text, vector, vocoder } InferenceSessions
   */
  constructor(ort, cfg, indexer, styles, sessions, opts = {}) {
    this.ort = ort;
    this.cfg = cfg;
    this.indexer = indexer;
    this.presets = styles;
    this.sessions = sessions;
    this.steps = opts.steps || DEFAULT_STEPS;
    this.sampleRate = cfg.ae.sample_rate;
    this.styles = []; // Ahenk-style names: none (style here = preset voice)
    this.blendCache = new Map();
  }

  /** buffers: { duration, text, vector, vocoder (bytes) }; indexer: array; styles: { key: style JSON } */
  static async create(ort, cfg, indexer, styleJson, buffers, sessionOptions, opts = {}) {
    const s = {};
    // sequential: the wasm runtime rejects concurrent initialisation
    for (const k of ['duration', 'text', 'vector', 'vocoder']) s[k] = await ort.InferenceSession.create(buffers[k], sessionOptions);
    const styles = {};
    for (const [k, v] of Object.entries(styleJson)) styles[k] = parseStyle(v);
    return new Supertonic(ort, cfg, indexer, styles, s, opts);
  }

  /** Style of a preset key, optionally blended with another preset ({ with, amount }). */
  style(preset, blend) {
    const base = this.presets[preset] || Object.values(this.presets)[0];
    const other = blend?.with && blend.with !== preset ? this.presets[blend.with] : null;
    if (!other || !(blend.amount > 0)) return base;
    const key = `${preset}|${blend.with}|${blend.amount}`;
    if (!this.blendCache.has(key)) {
      if (this.blendCache.size > 8) this.blendCache.clear();
      this.blendCache.set(key, blendStyles(base, other, blend.amount));
    }
    return this.blendCache.get(key);
  }

  ids(text) {
    const t = preprocess(text);
    const ids = new BigInt64Array(t.length);
    for (let j = 0; j < t.length; j++) {
      const cp = t.charCodeAt(j);
      ids[j] = BigInt(cp < this.indexer.length ? this.indexer[cp] : -1);
    }
    return ids;
  }

  /**
   * Text -> 44.1 kHz mono audio. speed > 1 speaks faster. isCancelled() is polled between pieces and steps.
   * preset: voice key ('F1'…'M5'); blend: { with: key, amount: 0..1 }; steps: denoising steps (default 8).
   */
  async speak(text, { speed = 1, seed = 0, isCancelled, preset, blend, steps: stepsOpt } = {}) {
    const { ort, cfg } = this;
    const { duration, text: textEnc, vector, vocoder } = this.sessions;
    const st = this.style(preset, blend);
    const steps = stepsOpt || this.steps;
    const chunkSize = cfg.ae.base_chunk_size * cfg.ttl.chunk_compress_factor;
    const latentDim = cfg.ttl.latent_dim * cfg.ttl.chunk_compress_factor;
    const f32 = (a, d) => new ort.Tensor('float32', a, d);
    const out = [];
    const parts = chunk(text);
    for (let k = 0; k < parts.length; k++) {
      if (isCancelled && isCancelled()) throw new DOMException('Aborted', 'AbortError');
      const ids = this.ids(parts[k]);
      const L = ids.length;
      const idsT = new ort.Tensor('int64', ids, [1, L]);
      const maskT = f32(new Float32Array(L).fill(1), [1, 1, L]);
      const styleTtl = f32(st.ttl.data, st.ttl.dims);
      const styleDp = f32(st.dp.data, st.dp.dims);
      const dp = await duration.run({ text_ids: idsT, style_dp: styleDp, text_mask: maskT });
      const seconds = (await tensorData(dp.duration))[0] / (BASE_SPEED * speed);
      dispose(dp.duration);
      const { text_emb } = await textEnc.run({ text_ids: idsT, style_ttl: styleTtl, text_mask: maskT });
      const wavLen = Math.floor(seconds * this.sampleRate);
      const T = Math.max(1, Math.ceil(wavLen / chunkSize));
      let x = gaussian(seed * 1000003 + k)(latentDim * T);
      const latentMask = f32(new Float32Array(T).fill(1), [1, 1, T]);
      const total = f32(Float32Array.of(steps), [1]);
      for (let s = 0; s < steps; s++) {
        if (isCancelled && isCancelled()) throw new DOMException('Aborted', 'AbortError');
        const r = await vector.run({
          noisy_latent: f32(x, [1, latentDim, T]),
          text_emb,
          style_ttl: styleTtl,
          latent_mask: latentMask,
          text_mask: maskT,
          current_step: f32(Float32Array.of(s), [1]),
          total_step: total,
        });
        x = Float32Array.from(await tensorData(r.denoised_latent));
        dispose(r.denoised_latent);
      }
      dispose(text_emb);
      const { wav_tts } = await vocoder.run({ latent: f32(x, [1, latentDim, T]) });
      out.push((await tensorData(wav_tts)).slice(0, wavLen));
      dispose(wav_tts);
      if (k < parts.length - 1) out.push(new Float32Array(Math.round(PIECE_PAUSE * this.sampleRate)));
    }
    return concat(out);
  }

  async release() {
    for (const s of Object.values(this.sessions)) await s.release?.();
  }
}
