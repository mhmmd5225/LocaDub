// Marian (opus-mt) encoder-decoder inference with onnxruntime: batched greedy decoding using the
// merged decoder's key/value cache.
//
// Decoding loop adapted from Harfiyen (https://github.com/ozcancelik/harfiyen), src/mt/translator.ts —
// Copyright (c) Ozcan Celik, MIT License. Changes: plain JS, batches of sentences (padded encoder input,
// lock-step decoder), repetition guard, cancellation hook, works with onnxruntime-web and -node alike
// (the `ort` module is injected).

/** Marian hyper-parameters (from the model's config.json). */
export const TC_BIG_CONFIG = {
  decoderLayers: 6,
  heads: 16,
  headDim: 64,
  maxPositions: 1024,
  decoderStart: 57059,
  eos: 43741,
  pad: 57059,
};

/** Longest input (tokens) we feed; YouTube sentences are far shorter. */
const MAX_INPUT = 256;
/** Hard cap on generated tokens per sentence. */
const MAX_OUTPUT = 256;

class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'AbortError';
  }
}

/**
 * True when `out` ends in the same n-gram repeated `times` times (a decoding loop).
 * Returns the length to keep (one copy of the n-gram), or 0.
 */
export function repetitionCut(out, times = 4, maxN = 8) {
  for (let n = 1; n <= maxN; n++) {
    if (out.length < n * times) break;
    let rep = true;
    for (let k = 1; k < times && rep; k++) {
      for (let i = 0; i < n; i++) {
        if (out[out.length - 1 - i] !== out[out.length - 1 - i - k * n]) { rep = false; break; }
      }
    }
    if (rep) return out.length - (times - 1) * n;
  }
  return 0;
}

export class MarianTranslator {
  /**
   * @param {any} ort                onnxruntime module (web or node)
   * @param {object} o
   * @param {Uint8Array} o.encoder   encoder .onnx bytes
   * @param {Uint8Array} o.decoder   merged decoder .onnx bytes (decoder_model_merged*.onnx)
   * @param {import('./spm.js').MarianTokenizer} o.tokenizer
   * @param {typeof TC_BIG_CONFIG} [o.config]
   * @param {object} [o.sessionOptions]
   */
  static async create(ort, { encoder, decoder, tokenizer, config = TC_BIG_CONFIG, sessionOptions = {} }) {
    const opts = {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      logSeverityLevel: 3,
      ...sessionOptions,
    };
    // Sequential: the wasm runtime rejects concurrent initialisation.
    const enc = await ort.InferenceSession.create(encoder, opts);
    const dec = await ort.InferenceSession.create(decoder, opts);
    return new MarianTranslator(ort, enc, dec, tokenizer, config);
  }

  constructor(ort, encoder, decoder, tokenizer, config) {
    this.ort = ort;
    this.encoder = encoder;
    this.decoder = decoder;
    this.tok = tokenizer;
    this.cfg = config;
    this.pastNames = decoder.inputNames.filter((n) => n.startsWith('past_key_values.'));
    this.hasBranch = decoder.inputNames.includes('use_cache_branch');
    if (!this.hasBranch) throw new Error('marian: a merged decoder (use_cache_branch input) is required');
  }

  encode(text) {
    return this.tok.encode(text, MAX_INPUT);
  }

