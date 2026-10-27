// EN → TR çeviri kıyası: OPUS-MT (eklentinin kendi kodu) ile TranslateGemma 4B (transformers.js) aynı cümlelerde.
// Kalite chrF ve BLEU ile ölçülür (sacrebleu); hız bu makinenin CPU'sunda ölçülür (tarayıcıdaki WebGPU hızını yansıtmaz).
//
//   cd tests/mt && ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install
//   node ../../tools/mt/download-test-models.mjs int8-slim          # OPUS-MT dosyaları
//   pip install sacrebleu                                            # puanlama ve WMT18 verisi
//   node compare.mjs [--n 100] [--systems opus,gemma] [--threads 4]
//
// Veri: WMT18 haber testi EN→TR (sacrebleu indirir, .data/ altına), ≤ 25 sözcüklü ilk N cümle. Her cümle iki biçimde
// çevrilir: "metin" (özgün) ve "asr" (küçük harf, noktalamasız — YouTube otomatik altyazısına benzer). Gemma modeli
// (≈3.1 GB, q4) ilk çalıştırmada indirilir. Çıktılar .out/ altına yazılır.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { MarianTranslator } from '../../extension/engines/mt/marian.js';
import { MarianTokenizer } from '../../extension/engines/mt/spm.js';
import { fillDequantized } from '../../extension/engines/mt/onnx-patch.js';
import { VARIANTS, DEFAULT_VARIANT } from '../../extension/engines/mt/models.js';
import { prepareBatch, finishBatch } from '../../extension/engines/mt/preprocess.js';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const N = Number(arg('n', '100'));
const SYSTEMS = arg('systems', 'opus,gemma').split(',');
const THREADS = Number(arg('threads', '4'));
const DATA = join(here, '.data');
const OUT = join(here, '.out');
mkdirSync(DATA, { recursive: true });
mkdirSync(OUT, { recursive: true });

// ---------- Veri ----------

function sacrebleuEcho(side) {
  return execFileSync('python3', ['-m', 'sacrebleu', '-t', 'wmt18', '-l', 'en-tr', '--echo', side], { encoding: 'utf8', maxBuffer: 1 << 26 });
}

function loadData() {
  const src = join(DATA, 'wmt18.en'), ref = join(DATA, 'wmt18.tr');
  if (!existsSync(src)) writeFileSync(src, sacrebleuEcho('src'));
  if (!existsSync(ref)) writeFileSync(ref, sacrebleuEcho('ref'));
  const en = readFileSync(src, 'utf8').split('\n');
  const tr = readFileSync(ref, 'utf8').split('\n');
  const pairs = [];
  for (let i = 0; i < en.length && pairs.length < N; i++) {
    const w = en[i].trim().split(/\s+/).length;
    if (en[i].trim() && tr[i]?.trim() && w >= 4 && w <= 25) pairs.push({ en: en[i].trim(), tr: tr[i].trim() });
  }
  return pairs;
}

// Otomatik altyazı biçimi: küçük harf, noktalama yok (kesme işareti kalır).
const asrify = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').replace(/\s+/g, ' ').trim();

// ---------- Sistemler ----------

async function opusSystem() {
  const ort = await import('onnxruntime-node');
  const dir = join(here, '.models', 'tc-big-en-tr');
  const v = VARIANTS[DEFAULT_VARIANT];
  const enc = new Uint8Array(readFileSync(join(dir, v.encoder.file)));
  const dec = new Uint8Array(readFileSync(join(dir, v.decoder.file)));
  for (const h of v.decoder.holes ?? []) {
    dec.fill(0, h.range[0], h.range[1]);
    fillDequantized(dec, h.tensor, h.from === 'encoder' ? enc : dec, h.source, h.range);
  }
  const tokenizer = new MarianTokenizer(readFileSync(join(dir, 'source.spm')), JSON.parse(readFileSync(join(dir, 'vocab.json'), 'utf8')));
  const mt = await MarianTranslator.create(ort, {
    encoder: enc, decoder: dec, tokenizer, sessionOptions: { executionProviders: ['cpu'], intraOpNumThreads: THREADS },
  });
  return {
    name: `OPUS-MT tc-big (${DEFAULT_VARIANT})`,
    // Eklentideki gibi: ön işleme → cümle cümle çeviri → birleştirme
    async translate(text) {
      const { units, plan } = prepareBatch([text]);
      const out = await mt.translate(units, { maxBatch: 1 });
      return finishBatch(plan, out)[0];
    },
  };
}

