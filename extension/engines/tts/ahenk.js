// Ahenk Cep inference (ozgurguler/ahenk-cep-tr, weights CC BY 4.0): EMA Lightning architecture, 8.6M params,
// one designed female voice, 48 kHz, character input (Turkish letters + punctuation, see the manifest's vocab).
//
// Ported to plain JavaScript from Harfiyen (https://github.com/ozcancelik/harfiyen, MIT License,
// Copyright (c) 2026 Özcan Çelik): src/tts/ahenk.ts and the text-frontend/chunker parts of src/tts/ema.ts
// (commit 981902ceaef804fdb7a4edb782078c766e3b53c2). Harfiyen's code is itself a port of the model's web demo
// (github.com/ozguradmin/ahenk-turkish-tts, Apache-2.0) and of ema-lightning-web.
//
// Pipeline per piece: text.onnx (ids, style) -> h, durations; cond.onnx -> frame conditioning; `steps` Euler steps of
// step.onnx with classifier-free guidance from torch.randn-identical noise; decoder.onnx in 100-frame windows.
// Speed is applied to the predicted durations (frames / speed), i.e. natively, without time-stretching.

import { normalizeText } from './normalize.js';
import { concat } from './dsp.js';

export const RATE = 48000;

// ---------- text frontend (ema.ts) ----------