  /**
   * Translates already-tokenized inputs in one lock-step batch.
   * @param {number[][]} srcs
   * @param {{shouldStop?:() => boolean}} [o]
   * @returns {Promise<number[][]>} output token ids per input
   */
  async generate(srcs, { shouldStop } = {}) {
    const { Tensor } = this.ort;
    const { heads, headDim, decoderStart, eos, pad, maxPositions } = this.cfg;
    const B = srcs.length;
    const n = Math.max(...srcs.map((s) => s.length));
    const ids = new BigInt64Array(B * n).fill(BigInt(pad));
    const maskData = new BigInt64Array(B * n);
    srcs.forEach((s, b) => {
      for (let i = 0; i < s.length; i++) {
        ids[b * n + i] = BigInt(s[i]);
        maskData[b * n + i] = 1n;
      }
    });
    const mask = new Tensor('int64', maskData, [B, n]);
    const encOut = await this.encoder.run({ input_ids: new Tensor('int64', ids, [B, n]), attention_mask: mask });
    const hidden = encOut.last_hidden_state;
    if (shouldStop?.()) throw new Cancelled();

    // Step 0 fills the cross-attention cache; later steps only grow the self-attention one.
    const past = {};
    const empty = new Tensor('float32', new Float32Array(0), [B, heads, 0, headDim]);
    for (const name of this.pastNames) past[name] = empty;

    const outs = srcs.map(() => []);
    const done = new Array(B).fill(false);
    const limits = srcs.map((s) => Math.min(maxPositions - 1, MAX_OUTPUT, 2 * s.length + 10));
    const limit = Math.max(...limits);
    let tokens = new Array(B).fill(decoderStart);
    for (let step = 0; step < limit; step++) {
      const r = await this.decoder.run({
        input_ids: new Tensor('int64', BigInt64Array.from(tokens, BigInt), [B, 1]),
        encoder_attention_mask: mask,
        encoder_hidden_states: hidden,
        use_cache_branch: new Tensor('bool', [step > 0], [1]),
        ...past,
      });
      const logits = r.logits.data;
      const V = logits.length / B;
      const next = new Array(B);
      for (let b = 0; b < B; b++) {
        if (done[b]) { next[b] = pad; continue; }
        const off = b * V;
        let best = -1;
        let bestV = -Infinity;
        for (let i = 0; i < V; i++) {
          const v = logits[off + i];
          if (v > bestV && i !== pad) { bestV = v; best = i; }
        }
        if (best === eos || step + 1 >= limits[b]) {
          done[b] = true;
          if (best !== eos) outs[b].push(best);
        } else {
          outs[b].push(best);
          const cut = repetitionCut(outs[b]);
          if (cut) { outs[b].length = cut; done[b] = true; }
        }
        next[b] = done[b] ? pad : best;
      }
      for (const name in r) {
        if (!name.startsWith('present.')) continue;
        if (step === 0 || name.includes('.decoder.')) past[name.replace('present.', 'past_key_values.')] = r[name];
      }
      if (done.every(Boolean)) break;
      if (shouldStop?.()) throw new Cancelled();
      tokens = next;
    }
    return outs;
  }

  /**
   * Translates sentences (already cleaned up). Inputs are sorted by length and decoded in batches.
   * @param {string[]} texts
   * @param {{maxBatch?:number, shouldStop?:() => boolean, onBatch?:(done:number,total:number)=>void}} [o]
   */
  async translate(texts, { maxBatch = 8, shouldStop, onBatch } = {}) {
    const result = new Array(texts.length).fill('');
    const items = [];
    texts.forEach((t, i) => {
      if (t && t.trim()) items.push({ i, ids: this.encode(t) });
    });
    items.sort((a, b) => a.ids.length - b.ids.length);
    let doneCount = 0;
    for (let k = 0; k < items.length;) {
      // Keep padding waste low: a batch spans at most ~2x length difference.
      const first = items[k].ids.length;
      let end = k + 1;
      while (end < items.length && end - k < maxBatch && items[end].ids.length <= Math.max(first * 2, first + 8)) end++;
      const batch = items.slice(k, end);
      const outs = await this.generate(batch.map((x) => x.ids), { shouldStop });
      batch.forEach((x, j) => { result[x.i] = this.tok.decode(outs[j]); });
      doneCount += batch.length;
      onBatch?.(doneCount, items.length);
      k = end;
    }
    return result;
  }

  async release() {
    await this.encoder?.release?.();
    await this.decoder?.release?.();
    this.encoder = this.decoder = null;
  }
}
