// EMA Lightning inference (canberkkkkkk/ema-lightning, Apache-2.0; ONNX export: ozcancelik/ema-lightning-onnx):
// 48 kHz, one female voice, character input (Turkish letters + punctuation, see meta.json's vocab).
//
// Ported to plain JavaScript from Harfiyen (https://github.com/ozcancelik/harfiyen, MIT License,
// Copyright (c) 2026 Özcan Çelik): src/tts/ema.ts. The text frontend and chunker are shared with ahenk.js
// (same family, same code).
//
// Pipeline per piece: text.onnx (ids) -> h, durations; sound.onnx (h, frame alignment, noise) runs the model's four
// flow steps internally and returns the latents; decoder.onnx turns them into audio in 100-frame windows.
// Speed is applied to the predicted durations, i.e. natively. The model has no style input and its flow steps are
// baked into the graph, so style/temperature/steps from the tone table are ignored (pitch still applies in core.js).

import { alphabet, chunk, words, pieces, UNSAFE } from './ahenk.js';
import { concat } from './dsp.js';

export { alphabet, chunk, words, UNSAFE };

const WINDOW = 100;
const CONTEXT = 8;
const MAX_WORD_FRAMES = 250;
const MAX_FRAMES = 3000;

/** Seeded standard-normal generator (mulberry32 + Box-Muller). */
export function gaussian(seed) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (n) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 2) {
      const r = Math.sqrt(-2 * Math.log(1 - u()));
      const th = 2 * Math.PI * u();
      out[i] = r * Math.cos(th);
      if (i + 1 < n) out[i + 1] = r * Math.sin(th);
    }
    return out;
  };
}

/** Frame alignment of one piece: per-frame word index, per-letter and per-frame global positions. */
export function plan(cw, wstart, dur, speed) {
  const L = cw.length;
  const nWords = cw[L - 1] + 1;
  const d = Float32Array.from(dur, (x) => x / speed);
  const sums = new Float64Array(nWords);
  for (let i = 0; i < L; i++) sums[cw[i]] += d[i];
  const counts = Array.from(sums, (s) => Math.min(MAX_WORD_FRAMES, Math.max(1, Math.round(s))));
  const T = Math.min(counts.reduce((a, b) => a + b, 0), MAX_FRAMES);
  const fw = new Int32Array(T);
  const fp = new Float32Array(T);
  for (let w = 0, f = 0; w < nWords; w++) for (let j = 0; j < counts[w] && f < T; j++, f++) {
    fw[f] = w;
    fp[f] = j / counts[w];
  }
  const c = Float32Array.from(d, (x) => Math.max(x, 1e-4));
  const done = new Float32Array(L);
  const total = new Float32Array(nWords);
  for (let i = 0, acc = 0; i < L; i++) {
    acc += c[i];
    done[i] = acc;
    total[cw[i]] += c[i];
  }
  const before = (i) => done[i] - c[i];
  const wlen = new Float32Array(nWords);
  for (const w of cw) wlen[w] += 1;
  const woff = new Float32Array(nWords);
  for (let w = 1; w < nWords; w++) woff[w] = woff[w - 1] + Math.max(wlen[w - 1], 1);
  const cg = new Float32Array(L);
  const fg = new Float32Array(T);
  for (let i = 0; i < L; i++) {
    const cp = Math.min(1, Math.max(0, (done[i] - before(wstart[i]) - 0.5 * c[i]) / Math.max(total[cw[i]], 1e-8)));
    cg[i] = woff[cw[i]] + cp * Math.max(wlen[cw[i]], 1);
  }
  for (let f = 0; f < T; f++) fg[f] = woff[fw[f]] + fp[f] * Math.max(wlen[fw[f]], 1);
  return { T, fw, cg, fg };
}

const tensorData = async (t) => (typeof t.getData === 'function' ? t.getData() : t.data);
const dispose = (t) => t && typeof t.dispose === 'function' && t.dispose();

export class Ema {
  /** @param sessions { text, sound, decoder } InferenceSessions; meta: meta.json */
  constructor(ort, meta, sessions) {
    this.ort = ort;
    this.m = meta;
    this.sessions = sessions;
    this.stoi = new Map(meta.vocab.map((c, i) => [c, i]));
    this.alpha = new Set(meta.vocab.filter((v) => v.length === 1));
    this.sampleRate = meta.sample_rate;
    this.styles = []; // tek ses, stil gömmesi yok
  }

  static async create(ort, meta, buffers, sessionOptions) {
    // sequential: the wasm runtime rejects concurrent initialisation
    const s = {};
    for (const k of ['text', 'sound', 'decoder']) s[k] = await ort.InferenceSession.create(buffers[k], sessionOptions);
    return new Ema(ort, meta, s);
  }

  /** Text -> 48 kHz mono audio. speed > 1 speaks faster. isCancelled() is polled between pieces. */
  async speak(text, { speed = 1, seed = 0, isCancelled, normalized = false } = {}) {
    const { ort, m } = this;
    const { text: textGraph, sound, decoder } = this.sessions;
    const i64 = (a) => new ort.Tensor('int64', BigInt64Array.from(a, (x) => BigInt(x)), [1, a.length]);
    const f32 = (a, d) => new ort.Tensor('float32', a, d);
    const nSteps = m.times.length;
    const D = m.latent_dim;
    const rate = this.sampleRate;
    const out = [];
    const parts = pieces(text, speed, this.alpha, normalized);
    for (let k = 0; k < parts.length; k++) {
      if (isCancelled && isCancelled()) throw new DOMException('Aborted', 'AbortError');
      const [piece, pause] = parts[k];
      const ids = [...piece].map((ch) => this.stoi.get(ch) ?? 1);
      const { cw, wstart } = words(piece);
      const t1 = await textGraph.run({ ids: i64(ids) });
      const p = plan(cw, wstart, await tensorData(t1.dur), speed);
      const noise = gaussian(seed * 1000003 + k)(nSteps * p.T * D);
      const { latents } = await sound.run({
        h: t1.h,
        cg: f32(p.cg, [1, p.cg.length]),
        fg: f32(p.fg, [1, p.T]),
        cw: i64(cw),
        fw: i64(Array.from(p.fw)),
        noise: f32(noise, [1, nSteps, p.T, D]),
      });
      dispose(t1.h);
      dispose(t1.dur);
      const lat = await tensorData(latents);
      const T = p.T;
      for (let s = 0; s < T; s += WINDOW) {
        const e = Math.min(T, s + WINDOW);
        const a = Math.max(0, s - CONTEXT);
        const b = Math.min(T, e + CONTEXT);
        const n = b - a;
        const z = new Float32Array(D * n); // [1, D, n]
        for (let fr = 0; fr < n; fr++) for (let d = 0; d < D; d++) z[d * n + fr] = lat[(a + fr) * D + d];
        const { audio } = await decoder.run({ z: f32(z, [1, D, n]) });
        out.push((await tensorData(audio)).slice((s - a) * m.hop, (e - a) * m.hop));
        dispose(audio);
      }
      dispose(latents);
      if (pause) out.push(new Float32Array(Math.round(pause * rate)));
    }
    return concat(out);
  }

  async release() {
    for (const s of Object.values(this.sessions)) await s.release?.();
  }
}
