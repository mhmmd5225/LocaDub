#!/usr/bin/env node
// Voice comparison (docs/TTS-KIYAS.md): every voice of the catalog speaks the same sentence set through the
// extension's own synthesis core (onnxruntime-node, 1 thread by default), and the result is measured:
// speed (RTF), melody movement (F0 spread, prosody.mjs), question endings and loudness. Intelligibility (WER/CER)
// comes from Whisper in a second step (wer.py) over the WAVs written here.
//
//   node compare.mjs [--voices id,id] [--variants id@style/quality,...] [--threads N] [--tag name] [--file name=path,...]
//   ../../.venv/bin/python wer.py out/compare/<tag>        (optional, needs faster-whisper)
//   node compare.mjs --summary out/compare/<tag>
//
// A variant is a voice with a tone: `ahenk-cep@lively/high`, `supertonic-3:F2@natural/fast`.
// --file replaces catalog files by name for every voice that has them, e.g. the 8-bit Supertonic graph:
//   --file vector=.models/supertonic-3-int8/onnx/vector_estimator.int8.onnx

import * as ort from 'onnxruntime-node';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VOICES, packOf } from '../../extension/engines/tts/voices.js';
import { loadVoice, synthesizeText, releaseVoice } from '../../extension/engines/tts/core.js';
import { encodeWav } from '../../extension/engines/tts/dsp.js';
import { analyze } from './prosody.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};

// kind: s = statement, q = question, e = exclamation; wer: no digits/abbreviations, so Whisper's spelling of
// numbers cannot count as an error
export const SENTENCES = [
  { kind: 's', wer: true, text: 'Merhaba arkadaşlar, bugün yapay zekânın geleceği hakkında konuşacağız.' },
  { kind: 's', text: "Toplantı saat 14:30'da başlayacak ve yaklaşık 45 dakika sürecek." },
  { kind: 's', text: "Şirketin geliri %12,5 artarak 3,5 milyar TL'ye ulaştı." },
  { kind: 's', text: 'Dr. Ahmet Yılmaz, 3. bölümde NASA ve AI konularını vb. örneklerle anlattı.' },
  { kind: 's', wer: true, text: 'Bilim insanları, okyanusun derinliklerinde daha önce hiç görülmemiş bir canlı türü keşfettiklerini açıkladı.' },
  { kind: 's', wer: true, text: 'Bu yöntem ilk başta zor görünebilir ama birkaç denemeden sonra her şey çok daha kolay hale geliyor çünkü beyniniz yeni alışkanlığa uyum sağlıyor.' },
  { kind: 's', wer: true, text: 'İlk olarak malzemeleri hazırlayın, ardından fırını önceden ısıtın ve son olarak hamuru tepsiye yayın.' },
  { kind: 'q', wer: true, text: 'Bunu gerçekten denediniz mi?' },
  { kind: 'q', wer: true, text: 'Yarın sabah toplantıya gelecek misin?' },
  { kind: 'q', wer: true, text: 'Peki, bu neden bu kadar önemli?' },
  { kind: 'q', text: 'Fiyatı 19,99 $ olan bu ürün, 21. yüzyılın en çok satanları arasında; peki neden bu kadar popüler?' },
  { kind: 'e', wer: true, text: 'Harika, sonunda başardık!' },
  { kind: 'e', wer: true, text: 'Dikkat edin, bu çok tehlikeli!' },
  { kind: 'e', wer: true, text: 'Bu videoyu beğendiyseniz kanalıma abone olmayı unutmayın. Bir sonraki videoda görüşmek üzere, hoşça kalın!' },
];

const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)));

