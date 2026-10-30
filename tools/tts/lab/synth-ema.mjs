#!/usr/bin/env node
// EMA Lightning (canberkkkkkk/ema-lightning, Apache-2.0; ONNX: ozcancelik/ema-lightning-onnx) Türkçe sentezi.
// Çıkarım akışı Harfiyen'in src/tts/ema.ts dosyasından (MIT, github.com/ozcancelik/harfiyen) taşınmıştır; metin
// ön ucu (alphabet/chunk/words) eklentideki ahenk.js'ten salt-okunur içe aktarılır (aynı kod, aynı ailenin
// mimarisi). Metin, tüm adaylarda olduğu gibi, önce eklentinin Türkçe normalleştiricisinden geçer.
//
//   node synth-ema.mjs [--threads 4] [--fp16]
import * as ort from 'onnxruntime-node';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeText } from '../../../extension/engines/tts/normalize.js';
import { alphabet, chunk, words, UNSAFE } from '../../../extension/engines/tts/ahenk.js';
import { MODELS, THREADS, arg, runCandidate } from './lib.mjs';

const DIR = join(MODELS, 'ema');
const FP16 = process.argv.includes('--fp16');
const meta = JSON.parse(readFileSync(join(DIR, 'meta.json'), 'utf8'));
const RATE = meta.sample_rate;
const WINDOW = 100, CONTEXT = 8, MAX_WORD_FRAMES = 250, MAX_FRAMES = 3000;
const opts = { executionProviders: ['cpu'], intraOpNumThreads: THREADS, interOpNumThreads: 1, graphOptimizationLevel: 'all' };
const S = {
  text: await ort.InferenceSession.create(join(DIR, 'text.onnx'), opts),
  sound: await ort.InferenceSession.create(join(DIR, FP16 ? 'fp16/sound.onnx' : 'sound.onnx'), opts),
  decoder: await ort.InferenceSession.create(join(DIR, 'decoder.onnx'), opts),
};
const stoi = new Map(meta.vocab.map((c, i) => [c, i]));
const alpha = new Set(meta.vocab.filter((v) => v.length === 1));
const i64 = (a) => new ort.Tensor('int64', BigInt64Array.from(a, (x) => BigInt(x)), [1, a.length]);
const f32 = (a, d) => new ort.Tensor('float32', a, d);

function gaussian(seed) {
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

function plan(cw, wstart, dur, speed) {
  const L = cw.length;
  const nWords = cw[L - 1] + 1;
  const d = Float32Array.from(dur, (x) => x / speed);
  const sums = new Float64Array(nWords);
  for (let i = 0; i < L; i++) sums[cw[i]] += d[i];
  const counts = Array.from(sums, (s) => Math.min(MAX_WORD_FRAMES, Math.max(1, Math.round(s))));
  const T = Math.min(counts.reduce((a, b) => a + b, 0), MAX_FRAMES);
  const fw = new Int32Array(T), fp = new Float32Array(T);
  for (let w = 0, f = 0; w < nWords; w++) for (let j = 0; j < counts[w] && f < T; j++, f++) { fw[f] = w; fp[f] = j / counts[w]; }
  const c = Float32Array.from(d, (x) => Math.max(x, 1e-4));
  const done = new Float32Array(L), total = new Float32Array(nWords);
  for (let i = 0, acc = 0; i < L; i++) { acc += c[i]; done[i] = acc; total[cw[i]] += c[i]; }
  const before = (i) => done[i] - c[i];
  const wlen = new Float32Array(nWords);
  for (const w of cw) wlen[w] += 1;
  const woff = new Float32Array(nWords);
  for (let w = 1; w < nWords; w++) woff[w] = woff[w - 1] + Math.max(wlen[w - 1], 1);
  const cg = new Float32Array(L), fg = new Float32Array(T);
  for (let i = 0; i < L; i++) {
    const cp = Math.min(1, Math.max(0, (done[i] - before(wstart[i]) - 0.5 * c[i]) / Math.max(total[cw[i]], 1e-8)));
    cg[i] = woff[cw[i]] + cp * Math.max(wlen[cw[i]], 1);
  }
  for (let f = 0; f < T; f++) fg[f] = woff[fw[f]] + fp[f] * Math.max(wlen[fw[f]], 1);
  return { T, fw, cg, fg };
}

async function speak(text, speed = 1, seed = 0) {
  const spoken = alphabet(normalizeText(text).replace(UNSAFE, ' '), alpha);
  const nSteps = meta.times.length, D = meta.latent_dim, hop = meta.hop;
  const out = [];
  const pieces = chunk(spoken, speed);
  for (let k = 0; k < pieces.length; k++) {
    const [piece, pause] = pieces[k];
    const ids = [...piece].map((ch) => stoi.get(ch) ?? 1);
    const { cw, wstart } = words(piece);
    const { h, dur } = await S.text.run({ ids: i64(ids) });
    const { T, fw, cg, fg } = plan(cw, wstart, await dur.getData(), speed);
    const noise = gaussian(seed * 1000003 + k)(nSteps * T * D);
    const { latents } = await S.sound.run({ h, cg: f32(cg, [1, cg.length]), fg: f32(fg, [1, T]), cw: i64(cw), fw: i64(Array.from(fw)), noise: f32(noise, [1, nSteps, T, D]) });
    const lat = await latents.getData();
    for (let s = 0; s < T; s += WINDOW) {
      const e = Math.min(T, s + WINDOW), a = Math.max(0, s - CONTEXT), b = Math.min(T, e + CONTEXT), n = b - a;
      const z = new Float32Array(D * n);
      for (let f = 0; f < n; f++) for (let d = 0; d < D; d++) z[d * n + f] = lat[(a + f) * D + d];
      const { audio } = await S.decoder.run({ z: f32(z, [1, D, n]) });
      out.push((await audio.getData()).slice((s - a) * hop, (e - a) * hop));
    }
    if (pause) out.push(new Float32Array(Math.round(pause * RATE)));
  }
  const all = new Float32Array(out.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of out) { all.set(c, o); o += c.length; }
  return all;
}

await runCandidate(FP16 ? 'ema-lightning-fp16' : 'ema-lightning', { model: 'https://huggingface.co/ozcancelik/ema-lightning-onnx', license: 'Apache-2.0', voice: 'tek ses', fp16: FP16 }, async (text) => ({
  pcm: await speak(text),
  sampleRate: RATE,
}));
