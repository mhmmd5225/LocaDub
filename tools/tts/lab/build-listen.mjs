#!/usr/bin/env node
// Kör dinleme sayfasını üretir: out/dinleme.html (tek dosya, sesler base64 data URI).
//   node build-listen.mjs [--drop 2,9,14,18] [--seed 20260427]
// Girdi: select.json (adaylar), out/mp3/<aday>/NN.mp3, out/<aday>/stats-t*.json, out/utmos.json.
import { readFileSync, writeFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { here, OUT, arg } from './lib.mjs';

const drop = new Set(arg('--drop', '2,9,14,18').split(',').filter(Boolean).map(Number));
let seed = Number(arg('--seed', 20260427));
const rnd = () => { // mulberry32
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const J = (p) => JSON.parse(readFileSync(p, 'utf8'));
const sentences = J(join(here, 'sentences.json')).filter((s) => !drop.has(s.id));
const sel = J(join(here, 'select.json')).candidates;
const utmos = existsSync(join(OUT, 'utmos.json')) ? J(join(OUT, 'utmos.json')) : {};
const dirSize = (dir, only) => readdirSync(dir, { recursive: true }).filter((f) => !only || only.test(f)).reduce((n, f) => { try { const s = statSync(join(dir, f)); return n + (s.isFile() ? s.size : 0); } catch { return n; } }, 0);
const MODEL_MB = { // indirilen çıkarım dosyalarının toplamı (ses stilleri dahil değil)
  'antalia-mini': dirSize(join(here, '.models/baseline/antalia-mini')),
  'ahenk-cep': dirSize(join(here, '.models/baseline/ahenk-cep')),
  'ema-lightning': ['text.onnx', 'sound.onnx', 'decoder.onnx'].reduce((n, f) => n + statSync(join(here, '.models/ema', f)).size, 0),
  okur: dirSize(join(here, '.models/okur/onnx'), /\.onnx$/),
  supertonic3: dirSize(join(here, '.models/supertonic3/onnx'), /\.onnx$/),
  pocket: statSync(join(here, '.models/pocket/model.safetensors')).size,
};
const mbOf = (id) => (MODEL_MB[id] ?? MODEL_MB[id.replace(/-(neutral|calm|cheerful)$/, '')] ?? MODEL_MB[id.split('-')[0]] ?? 0) / 1e6;
const stat = (id, t) => { const p = join(OUT, id, `stats-t${t}.json`); return existsSync(p) ? J(p).rtf : null; };

const audio = {};
const candidates = sel.map((c) => {
  audio[c.id] = {};
  for (const s of sentences) audio[c.id][s.id] = readFileSync(join(OUT, 'mp3', c.id, `${String(s.id).padStart(2, '0')}.mp3`)).toString('base64');
  return { id: c.id, etiket: c.etiket, utmos: utmos[c.id]?.utmos ?? null, rtf4: stat(c.id, 4), rtf1: stat(c.id, 1), mb: mbOf(c.id) };
});
const order = {};
for (const s of sentences) {
  const ids = sel.map((c) => c.id);
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  order[s.id] = ids;
}
const data = { sentences, candidates, order, audio };
const html = readFileSync(join(here, 'listen-template.html'), 'utf8').replace('/*DATA*/null', () => JSON.stringify(data));
const out = join(OUT, 'dinleme.html');
writeFileSync(out, html);
console.log(`${out}: ${(html.length / 1e6).toFixed(2)} MB, ${sentences.length} cümle x ${candidates.length} aday`);