async function run() {
  const THREADS = Number(arg('--threads', 1));
  const tag = arg('--tag', 'base');
  const out = join(here, 'out', 'compare', tag);
  const models = join(here, '.models');
  const only = arg('--voices', null)?.split(',');
  const variants = (arg('--variants', '') || '').split(',').filter(Boolean);
  const files = Object.fromEntries((arg('--file', '') || '').split(',').filter(Boolean).map((kv) => kv.split('=')));
  const configs = VOICES.filter((v) => !only || only.includes(v.id)).map((v) => ({ id: v.id, tone: {} }));
  for (const s of variants) {
    const [id, t = ''] = s.split('@');
    const [style, quality] = t.split('/');
    configs.push({ id, tone: { style: style || undefined, quality: quality || undefined } });
  }
  await mkdir(out, { recursive: true });
  const rows = [];
  const loaded = new Map(); // pack -> voice
  for (const cfg of configs) {
    const def = VOICES.find((v) => v.id === cfg.id);
    if (!def) throw new Error(`unknown voice ${cfg.id}`);
    const pack = packOf(def);
    if (!loaded.has(pack)) {
      for (const v of loaded.values()) await releaseVoice(v);
      loaded.clear();
      const buffers = {};
      for (const f of def.files) buffers[f.name] = await readFile(files[f.name] || join(models, pack, f.url.split('/').pop()));
      const voice = await loadVoice(ort, def, buffers, {
        sessionOptions: { executionProviders: ['cpu'], intraOpNumThreads: THREADS, interOpNumThreads: 1 },
      });
      await synthesizeText(voice, 'Merhaba.', { preset: def.preset });
      loaded.set(pack, voice);
    }
    const voice = loaded.get(pack);
    const name = cfg.id.replace(':', '-') + (cfg.tone.style || cfg.tone.quality ? `@${cfg.tone.style || 'natural'}-${cfg.tone.quality || 'fast'}` : '');
    await mkdir(join(out, name), { recursive: true });
    for (let i = 0; i < SENTENCES.length; i++) {
      const s = SENTENCES[i];
      const { pcm, sampleRate, stats } = await synthesizeText(voice, s.text, { tone: cfg.tone, preset: def.preset });
      const file = join(name, `${String(i + 1).padStart(2, '0')}.wav`);
      await writeFile(join(out, file), encodeWav(pcm, sampleRate));
      rows.push({ config: name, voice: cfg.id, i: i + 1, kind: s.kind, wer: !!s.wer, text: s.text, file, seconds: stats.seconds, compute: stats.computeSec, rtf: stats.rtf, ...analyze(pcm, sampleRate) });
    }
    const mine = rows.filter((r) => r.config === name);
    console.log(`${name.padEnd(36)} RTF ${fmt(mean(mine.map((r) => r.compute)) / mean(mine.map((r) => r.seconds)), 3)}  F0 sd ${fmt(mean(mine.map((r) => r.f0Std)))} st  level ${fmt(mean(mine.map((r) => r.levelDb)), 1)} dB`);
  }
  await writeFile(join(out, 'results.json'), JSON.stringify({ threads: THREADS, files, rows }, null, 2));
  console.log(`\n${join(out, 'results.json')}`);
}

/** Markdown tables for docs/TTS-KIYAS.md, from results.json (+ wer.json when present). */
async function summary(dir) {
  const { threads, rows } = JSON.parse(await readFile(join(dir, 'results.json'), 'utf8'));
  let wer = {};
  try {
    wer = JSON.parse(await readFile(join(dir, 'wer.json'), 'utf8'));
  } catch {
    /* no Whisper run */
  }
  const configs = [...new Set(rows.map((r) => r.config))];
  console.log(`Tek iş parçacığı: ${threads}\n`);
  console.log('| Ses | RTF | WER % | CER % | F0 sapma (yt) | F0 aralık (yt) | soru sonu (yt) | ünlem sonu (yt) | seviye dBFS (± cümleler arası) |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const c of configs) {
    const r = rows.filter((x) => x.config === c);
    const w = r.filter((x) => x.wer && wer[x.file]);
    const errs = (k) => w.reduce((n, x) => n + wer[x.file][k], 0) / Math.max(1, w.reduce((n, x) => n + wer[x.file][k === 'wordErrors' ? 'words' : 'chars'], 0));
    const lv = r.map((x) => x.levelDb);
    console.log(
      `| ${c} | ${fmt(mean(r.map((x) => x.compute)) / mean(r.map((x) => x.seconds)), 3)} | ${w.length ? fmt(100 * errs('wordErrors'), 1) : '—'} | ${w.length ? fmt(100 * errs('charErrors'), 1) : '—'} ` +
        `| ${fmt(mean(r.map((x) => x.f0Std)))} | ${fmt(mean(r.map((x) => x.f0Range)))} | ${fmt(mean(r.filter((x) => x.kind === 'q').map((x) => x.finalRise)))} ` +
        `| ${fmt(mean(r.filter((x) => x.kind === 'e').map((x) => x.finalRise)))} | ${fmt(mean(lv), 1)} (± ${fmt(sd(lv), 1)}) |`,
    );
  }
}

const main = import.meta.url === pathToFileURL(process.argv[1]).href;
if (main && process.argv.includes('--summary')) await summary(arg('--summary'));
else if (main) await run();
