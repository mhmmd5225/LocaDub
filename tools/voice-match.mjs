#!/usr/bin/env node
// Konuşmacıya benzeyen ses: TTS seslerinin perde profili ve seçimin ölçümü (veri: tools/spk-data.mjs).
//
//   node tools/voice-match.mjs [--data <spk-eval dizini>]
//
// 1. Her TTS sesinin (veride tts-<ses> konuşmacıları, 14 cümle) ortanca perdesini eklentinin kendi yoluyla ölçer
//    (engines/spk/worker.js ile aynı çerçeveleme + SpeakerClusters.medianHz). Çıktı engines/tts/voices.js'teki f0
//    alanlarına elle yazılır.
// 2. Gerçek konuşmacılarda (LibriSpeech, 80 kişi) seçimi sınar: ilk 7 cümlenin perdesinden ses seçilir (matchVoice),
//    kalan 7 cümlenin perdesiyle seçilen sesin (perde ayarı dahil) arasındaki fark ölçülür; varsayılan cinsiyet
//    sesiyle karşılaştırılır. Perde ve parlaklık kulakla en çok algılanan iki özellik; konuşmacı tanıma vektörünün
//    benzerliği (kimlik) dinleme testinde kulakla uyuşmadı, bu yüzden seçim yalnız perdeye dayanır.

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateF0, voicedF0, SpeakerClusters } from '../extension/content/gender.js';
import { matchVoice } from '../extension/common/voice-match.js';
import { VOICES } from '../extension/engines/tts/voices.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const DATA = resolve(arg('data', join(root, 'tests/extension/.models/spk-eval')));
const RATE = 16000;

function readWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 12, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = dv.getUint32(off + 4, true);
    if (id === 'data') data = { off: off + 8, size: Math.min(size, buf.length - off - 8) };
    off += 8 + size + (size & 1);
  }
  const out = new Float32Array(data.size >> 1);
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(data.off + 2 * i, true) / 32768;
  return out;
}

// engines/spk/worker.js pitch() ile aynı
function pitch(pcm) {
  const W = Math.round(0.0427 * RATE);
  const H = Math.round(0.05 * RATE);
  const fr = [];
  for (let s = 0; s + W <= pcm.length; s += H) fr.push([s / RATE, estimateF0(pcm.subarray(s, s + W), RATE)]);
  return voicedF0(fr);
}

async function medianOf(files) {
  const C = new SpeakerClusters();
  const id = C.assign(new Float32Array([1]));
  for (const f of files) C.addEvidence(id, { f0: pitch(readWav(await readFile(join(DATA, f)))) });
  return C.medianHz(id);
}

const man = JSON.parse(await readFile(join(DATA, 'manifest.json'), 'utf8'));
const prof = {};
console.log('Ses perdeleri (voices.js f0):');
for (const s of man.speakers.filter((x) => x.source === 'tts')) {
  const id = s.id.replace(/^tts-/, '').replace(/^supertonic-3-/, 'supertonic-3:');
  prof[id] = Math.round(await medianOf(s.files));
  console.log(`  ${id.padEnd(16)} ${s.gender.padEnd(6)} ${prof[id]} Hz (voices.js: ${VOICES.find((v) => v.id === id)?.f0 ?? '-'})`);
}

const pool = Object.entries(prof).map(([id, f0]) => ({ id, f0, gender: man.speakers.find((s) => s.id.endsWith(id.replace(':', '-'))).gender }));
const st = (a, b) => Math.abs(12 * Math.log2(a / b));
const DEF = { female: 'ahenk-cep', male: 'antalia-mini' };
const rows = [];
const picks = new Set();
for (const s of man.speakers.filter((x) => x.source !== 'tts')) {
  const sel = await medianOf(s.files.slice(0, 7));
  const ev = await medianOf(s.files.slice(7));
  if (!sel || !ev) continue;
  const m = matchVoice(sel, pool.filter((v) => v.gender === s.gender));
  picks.add(`${m.voice}${m.pitch ? (m.pitch > 0 ? '+' : '') + m.pitch : ''}`);
  rows.push({ match: st(ev, prof[m.voice] * 2 ** (m.pitch / 12)), def: st(ev, prof[DEF[s.gender]]) });
}
const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
const within = (a, t) => Math.round((100 * a.filter((x) => x <= t).length) / a.length);
const M = rows.map((r) => r.match);
const D = rows.map((r) => r.def);
console.log(`\n${rows.length} konuşmacı, perde farkı (yarım ton, ayrı tutulan cümlelerle):`);
console.log(`  varsayılan cinsiyet sesi  ortanca ${med(D).toFixed(1)}  ≤1 yarım ton %${within(D, 1)}  ≤2 %${within(D, 2)}`);
console.log(`  benzeyen ses              ortanca ${med(M).toFixed(1)}  ≤1 yarım ton %${within(M, 1)}  ≤2 %${within(M, 2)}`);
console.log(`  farklı seçim: ${picks.size}`);
