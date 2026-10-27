#!/usr/bin/env node
// Supertonic 3 (Supertone/supertonic-3, OpenRAIL-M) Türkçe sentezi: onnxruntime-node, dört grafik
// (duration_predictor, text_encoder, vector_estimator, vocoder). Çıkarım akışı resmi Node örneğinin
// (supertone-inc/supertonic, nodejs/helper.js) yeniden yazımıdır; çıkarım Float32Array ile yapılır (hızlı), metin ön
// işlemesi aynıdır. Girdi metni, tüm adaylarda olduğu gibi, önce eklentinin Türkçe normalleştiricisinden geçer.
//
//   node synth-supertonic.mjs [--threads 4] [--voices M1,M2,F1,F2] [--steps 8] [--speed 1.0]
import * as ort from 'onnxruntime-node';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeText } from '../../../extension/engines/tts/normalize.js';
import { MODELS, THREADS, arg, runCandidate } from './lib.mjs';

const DIR = join(MODELS, 'supertonic3');
const voices = arg('--voices', 'M1,M2,M3,M4,M5,F1,F2,F3,F4,F5').split(',');
const STEPS = Number(arg('--steps', 8));
const SPEED = Number(arg('--speed', 1.0));
const LANG = 'tr';

const opts = { executionProviders: ['cpu'], intraOpNumThreads: THREADS, interOpNumThreads: 1, graphOptimizationLevel: 'all' };
const cfg = JSON.parse(readFileSync(join(DIR, 'onnx/tts.json'), 'utf8'));
const indexer = JSON.parse(readFileSync(join(DIR, 'onnx/unicode_indexer.json'), 'utf8'));
const S = {};
for (const [k, f] of [['dp', 'duration_predictor'], ['te', 'text_encoder'], ['ve', 'vector_estimator'], ['voc', 'vocoder']])
  S[k] = await ort.InferenceSession.create(join(DIR, `onnx/${f}.onnx`), opts);

const SR = cfg.ae.sample_rate;
const CHUNK = cfg.ae.base_chunk_size * cfg.ttl.chunk_compress_factor;
const LDIM = cfg.ttl.latent_dim * cfg.ttl.chunk_compress_factor;

function preprocess(text) {
  text = text.normalize('NFKD');
  text = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{27BF}]+/gu, '');
  const rep = { '–': '-', '‑': '-', '—': '-', _: ' ', '“': '"', '”': '"', '‘': "'", '’': "'", '´': "'", '`': "'", '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ' };
  for (const [k, v] of Object.entries(rep)) text = text.replaceAll(k, v);
  text = text.replace(/ ([,.!?;:'])/g, '$1').replace(/\s+/g, ' ').trim();
  if (!/[.!?;:,'")\]}…]$/.test(text)) text += '.';
  return `<${LANG}>${text}</${LANG}>`;
}

function loadStyle(name) {
  const j = JSON.parse(readFileSync(join(DIR, `voice_styles/${name}.json`), 'utf8'));
  const mk = (o) => new ort.Tensor('float32', Float32Array.from(o.data.flat(Infinity)), o.dims);
  return { ttl: mk(j.style_ttl), dp: mk(j.style_dp) };
}

const randn = () => Math.sqrt(-2 * Math.log(Math.max(1e-10, Math.random()))) * Math.cos(2 * Math.PI * Math.random());

async function speak(text, style) {
  const pre = preprocess(text);
  const ids = Array.from(pre, (c) => indexer[c.charCodeAt(0)]);
  const L = ids.length;
  const textIds = new ort.Tensor('int64', BigInt64Array.from(ids, (x) => BigInt(x)), [1, L]);
  const textMask = new ort.Tensor('float32', new Float32Array(L).fill(1), [1, 1, L]);
  const d = await S.dp.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask });
  const dur = d.duration.data[0] / SPEED;
  const te_ = await S.te.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask });
  const T = Math.floor((Math.floor(dur * SR) + CHUNK - 1) / CHUNK);
  const lat = new Float32Array(LDIM * T);
  for (let i = 0; i < lat.length; i++) lat[i] = randn();
  const mask = new ort.Tensor('float32', new Float32Array(T).fill(1), [1, 1, T]);
  const total = new ort.Tensor('float32', Float32Array.of(STEPS), [1]);
  let x = lat;
  for (let s = 0; s < STEPS; s++) {
    const r = await S.ve.run({
      noisy_latent: new ort.Tensor('float32', x, [1, LDIM, T]),
      text_emb: te_.text_emb,
      style_ttl: style.ttl,
      text_mask: textMask,
      latent_mask: mask,
      total_step: total,
      current_step: new ort.Tensor('float32', Float32Array.of(s), [1]),
    });
    x = r.denoised_latent.data;
  }
  const w = await S.voc.run({ latent: new ort.Tensor('float32', x, [1, LDIM, T]) });
  const wav = w.wav_tts.data;
  return { pcm: Float32Array.from(wav.subarray(0, Math.min(wav.length, Math.floor(SR * dur)))), sampleRate: SR };
}

for (const v of voices) {
  const style = loadStyle(v);
  await runCandidate(`supertonic3-${v}`, { model: 'https://huggingface.co/Supertone/supertonic-3', license: 'OpenRAIL-M', voice: v, steps: STEPS, speed: SPEED }, (text) =>
    speak(normalizeText(text), style),
  );
}
