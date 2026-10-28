#!/usr/bin/env node
// End-to-end synthesis test: the extension's own normalization + inference code (extension/engines/tts/core.js)
// run with onnxruntime-node, writing WAV files to tests/tts/out/ and reporting duration and RTF.
//
//   npm install                       (in tests/tts)
//   node ../../tools/tts/fetch-models.mjs
//   node synth.mjs [--threads N] [--voice id] [--steps N]
//
// THREADS defaults to 1 to approximate the extension's offscreen document, which is not cross-origin isolated and
// therefore runs onnxruntime-web WASM single-threaded (native CPU kernels are still faster than WASM SIMD, so
// browser RTF will be somewhat higher; see README).

import * as ort from 'onnxruntime-node';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VOICES } from '../../extension/engines/tts/voices.js';
import { loadVoice, synthesizeText, releaseVoice } from '../../extension/engines/tts/core.js';
import { encodeWav } from '../../extension/engines/tts/dsp.js';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const THREADS = Number(arg('--threads', process.env.THREADS || 1));
const ONLY = arg('--voice', null);
const STEPS = arg('--steps', null);
const MODELS = resolve(arg('--models', join(here, '.models')));
const OUT = join(here, 'out');

export const SENTENCES = [
  'Merhaba arkadaşlar, bugün yapay zekânın geleceği hakkında konuşacağız.',
  "Toplantı saat 14:30'da başlayacak ve yaklaşık 45 dakika sürecek.",
  "Şirketin geliri %12,5 artarak 3,5 milyar TL'ye ulaştı.",
  'Dr. Ahmet Yılmaz, 3. bölümde NASA ve AI konularını vb. örneklerle anlattı.',
  "Elon Musk, SpaceX'in 2026 yılında Mars'a 1.000 kişi göndereceğini söyledi.",
  'Fiyatı 19,99 $ olan bu ürün, 21. yüzyılın en çok satanları arasında; peki neden bu kadar popüler?',
  'Bu videoyu beğendiyseniz kanalıma abone olmayı unutmayın. Bir sonraki videoda görüşmek üzere, hoşça kalın!',
];
const SPEEDS = [1.0, 1.4, 2.0];

const fileOf = (voice, f) => join(MODELS, voice.pack || voice.id, f.url.split('/').pop());
const fmt = (x, d = 3) => x.toFixed(d);

await mkdir(OUT, { recursive: true });
const report = [];
for (const def of VOICES.filter((v) => !ONLY || v.id === ONLY)) {
  const buffers = {};
  for (const f of def.files) buffers[f.name] = await readFile(fileOf(def, f));
  const tl = performance.now();
  const voice = await loadVoice(ort, def, buffers, {
    sessionOptions: { executionProviders: ['cpu'], intraOpNumThreads: THREADS, interOpNumThreads: 1 },
    steps: STEPS ? Number(STEPS) : undefined,
  });
  const loadMs = performance.now() - tl;
  // warm-up (first runs allocate)
  await synthesizeText(voice, 'Merhaba.', {});
  console.log(`\n== ${def.id} (${def.gender}, ${def.license}) load ${fmt(loadMs / 1000, 2)} s, threads ${THREADS}`);
  let totalAudio = 0;
  let totalCompute = 0;
  for (let i = 0; i < SENTENCES.length; i++) {
    const { pcm, sampleRate, stats } = await synthesizeText(voice, SENTENCES[i], { speed: 1 });
    const path = join(OUT, `${def.id}_${String(i + 1).padStart(2, '0')}.wav`);
    await writeFile(path, encodeWav(pcm, sampleRate));
    totalAudio += stats.seconds;
    totalCompute += stats.computeSec;
    console.log(`[${i + 1}] ${fmt(stats.seconds, 2)} s audio, ${fmt(stats.computeSec, 2)} s compute, RTF ${fmt(stats.rtf)}  ${path}`);
    console.log(`    in : ${SENTENCES[i]}`);
    console.log(`    say: ${stats.normalized}`);
    report.push({ voice: def.id, i: i + 1, speed: 1, seconds: stats.seconds, compute: stats.computeSec, rtf: stats.rtf, path: basename(path) });
  }
  console.log(`   total ${fmt(totalAudio, 2)} s audio / ${fmt(totalCompute, 2)} s compute = RTF ${fmt(totalCompute / totalAudio)}`);
  // speed control on one sentence
  for (const sp of SPEEDS) {
    const { pcm, sampleRate, stats } = await synthesizeText(voice, SENTENCES[1], { speed: sp });
    const path = join(OUT, `${def.id}_speed_${sp.toFixed(1)}.wav`);
    await writeFile(path, encodeWav(pcm, sampleRate));
    console.log(`   speed ${sp.toFixed(1)} (native ${stats.native}, stretch ${fmt(stats.stretch, 2)}): ${fmt(stats.seconds, 2)} s, RTF ${fmt(stats.rtf)}  ${path}`);
    report.push({ voice: def.id, i: 2, speed: sp, seconds: stats.seconds, compute: stats.computeSec, rtf: stats.rtf, path: basename(path) });
  }
  await releaseVoice(voice);
}
await writeFile(join(OUT, 'report.json'), JSON.stringify({ threads: THREADS, steps: STEPS, report }, null, 2));