async function gemmaSystem() {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = join(here, '.models', 'hf');
  const gen = await pipeline('text-generation', 'onnx-community/translategemma-text-4b-it-ONNX', {
    dtype: 'q4', device: 'cpu', session_options: { intraOpNumThreads: THREADS },
    progress_callback: (p) => { if (p.status === 'progress' && p.total > 5e8) process.stderr.write(`\r  ${p.file} ${Math.round(p.progress)}%   `); },
  });
  process.stderr.write('\n');
  return {
    name: 'TranslateGemma 4B (q4)',
    async translate(text) {
      // Modelin sohbet şablonu: kaynak/hedef dil kodlarıyla tek kullanıcı mesajı.
      const messages = [{ role: 'user', content: [{ type: 'text', source_lang_code: 'en', target_lang_code: 'tr', text }] }];
      const out = await gen(messages, { max_new_tokens: 160, do_sample: false });
      return String(out[0].generated_text.at(-1).content).trim();
    },
  };
}

const MAKERS = { opus: opusSystem, gemma: gemmaSystem };

// ---------- Puanlama ----------

function score(hypFile, refFile) {
  const out = execFileSync('python3', ['-m', 'sacrebleu', refFile, '-i', hypFile, '-m', 'bleu', 'chrf', '-b', '-w', '1'], { encoding: 'utf8' });
  const [bleu, chrf] = JSON.parse(out); // -b: yalnızca puanlar, JSON dizi
  return { bleu, chrf };
}

// ---------- Çalıştır ----------
// Her sistem ayrı süreçte çalışır: OPUS-MT ile transformers.js farklı onnxruntime-node sürümleri getirir ve aynı
// süreçte yüklenince paylaşılan kütüphane çakışır.

const pairs = loadData();
const sets = { metin: pairs.map((p) => p.en), asr: pairs.map((p) => asrify(p.en)) };
const refFile = join(OUT, 'ref.tr');

async function runOne(key) {
  const t0 = performance.now();
  const sys = await MAKERS[key]();
  console.log(`${sys.name}: yüklendi (${((performance.now() - t0) / 1000).toFixed(1)} sn)`);
  await sys.translate('Hello.');
  const result = { name: sys.name, rows: [], hyps: {} };
  for (const [set, list] of Object.entries(sets)) {
    const hyps = [];
    const t1 = performance.now();
    for (let i = 0; i < list.length; i++) {
      hyps.push((await sys.translate(list[i])).replace(/\n+/g, ' '));
      if (i % 10 === 9) process.stderr.write(`\r  ${set}: ${i + 1}/${list.length}`);
    }
    process.stderr.write('\n');
    const ms = (performance.now() - t1) / list.length;
    const file = join(OUT, `${key}-${set}.tr`);
    writeFileSync(file, hyps.join('\n') + '\n');
    const s = score(file, refFile);
    result.rows.push({ sys: sys.name, set, ...s, ms });
    result.hyps[set] = hyps;
    console.log(`  ${set}: chrF ${s.chrf.toFixed(1)}  BLEU ${s.bleu.toFixed(1)}  ${ms.toFixed(0)} ms/cümle`);
  }
  writeFileSync(join(OUT, `${key}.json`), JSON.stringify(result));
}

if (process.argv.includes('--child')) {
  await runOne(SYSTEMS[0]);
} else {
  writeFileSync(refFile, pairs.map((p) => p.tr).join('\n') + '\n');
  console.log(`${pairs.length} cümle (WMT18 haber, EN→TR), ${THREADS} iş parçacığı\n`);
  const results = [];
  for (const key of SYSTEMS) {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--child', '--systems', key, '--n', String(N), '--threads', String(THREADS)],
      { stdio: 'inherit' });
    results.push(JSON.parse(readFileSync(join(OUT, `${key}.json`), 'utf8')));
  }
  const rows = results.flatMap((r) => r.rows);
  console.log('\n| Sistem | Girdi | chrF | BLEU | ms/cümle (CPU) |\n|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.sys} | ${r.set} | ${r.chrf.toFixed(1)} | ${r.bleu.toFixed(1)} | ${r.ms.toFixed(0)} |`);
  console.log('\nÖrnekler (asr girdisi):');
  for (let i = 0; i < Math.min(5, pairs.length); i++) {
    console.log(`\nEN : ${sets.asr[i]}\nREF: ${pairs[i].tr}`);
    for (const r of results) console.log(`${r.name.split(' ')[0].padEnd(15)}: ${r.hyps.asr[i]}`);
  }
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ n: pairs.length, threads: THREADS, rows }, null, 2));
}