const TURKISH = new Set('çğıöşüÇĞİÖŞÜ');
const TYPOGRAPHY = {
  '’': "'", '‘': "'", 'ʼ': "'", '´': "'", '`': "'", '“': '"', '”': '"', '„': '"',
  '«': '"', '»': '"', '–': '-', '—': '-', '−': '-', '…': '...',
};
// eslint-disable-next-line no-control-regex
export const UNSAFE = /[\x00-\x08\x0b-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/g;

/** Lowercase (Turkish rules), fold accents of non-Turkish letters, drop characters outside the vocab. */
export function alphabet(text, vocab) {
  text = [...text.replace(UNSAFE, ' ')].map((ch) => TYPOGRAPHY[ch] ?? ch).join('');
  text = text.replace(/İ/g, 'i').replace(/I/g, 'ı').toLocaleLowerCase('tr');
  let out = '';
  for (let ch of text) {
    if (!TURKISH.has(ch)) ch = ch.normalize('NFKD').replace(/\p{M}/gu, '');
    out += ch && [...ch].every((c) => vocab.has(c)) ? ch : ' ';
  }
  return out.replace(/\s+/g, ' ').trim();
}

// ---------- chunker.py (ema.ts) ----------

const LETTERS_PER_SECOND = 18;
const MAX_SECONDS = 10;
const MAX_LETTERS = 250;
const SENTENCE_PAUSE = 0.25;
const CLAUSE_PAUSE = 0.12;
const CUTS = [
  [/[.!?]+["')]*(?= )/g, SENTENCE_PAUSE],
  [/[,;:](?= )/g, CLAUSE_PAUSE],
  [/\S(?= )/g, CLAUSE_PAUSE],
];

function finish(piece) {
  if (/[.!?]$/.test(piece.replace(/["')]+$/, ''))) return piece;
  return piece.replace(/[,;:\- ]+$/, '') + '.';
}

/** Pieces the model reads in one go, each with the pause (seconds) after it. */
export function chunk(text, speed) {
  const limit = Math.floor(Math.min(MAX_LETTERS, LETTERS_PER_SECOND * MAX_SECONDS * speed));
  const pieces = [];
  let rest = text.trim();
  while (rest) {
    let cut = rest.length;
    let pause = 0;
    if (rest.length > limit) {
      cut = limit;
      const head = rest.slice(0, limit + 1);
      for (const [pattern, gap] of CUTS) {
        const ends = [...head.matchAll(pattern)].map((m) => m.index + m[0].length);
        if (ends.length) {
          cut = ends[ends.length - 1];
          pause = gap;
          break;
        }
      }
    }
    const piece = rest.slice(0, cut).trim();
    rest = rest.slice(cut).trim();
    if (/\p{L}/u.test(piece)) pieces.push([finish(piece), pause]);
  }
  if (pieces.length) pieces[pieces.length - 1][1] = 0;
  return pieces;
}

/** Word index of each letter, and the first letter of that word (spaces belong to the next word). */
export function words(text) {
  const starts = [];
  for (let i = 0; i < text.length; i++) if (text[i] !== ' ' && (i === 0 || text[i - 1] === ' ')) starts.push(i);
  if (!starts.length) starts.push(0);
  const bounds = [0, ...starts.slice(1), text.length];
  const cw = [];
  const wstart = [];
  for (let w = 0; w + 1 < bounds.length; w++)
    for (let i = bounds[w]; i < bounds[w + 1]; i++) {
      cw.push(w);
      wstart.push(bounds[w]);
    }
  return { cw, wstart };
}

/** Normalized model pieces for `text` (normalizeText = trnorm + local additions, then the model alphabet). */
export function pieces(text, speed, vocab, normalized = false) {
  const spoken = (normalized ? text : normalizeText(text)).replace(UNSAFE, ' ');
  if (!spoken.trim()) return [];
  return chunk(alphabet(spoken, vocab), speed);
}

// ---------- torch.randn's CPU noise from a seed (ahenk.ts) ----------

class MT19937 {
  constructor(seed) {
    this.mt = new Uint32Array(624);
    this.index = 624;
    this.mt[0] = seed >>> 0;
    for (let j = 1; j < 624; j++) {
      const p = this.mt[j - 1] ^ (this.mt[j - 1] >>> 30);
      this.mt[j] = (Math.imul(1812433253, p) + j) >>> 0;
    }
  }

  twist() {
    const mt = this.mt;
    for (let i = 0; i < 624; i++) {
      const y = (mt[i] & 0x80000000) | (mt[(i + 1) % 624] & 0x7fffffff);
      let v = mt[(i + 397) % 624] ^ (y >>> 1);
      if (y & 1) v ^= 0x9908b0df;
      mt[i] = v >>> 0;
    }
    this.index = 0;
  }

  next() {
    if (this.index >= 624) this.twist();
    let y = this.mt[this.index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }
}

const f = Math.fround;

function torchRandn(seed, n) {
  const gen = new MT19937(Number(seed & 0xffffffffn));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (gen.next() & 0xffffff) * 5.9604644775390625e-8; // 2 ** -24
  for (let b = 0; b < n; b += 16)
    for (let j = 0; j < 8; j++) {
      const radius = f(Math.sqrt(f(-2 * f(Math.log(f(1 - out[b + j]))))));
      const theta = f(2 * Math.PI * out[b + j + 8]);
      out[b + j] = f(radius * f(Math.cos(theta)));
      out[b + j + 8] = f(radius * f(Math.sin(theta)));
    }
  return out;
}

const pieceSeed = (seed, i) => (BigInt(seed) * 1000003n + BigInt(i)) % (1n << 63n);

// ---------- engine (ahenk.ts) ----------

function roundHalfEven(x) {
  const fl = Math.floor(x);
  const d = x - fl;
  if (d !== 0.5) return d > 0.5 ? fl + 1 : fl;
  return fl % 2 === 0 ? fl : fl + 1;
}

function plan(dur, cw, speed, maxWord, maxFrames) {
  const L = cw.length;
  const s = f(speed);
  const d = new Float32Array(L);
  for (let i = 0; i < L; i++) d[i] = dur[i] / s;
  const nWords = cw[L - 1] + 1;
  const sums = new Float32Array(nWords);
  for (let i = 0; i < L; i++) sums[cw[i]] += d[i];
  const counts = Array.from(sums, (x) => Math.min(maxWord, Math.max(1, roundHalfEven(x))));
  const T = Math.min(counts.reduce((a, b) => a + b, 0), maxFrames);
  const fw = new BigInt64Array(T);
  const fp = new Float32Array(T);
  for (let w = 0, k = 0; w < nWords && k < T; w++)
    for (let j = 0; j < counts[w] && k < T; j++, k++) {
      fw[k] = BigInt(w);
      fp[k] = j / counts[w];
    }
  return { dur: d, fw, fp, T };
}

const tensorData = async (t) => (typeof t.getData === 'function' ? t.getData() : t.data);
const dispose = (t) => t && typeof t.dispose === 'function' && t.dispose();

export class Ahenk {
  /**
   * @param ort onnxruntime module (web or node)
   * @param manifest ahenk-cep.json
   * @param sessions { text, cond, step, decoder } InferenceSessions
   * @param opts { steps?: number } fewer Euler steps = faster (README: 8 steps loses little)
   */
  constructor(ort, manifest, sessions, opts = {}) {
    this.ort = ort;
    this.m = manifest;
    this.sessions = sessions;
    this.steps = opts.steps || manifest.defaults.steps;
    this.stoi = new Map(manifest.vocab.map((ch, i) => [ch, i]));
    this.alpha = new Set(manifest.vocab.filter((v) => v.length === 1));
    this.sampleRate = manifest.sample_rate || RATE;
    this.styles = manifest.styles || []; // stil adları (indeks = text.onnx'un style girdisi)
  }

  static async create(ort, manifest, buffers, sessionOptions, opts) {
    // sequential: the wasm runtime rejects concurrent initialisation
    const s = {};
    for (const k of ['text', 'cond', 'step', 'decoder']) s[k] = await ort.InferenceSession.create(buffers[k], sessionOptions);
    return new Ahenk(ort, manifest, s, opts);
  }

  /**
   * Text -> 48 kHz mono audio. speed > 1 speaks faster. isCancelled() is polled between pieces.
   * style: a name from the manifest's styles (unknown -> 'neutral'); steps: flow steps for this call (default: this.steps).
   */
  async speak(text, { speed = 1, seed = 0, isCancelled, normalized = false, style = 'neutral', steps: stepsOpt } = {}) {
    const { ort, m } = this;
    const { text: textGraph, cond: condGraph, step: stepGraph, decoder } = this.sessions;
    const i64 = (arr) => BigInt64Array.from(arr, (x) => BigInt(x));
    const f32 = (arr, dims) => new ort.Tensor('float32', arr, dims);
    const scalar = (x) => f32(Float32Array.of(x), [1]);
    const D = m.latent_dim;
    const steps = stepsOpt || this.steps;
    const { cfg } = m.defaults;
    const { window, context, max_word_frames, max_frames } = m.limits;
    const styleIdx = m.styles.indexOf(style) >= 0 ? m.styles.indexOf(style) : Math.max(0, m.styles.indexOf('neutral'));
    const out = [];
    const parts = pieces(text, speed, this.alpha, normalized);
    for (let k = 0; k < parts.length; k++) {
      if (isCancelled && isCancelled()) throw new DOMException('Aborted', 'AbortError');
      const [piece, pause] = parts[k];
      const ids = [...piece].map((ch) => this.stoi.get(ch) ?? 1);
      const { cw, wstart } = words(piece);
      const L = ids.length;
      const t1 = await textGraph.run({
        ids: new ort.Tensor('int64', i64(ids), [1, L]),
        style: new ort.Tensor('int64', BigInt64Array.of(BigInt(styleIdx)), [1]),
      });
      const p = plan(await tensorData(t1.dur), cw, speed, max_word_frames, max_frames);
      const { cond } = await condGraph.run({
        h: t1.h,
        dur: f32(p.dur, [1, L]),
        cw: new ort.Tensor('int64', i64(cw), [1, L]),
        wstart: new ort.Tensor('int64', i64(wstart), [1, L]),
        fw: new ort.Tensor('int64', p.fw, [1, p.T]),
        fp: f32(p.fp, [1, p.T]),
      });
      dispose(t1.h);
      dispose(t1.dur);
      let x = f32(torchRandn(pieceSeed(seed, k), p.T * D), [1, p.T, D]);
      const dt = scalar(1 / steps);
      const g = scalar(cfg);
      for (let s = 0; s < steps; s++) {
        const { x_next } = await stepGraph.run({ x, cond, t: scalar(s / steps), dt, cfg: g });
        dispose(x);
        x = x_next;
      }
      dispose(cond);
      const lat = await tensorData(x); // [T, D]
      const T = p.T;
      for (let s = 0; s < T; s += window) {
        const e = Math.min(T, s + window);
        const a = Math.max(0, s - context);
        const b = Math.min(T, e + context);
        const n = b - a;
        const z = new Float32Array(D * n); // [1, D, n]
        for (let fr = 0; fr < n; fr++) for (let d = 0; d < D; d++) z[d * n + fr] = lat[(a + fr) * D + d];
        const { audio } = await decoder.run({ z: f32(z, [1, D, n]) });
        out.push((await tensorData(audio)).slice((s - a) * m.hop, (e - a) * m.hop));
        dispose(audio);
      }
      dispose(x);
      if (pause) out.push(new Float32Array(Math.round(pause * RATE)));
    }
    return concat(out);
  }

  async release() {
    for (const s of Object.values(this.sessions)) await s.release?.();
  }
}
