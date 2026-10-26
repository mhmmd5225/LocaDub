// EN -> TR translation check with onnxruntime-node, using the extension's own tokenizer, ONNX patching,
// preprocessing and decoding code (extension/engines/mt/*.js).
//
//   cd tests/mt && npm install && node translate.node.mjs [--variant int8|int8-slim|q4-slim|all]
//        [--runtime node|web] [--threads N] [--batch N] [--models DIR]
//
// Model files are expected in tests/mt/.models/tc-big-en-tr/ (see download.mjs). The "slim" variants
// simulate the extension's sliced download: the float32 embedding bytes are zeroed, then rebuilt from the
// quantized copy exactly as the worker does.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MarianTranslator } from '../../extension/engines/mt/marian.js';
import { MarianTokenizer } from '../../extension/engines/mt/spm.js';
import { fillDequantized } from '../../extension/engines/mt/onnx-patch.js';
import { VARIANTS } from '../../extension/engines/mt/models.js';
import { prepareBatch, finishBatch } from '../../extension/engines/mt/preprocess.js';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const dir = arg('models', join(here, '.models', 'tc-big-en-tr'));
const runtime = arg('runtime', 'node');
const threads = Number(arg('threads', '4'));
const maxBatch = Number(arg('batch', '8'));
const variantArg = arg('variant', 'all');

export const SENTENCES = [
  'Hello everyone, and welcome back to my channel.',
  'Today we are going to learn how to make a simple website.',
  "so what i'm gonna do is open up the terminal and type this command",
  'if you like this video please subscribe and hit the bell icon',
  'The weather was terrible, but we still had a great time at the beach.',
  'This is the most important thing you need to understand about machine learning.',
  'um so basically the the idea is that you can save a lot of money',
  "I don't think that's a good idea.",
  'we have about 30 minutes left so let me quickly show you the results',
  'Can you believe it?',
  'do you know what happens when you mix these two chemicals',
  '[Music]',
  '[Applause] thank you so much',
  '',
  '>> and now back to the studio',
  'The new update fixes several bugs and improves battery life by up to 20 percent.',
  "alright guys that's it for today's video i'll see you in the next one",
  'so the first thing you want to do is preheat your oven to 350 degrees',
  "and honestly i wasn't expecting it to be this good",
  'Scientists have discovered a new species of frog in the Amazon rainforest.',
  "it's not about how fast you go it's about how consistent you are",
  '♪ never gonna give you up ♪',
  "the [ __ ] thing broke again i can't believe it",
  'how many of you have actually tried this before let me know in the comments below',
];

async function loadOrt() {
  if (runtime === 'web') {
    // The extension's packaged onnxruntime-web build, run in Node on the wasm backend.
    const lib = join(here, '..', '..', 'extension', 'lib', 'ort');
    const ort = await import(pathToFileURL(join(lib, 'ort.wasm.min.mjs')).href);
    ort.env.wasm.wasmPaths = pathToFileURL(lib + '/').href;
    ort.env.wasm.numThreads = threads;
    ort.env.wasm.wasmBinary = readFileSync(join(lib, 'ort-wasm-simd-threaded.wasm'));
    return ort;
  }
  return import('onnxruntime-node');
}

function readModel(variant) {
  const v = VARIANTS[variant];
  const enc = new Uint8Array(readFileSync(join(dir, v.encoder.file)));
  const dec = new Uint8Array(readFileSync(join(dir, v.decoder.file)));
  if (dec.length !== v.decoder.size || enc.length !== v.encoder.size) throw new Error(`${variant}: size mismatch`);
  for (const hole of v.decoder.holes ?? []) {
    dec.fill(0, hole.range[0], hole.range[1]); // what the sliced download leaves
    const t0 = performance.now();
    const src = hole.from === 'encoder' ? enc : dec;
    fillDequantized(dec, hole.tensor, src, hole.source, hole.range);
    console.log(`  rebuilt ${hole.tensor} from ${hole.from}:${hole.source} in ${(performance.now() - t0).toFixed(0)} ms`);
  }
  return { enc, dec, v };
}

async function run(ort, tokenizer, variant) {
  if (!existsSync(join(dir, VARIANTS[variant].decoder.file))) {
    console.log(`skip ${variant}: ${VARIANTS[variant].decoder.file} not downloaded`);
    return null;
  }
  console.log(`\n=== ${variant} (${runtime}, threads=${threads}, batch=${maxBatch}) download ≈ ${VARIANTS[variant].downloadMB} MB`);
  const { enc, dec } = readModel(variant);
  let t0 = performance.now();
  const sessionOptions = runtime === 'web'
    ? { executionProviders: ['wasm'] }
    : { executionProviders: ['cpu'], intraOpNumThreads: threads };
  const mt = await MarianTranslator.create(ort, { encoder: enc, decoder: dec, tokenizer, sessionOptions });
  console.log(`  sessions ready in ${(performance.now() - t0).toFixed(0)} ms`);

  const { units, plan } = prepareBatch(SENTENCES);
  // Warm-up (first run allocates).
  await mt.translate(['Hello.'], { maxBatch: 1 });

  // One sentence at a time: latency per sentence.
  const per = [];
  const single = [];
  for (const u of units) {
    t0 = performance.now();
    const [o] = await mt.translate([u], { maxBatch: 1 });
    per.push(performance.now() - t0);
    single.push(o);
  }
  const out = finishBatch(plan, single);
  SENTENCES.forEach((s, i) => console.log(`  EN: ${JSON.stringify(s)}\n  TR: ${JSON.stringify(out[i])}`));
  const avg = per.reduce((a, b) => a + b, 0) / per.length;
  console.log(`  per-sentence (batch=1): avg ${avg.toFixed(0)} ms, min ${Math.min(...per).toFixed(0)}, max ${Math.max(...per).toFixed(0)} ms over ${per.length} units`);

  // Whole list as batches.
  t0 = performance.now();
  const batched = await mt.translate(units, { maxBatch });
  const tb = performance.now() - t0;
  const same = batched.filter((x, i) => x === single[i]).length;
  console.log(`  batched (≤${maxBatch}): ${tb.toFixed(0)} ms total = ${(tb / units.length).toFixed(0)} ms/unit; identical to unbatched: ${same}/${units.length}`);
  batched.forEach((x, i) => { if (x !== single[i]) console.log(`    differs: ${JSON.stringify(single[i])} vs ${JSON.stringify(x)}`); });
  await mt.release();
  return { variant, out, avg };
}

const ort = await loadOrt();
const tokenizer = new MarianTokenizer(
  readFileSync(join(dir, 'source.spm')),
  JSON.parse(readFileSync(join(dir, 'vocab.json'), 'utf8')),
);
const variants = variantArg === 'all' ? Object.keys(VARIANTS) : variantArg.split(',');
const results = [];
for (const v of variants) results.push(await run(ort, tokenizer, v));
const ok = results.filter(Boolean);
if (ok.length > 1) {
  const [ref, ...rest] = ok;
  for (const r of rest) {
    const same = r.out.filter((x, i) => x === ref.out[i]).length;
    console.log(`\n${r.variant} vs ${ref.variant}: ${same}/${ref.out.length} identical outputs`);
  }
}
