#!/usr/bin/env node
// Konuşmacıya göre ses (content/gender.js + engines/spk) kalite ölçümü: yeni yöntem (konuşmacı vektörü + çevrimiçi
// kümeleme + küme başına cinsiyet) ile eski yöntem (cümle başına perde, GenderTracker) aynı veride.
//
//   node tools/spk-data.mjs --libri <LibriSpeech kökü>      (veri: TTS sesleri + LibriSpeech, bkz. dosya başı)
//   node tools/spk-eval.mjs [--model campplus-vox] [--dialogues 80] [--seed 1] [--runtime node|web] [--threads 1]
//                          [--compare]          aday modellerin ayrım gücü (EER) ve hızı
//                          [--train-gender]     cinsiyet sınıflandırıcısını eğit (LibriSpeech test-clean konuşmacıları)
//                          [--no-classifier] [--json çıktı.json] [--data <dizin>] [--dir <model dizini>]
//                          [--cache ölçüm.json]  ölçümleri (vektör, perde) sakla/yeniden kullan: eşik denemeleri için
//
// Diyaloglar: aynı kaynaktan (TTS ya da LibriSpeech) 1–4 konuşmacı, sıra başına 1–3 cümle, 14–24 cümle; tek
// konuşmacılı anlatımlar (aynı kişinin ses değiştirmemesi) dahil. LibriSpeech cümleleri altyazı cümlesi gibi
// 1.2–5 sn'lik parçalara kesilir. Koşullar: temiz (ayırma açık: speechAt temiz konuşma), ayırma kalıntısı
// (müzik −20 dB), müzik −10/−6/0 dB (ayırma kapalı: orijinal ses). Müzik sentetiktir (akor, bas, davul ve
// kadın perdesi aralığında melodi; perde ölçümü için en zor durum).
//
// Yöntemler:
//   eski    cümle başına perde ortancası (app.js'in önceki yolu: erken karar + sıra çoğunluğu; >> işareti yok)
//   yeni    cümle vektörü → SpeakerClusters → kümenin cinsiyeti (perde + sınıflandırıcı kanıtı birikir)
// "çalınan" ses: dublajda duyulan. Ayırmada cümle çalmadan önce (speechAt) gömülür; ayırma yokken cümle
// çalınırken bilinmez, önceki cümlenin kümesinden tahmin edilir, cümle bitince gömülür.
// Ölçüler: tutarlılık (her gerçek konuşmacının cümlelerinin en sık sesini alma payı), ses değişimi (aynı
// konuşmacının ardışık cümlelerinde ses değişme oranı), cinsiyet doğruluğu (cümle ve konuşmacı başına),
// küme saflığı ve karışık cinsiyetli küme sayısı.

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SPK_MODELS, spkModelById, DEFAULT_SPK_MODEL } from '../extension/engines/spk/models.js';
import { createEmbedder } from '../extension/engines/spk/embedder.js';
import { genderScore } from '../extension/engines/spk/gender-head.js';
import {
  estimateF0, GenderTracker, turnGender, predictGender, voicedF0, EARLY_VOICED, CLEAR_MALE_HZ, CLEAR_FEMALE_HZ,
  SpeakerClusters,
} from '../extension/content/gender.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const argv = process.argv.slice(2);
const flag = (k) => argv.includes('--' + k);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const DATA = resolve(opt('data', join(root, 'tests/extension/.models/spk-eval')));
const DIR = resolve(opt('dir', join(root, 'tests/extension/.models/spk')));
const RUNTIME = opt('runtime', 'node');
const THREADS = Number(opt('threads', 1));
const SEED = Number(opt('seed', 1));
const NDIAL = Number(opt('dialogues', 80));
const RATE = 16000;

// ---- yardımcılar ----
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const pick = (r, a) => a[Math.floor(r() * a.length)];
function shuffle(r, a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / Math.max(1, x.length));
const pct = (x) => (x == null || Number.isNaN(x) ? '—' : (100 * x).toFixed(1) + '%');

function readWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 12, data = null, bits = 16;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = dv.getUint32(off + 4, true);
    if (id === 'fmt ') bits = dv.getUint16(off + 22, true);
    if (id === 'data') data = { off: off + 8, size: Math.min(size, buf.length - off - 8) };
    off += 8 + size + (size & 1);
  }
  if (!data || bits !== 16) throw new Error('WAV okunamadı (16 bit PCM bekleniyor)');
  const n = data.size >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(data.off + 2 * i, true) / 32768;
  return out;
}

// Konuşmanın etkin (sessiz olmayan) bölümünün RMS'i: müzik düzeyi buna göre (0 dB = konuşma kadar yüksek).
function activeRms(x) {
  const W = 400;
  const e = [];
  for (let i = 0; i + W <= x.length; i += W) e.push(rms(x.subarray(i, i + W)));
  e.sort((a, b) => b - a);
  const top = e.slice(0, Math.max(1, Math.ceil(e.length * 0.6)));
  return Math.sqrt(top.reduce((a, v) => a + v * v, 0) / top.length) || 1e-4;
}

// ---- sentetik müzik (16 kHz mono) ----
function music(sec, seed) {
  const r = rng(seed * 7919 + 13);
  const n = Math.round(sec * RATE);
  const out = new Float32Array(n);
  const bpm = 90 + Math.floor(r() * 50);
  const beat = 60 / bpm;
  const roots = [0, 5, 7, 3, 8, 10].map((k) => 110 * 2 ** (k / 12));
  const chordLen = beat * 4;
  // akor (kök, üçlü, beşli; testere benzeri harmonikler) + bas
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const ci = Math.floor(t / chordLen);
    const root = roots[(ci * 7 + seed) % roots.length];
    let v = 0;
    for (const f of [root * 2, root * 2 * 1.26, root * 2 * 1.5]) for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * t + h) / (h * 1.5);
    v *= 0.12;
    v += 0.35 * Math.sin(2 * Math.PI * (root / 2) * t) * (0.6 + 0.4 * Math.cos(2 * Math.PI * t / beat));
    out[i] = v;
  }
  // melodi: 220–520 Hz notalar (kadın konuşma perdesi aralığı), vibratolu
  let t0 = 0;
  while (t0 < sec) {
    const d = beat * pick(r, [0.5, 0.5, 1, 1, 2]);
    const f = 220 * 2 ** (pick(r, [0, 2, 3, 5, 7, 8, 10, 12, 14]) / 12);
    const a = Math.round(t0 * RATE), b = Math.min(n, Math.round((t0 + d) * RATE));
    for (let i = a; i < b; i++) {
      const t = (i - a) / RATE;
      const env = Math.min(1, t / 0.02) * Math.exp(-t * 1.5);
      const ph = 2 * Math.PI * f * t + 0.3 * Math.sin(2 * Math.PI * 5.5 * t);
      out[i] += 0.25 * env * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph));
    }
    t0 += d;
  }
  // davul: vuruşta kick (düşen sinüs), ara vuruşta gürültü (trampet/zil)
  for (let k = 0; k * beat < sec; k++) {
    const a = Math.round(k * beat * RATE);
    for (let i = 0; i < 2400 && a + i < n; i++) {
      const t = i / RATE;
      out[a + i] += 0.6 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-t * 30)) * t) * Math.exp(-t * 20);
    }
    if (k % 2) for (let i = 0; i < 2000 && a + i < n; i++) out[a + i] += 0.25 * (r() * 2 - 1) * Math.exp(-(i / RATE) * 25);
    const h = Math.round((k + 0.5) * beat * RATE);
    for (let i = 0; i < 600 && h + i < n; i++) out[h + i] += 0.08 * (r() * 2 - 1) * Math.exp(-(i / RATE) * 60);
  }
  return out;
}

// ---- veri ----
async function loadData() {
  let man;
  try { man = JSON.parse(await readFile(join(DATA, 'manifest.json'), 'utf8')); } catch {
    throw new Error(`Veri yok: ${DATA}/manifest.json — önce node tools/spk-data.mjs`);
  }
  const speakers = [];
  for (const s of man.speakers) {
    const clips = [];
    for (const f of s.files) clips.push(readWav(await readFile(join(DATA, f))));
    speakers.push({ ...s, clips });
  }
  return speakers;
}

// LibriSpeech cümlesi → altyazı cümlesi gibi 1.2–5 sn'lik parça (sessiz uçlar dahil); TTS cümlesi olduğu gibi.
function segment(r, spk, clip) {
  if (spk.source === 'tts') return clip;
  const len = Math.round((1.2 + r() * 3.8) * RATE);
  if (clip.length <= len) return clip;
  const a = Math.floor(r() * (clip.length - len));
  return clip.subarray(a, a + len);
}

// ---- model ----
async function modelBytes(m) {
  await mkdir(DIR, { recursive: true });
  const p = join(DIR, m.file);
  if ((await stat(p).catch(() => null))?.size !== m.bytes) {
    process.stderr.write(`indiriliyor ${m.url} … `);
    const res = await fetch(m.url);
    if (!res.ok) throw new Error(`${m.url}: HTTP ${res.status}`);
    await writeFile(p, Buffer.from(await res.arrayBuffer()));
    process.stderr.write('tamam\n');
  }
  const buf = await readFile(p);
  if (buf.length !== m.bytes) throw new Error(`boyut uyuşmuyor: ${m.file}`);
  if (createHash('sha256').update(buf).digest('hex') !== m.sha256) throw new Error(`sha256 uyuşmuyor: ${m.file}`);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function loadOrt() {
  if (RUNTIME === 'web') {
    const ort = await import(pathToFileURL(join(root, 'extension/lib/ort/ort.wasm.min.mjs')).href);
    ort.env.wasm.numThreads = THREADS;
    ort.env.wasm.wasmPaths = pathToFileURL(join(root, 'extension/lib/ort/')).href;
    return { ort, sessionOptions: {} };
  }
  const require = createRequire(join(root, 'tests/tts/package.json'));
  let ort;
  try { ort = require('onnxruntime-node'); } catch {
    throw new Error('onnxruntime-node yok: cd tests/tts && ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci');
  }
  return { ort, sessionOptions: { executionProviders: ['cpu'], intraOpNumThreads: THREADS, interOpNumThreads: 1 } };
}

async function embedder(m) {
  const { ort, sessionOptions } = await loadOrt();
  const e = createEmbedder({ model: m, ort, modelData: await modelBytes(m), sessionOptions });
  await e.load();
  return e;
}

// ---- perde (tarayıcıdaki gibi 50 ms'de bir ≈ 43 ms'lik çerçeve) ----
function pitchFrames(x, t0) {
  const W = Math.round(0.0427 * RATE);
  const out = [];
  for (let s = 0; s + W <= x.length; s += Math.round(0.05 * RATE)) out.push([t0 + s / RATE, estimateF0(x.subarray(s, s + W), RATE)]);
  return out;
}

// ---- aday modeller: EER ve hız ----
function eer(same, diff) {
  const all = [...same.map((s) => [s, 1]), ...diff.map((s) => [s, 0])].sort((a, b) => b[0] - a[0]);
  let tp = 0, fp = 0, best = 1;
  for (const [, y] of all) {
    if (y) tp++; else fp++;
    const fnr = 1 - tp / same.length, fpr = fp / diff.length;
    best = Math.min(best, Math.max(fnr, fpr));
  }
  return best;
}

async function compare(speakers) {
  const evalSpk = speakers.filter((s) => s.source !== 'train');
  const rows = [];
  for (const m of SPK_MODELS) {
    const e = await embedder(m);
    for (const db of [null, -6]) {
      const r = rng(SEED);
      const mus = music(30, SEED);
      const items = [];
      let ms = 0, n = 0, sec = 0;
      for (const s of evalSpk) {
        for (const clip of s.clips.slice(0, 8)) {
          let x = segment(r, s, clip);
          if (db != null) {
            const k = activeRms(x) * 10 ** (db / 20) / activeRms(mus);
            const o = Math.floor(r() * (mus.length - x.length));
            x = Float32Array.from(x, (v, i) => v + k * mus[o + i]);
          }
          const t = performance.now();
          const { vector } = await e.embed(x);
          ms += performance.now() - t; n++; sec += x.length / RATE;
          if (vector) items.push({ spk: s.id, g: s.gender, src: s.source, v: vector });
        }
      }
      const same = [], diff = [], diffG = [];
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        if (items[i].src !== items[j].src) continue;
        let c = 0;
        for (let k = 0; k < items[i].v.length; k++) c += items[i].v[k] * items[j].v[k];
        if (items[i].spk === items[j].spk) same.push(c); else { diff.push(c); if (items[i].g !== items[j].g) diffG.push(c); }
      }
      const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      rows.push({
        model: m.id, cond: db == null ? 'temiz' : `müzik ${db} dB`, eer: eer(same, diff), eerGender: eer(same, diffG),
        same: mean(same), diff: mean(diff), msPerSec: ms / sec, msPer: ms / n,
      });
      console.log(`${m.id.padEnd(20)} ${rows.at(-1).cond.padEnd(12)} EER ${pct(rows.at(-1).eer)}  (karşı cins ${pct(rows.at(-1).eerGender)})  ` +
        `aynı ${rows.at(-1).same.toFixed(2)} farklı ${rows.at(-1).diff.toFixed(2)}  ${rows.at(-1).msPer.toFixed(1)} ms/cümle (${RUNTIME}, ${THREADS} iş parçacığı)`);
    }
    await e.dispose();
  }
  return rows;
}

// ---- cinsiyet sınıflandırıcısı (lojistik regresyon, test-clean konuşmacıları) ----
async function trainGender(speakers, m) {
  const train = speakers.filter((s) => s.source === 'train');
  if (!train.length) throw new Error('Eğitim konuşmacısı yok: spk-data.mjs --libri (test-clean açılmış olmalı)');
  const e = await embedder(m);
  const r = rng(SEED + 99);
  const mus = music(60, SEED + 99);
  const X = [], Y = [];
  for (const s of train) {
    for (const clip of s.clips) {
      for (const db of [null, -10, -6, 0]) {
        let x = segment(r, s, clip);
        if (db != null) {
          const k = activeRms(x) * 10 ** (db / 20) / activeRms(mus);
          const o = Math.floor(r() * (mus.length - x.length));
          x = Float32Array.from(x, (v, i) => v + k * mus[o + i]);
        }
        const { vector } = await e.embed(x);
        if (vector) { X.push(vector); Y.push(s.gender === 'female' ? 1 : 0); }
      }
    }
  }
  await e.dispose();
  // L2 düzenlemeli lojistik regresyon, tam gradyan inişi
  const d = X[0].length;
  const w = new Float64Array(d);
  let b = 0;
  const lr = 0.5, l2 = 1e-3;
  for (let it = 0; it < 3000; it++) {
    const gw = new Float64Array(d);
    let gb = 0;
    for (let i = 0; i < X.length; i++) {
      let z = b;
      for (let k = 0; k < d; k++) z += w[k] * X[i][k];
      const p = 1 / (1 + Math.exp(-z));
      const err = p - Y[i];
      for (let k = 0; k < d; k++) gw[k] += err * X[i][k];
      gb += err;
    }
    for (let k = 0; k < d; k++) w[k] -= lr * (gw[k] / X.length + l2 * w[k]);
    b -= lr * gb / X.length;
  }
  let ok = 0;
  for (let i = 0; i < X.length; i++) {
    let z = b;
    for (let k = 0; k < d; k++) z += w[k] * X[i][k];
    if ((z > 0) === (Y[i] === 1)) ok++;
  }
  const out = join(root, 'extension/engines/spk', `gender-${m.id}.json`);
  await writeFile(out, JSON.stringify({ model: m.id, data: 'LibriSpeech test-clean (CC-BY 4.0), 40 konuşmacı', n: X.length, b: +b.toFixed(5), w: Array.from(w, (v) => +v.toFixed(5)) }) + '\n');
  console.log(`sınıflandırıcı: ${X.length} örnek, eğitim doğruluğu ${pct(ok / X.length)} → ${out}`);
}

// ---- diyaloglar ----
function dialogues(speakers) {
  const r = rng(SEED);
  const bySrc = { tts: speakers.filter((s) => s.source === 'tts'), libri: speakers.filter((s) => s.source === 'libri') };
  const kinds = ['mono', 'mf', 'mf', 'mm', 'ff', 'three', 'four'];
  const out = [];
  for (let d = 0; d < NDIAL; d++) {
    const src = bySrc.libri.length && (d % 2 || !bySrc.tts.length) ? 'libri' : 'tts';
    const pool = bySrc[src];
    const M = pool.filter((s) => s.gender === 'male'), F = pool.filter((s) => s.gender === 'female');
    const kind = kinds[d % kinds.length];
    let cast;
    if (kind === 'mono') cast = [pick(r, pool)];
    else if (kind === 'mf') cast = [pick(r, M), pick(r, F)];
    else if (kind === 'mm') cast = shuffle(r, M).slice(0, 2);
    else if (kind === 'ff') cast = shuffle(r, F).slice(0, 2);
    else cast = shuffle(r, pool).slice(0, kind === 'three' ? 3 : 4);
    cast = shuffle(r, cast);
    const used = new Map(cast.map((s) => [s.id, shuffle(r, s.clips.map((_, i) => i))]));
    const len = 14 + Math.floor(r() * 11);
    const sents = [];
    let cur = 0;
    let t = 0;
    while (sents.length < len) {
      const turn = 1 + Math.floor(r() * 3);
      for (let k = 0; k < turn && sents.length < len; k++) {
        const s = cast[cur];
        const q = used.get(s.id);
        if (!q.length) used.set(s.id, shuffle(r, s.clips.map((_, i) => i)));
        const x = segment(r, s, s.clips[used.get(s.id).pop()]);
        sents.push({ spk: s.id, gender: s.gender, x, start: t, end: t + x.length / RATE });
        t += x.length / RATE + 0.3;
      }
      if (cast.length > 1) cur = (cur + 1 + Math.floor(r() * (cast.length - 1))) % cast.length;
    }
    out.push({ src, kind, sents, sec: t });
  }
  return out;
}

const CONDS = [
  { id: 'clean', label: 'temiz (ayırma: speechAt)', db: null, ahead: true },
  { id: 'resid', label: 'ayırma kalıntısı −20 dB', db: -20, ahead: true },
  { id: 'm10', label: 'müzik −10 dB (ayırma yok)', db: -10, ahead: false },
  { id: 'm6', label: 'müzik −6 dB (ayırma yok)', db: -6, ahead: false },
  { id: 'm0', label: 'müzik 0 dB (ayırma yok)', db: 0, ahead: false },
];

// Bir koşulda her cümlenin ölçümleri: perde çerçeveleri, vektör, sınıflandırıcı puanı.
async function measure(dlg, cond, e, head, di) {
  const mus = cond.db == null ? null : music(dlg.sec + 1, di + 1);
  const out = [];
  for (const s of dlg.sents) {
    let x = s.x;
    if (mus) {
      const k = activeRms(x) * 10 ** (cond.db / 20) / activeRms(mus);
      const o = Math.round(s.start * RATE);
      x = Float32Array.from(x, (v, i) => v + k * mus[o + i]);
    }
    const f0 = pitchFrames(x, s.start);
    const { vector, voicedSec } = await e.embed(x);
    out.push({ f0, vector, voicedSec, score: vector && head ? genderScore(head, vector) : null });
  }
  return out;
}

// Eski yöntem (app.js'in önceki _measureGender'ı): çalınan cinsiyet = cümleden önceki durum.
function runOld(dlg, ms) {
  const tr = new GenderTracker();
  const G = { turns: new Map(), recent: new Map([[0, []]]), last: null, fallback: 'male' };
  const played = [], final = [];
  dlg.sents.forEach((s, i) => {
    played.push({ gender: predictGender({}, G), voice: predictGender({}, G) });
    for (const [t, f] of ms[i].f0) tr.push(t, f);
    // erken karar: ilk ≈ 0.5–1 sn
    for (let t = s.start + 0.5; t < Math.min(s.end, s.start + 1.2); t += 0.1) {
      const m = tr.measure(s.start, t, { min: EARLY_VOICED });
      if (m?.gender && !(m.hz >= CLEAR_MALE_HZ && m.hz <= CLEAR_FEMALE_HZ)) { G.turns.set(0, m.gender); G.last = m.gender; break; }
    }
    const m = tr.measure(s.start, s.end);
    if (m?.gender) { const maj = turnGender(G.recent.get(0), m); G.turns.set(0, maj); G.last = maj; }
    final.push(m?.gender || predictGender({}, G));
  });
  return { played, final, clusters: null };
}

// Yeni yöntem: ahead → cümle çalmadan önce gömülür (ayırma); değilse önceki cümlenin kümesinden tahmin.
function runNew(dlg, ms, ahead, useHead) {
  const C = new SpeakerClusters();
  const ids = [];
  const played = [];
  let last = null; // en son çalınan / bilinen cinsiyet
  let lastId = null;
  const voiceOf = (id, g) => (id != null && C.genderOf(id) ? `${C.genderOf(id)}:${C.altOf(id)}` : g);
  const step = (i) => {
    const m = ms[i];
    const f0 = voicedF0(m.f0);
    const ev = { f0, score: useHead ? m.score : null };
    let id = null;
    if (m.vector) id = C.assign(m.vector, { w: Math.min(m.voicedSec, 4), ev });
    else if (lastId != null) id = null;
    ids.push(id);
    return id;
  };
  const own = (i) => {
    const tr = new GenderTracker();
    for (const [t, f] of ms[i].f0) tr.push(t, f);
    return tr.measure(dlg.sents[i].start, dlg.sents[i].end)?.gender || null;
  };
  dlg.sents.forEach((s, i) => {
    if (ahead) {
      const id = step(i);
      const g = (id != null && C.genderOf(id)) || own(i) || last || 'male';
      played.push({ gender: g, voice: voiceOf(id, g) });
      last = g;
      if (id != null) lastId = id;
    } else {
      const id0 = lastId != null ? C.resolve(lastId) : null;
      const g = (id0 != null && C.genderOf(id0)) || last || 'male';
      played.push({ gender: g, voice: voiceOf(id0, g) });
      const id = step(i);
      if (id != null) lastId = id;
      last = (id != null && C.genderOf(id)) || own(i) || g;
    }
  });
  const fin = ids.map((id) => (id != null ? C.resolve(id) : null));
  const final = fin.map((id, i) => (id != null && C.genderOf(id)) || played[i].gender);
  return { played, final, clusters: fin };
}

function score(dlgs, results) {
  const acc = { sent: 0, ok: 0, okFinal: 0, cons: 0, consN: 0, ccons: 0, flips: 0, pairs: 0, spk: 0, spkOk: 0, mixed: 0, purity: 0, pN: 0, nClusters: 0, nTrue: 0 };
  dlgs.forEach((d, di) => {
    const r = results[di];
    const bySpk = new Map();
    d.sents.forEach((s, i) => {
      acc.sent++;
      if (r.played[i].gender === s.gender) acc.ok++;
      if (r.final[i] === s.gender) acc.okFinal++;
      if (!bySpk.has(s.spk)) bySpk.set(s.spk, []);
      bySpk.get(s.spk).push(i);
    });
    for (const [, idx] of bySpk) {
      const mode = (arr) => { const m = new Map(); for (const v of arr) m.set(v, (m.get(v) || 0) + 1); return Math.max(...m.values()); };
      acc.cons += mode(idx.map((i) => r.played[i].voice));
      acc.consN += idx.length;
      if (r.clusters) acc.ccons += mode(idx.map((i) => r.clusters[i] ?? -1));
      for (let k = 1; k < idx.length; k++) { acc.pairs++; if (r.played[idx[k]].voice !== r.played[idx[k - 1]].voice) acc.flips++; }
      const gm = new Map();
      for (const i of idx) gm.set(r.played[i].gender, (gm.get(r.played[i].gender) || 0) + 1);
      const top = [...gm.entries()].sort((a, b) => b[1] - a[1])[0][0];
      acc.spk++;
      if (top === d.sents[idx[0]].gender) acc.spkOk++;
    }
    acc.nTrue += bySpk.size;
    if (r.clusters) {
      const byC = new Map();
      d.sents.forEach((s, i) => { const c = r.clusters[i]; if (c == null) return; if (!byC.has(c)) byC.set(c, []); byC.get(c).push(s); });
      acc.nClusters += byC.size;
      for (const ss of byC.values()) {
        const m = new Map();
        for (const s of ss) m.set(s.spk, (m.get(s.spk) || 0) + 1);
        acc.purity += Math.max(...m.values());
        acc.pN += ss.length;
        const f = ss.filter((s) => s.gender === 'female').length;
        if (Math.min(f, ss.length - f) >= 2) acc.mixed++;
      }
    }
  });
  return {
    genderPlayed: acc.ok / acc.sent, genderFinal: acc.okFinal / acc.sent, genderSpeaker: acc.spkOk / acc.spk,
    consistency: acc.cons / acc.consN, clusterConsistency: acc.ccons ? acc.ccons / acc.consN : null,
    flipRate: acc.flips / acc.pairs, purity: acc.pN ? acc.purity / acc.pN : null, mixedClusters: acc.pN ? acc.mixed : null,
    clustersPerSpeaker: acc.pN ? acc.nClusters / acc.nTrue : null,
  };
}

async function evaluate(speakers, m) {
  const e = await embedder(m);
  let head = null;
  if (!flag('no-classifier')) {
    try { head = JSON.parse(await readFile(join(root, 'extension/engines/spk', `gender-${m.id}.json`), 'utf8')); } catch { /* yok */ }
  }
  const dlgs = dialogues(speakers);
  console.log(`${dlgs.length} diyalog, ${dlgs.reduce((n, d) => n + d.sents.length, 0)} cümle, model ${m.id}` +
    `${head ? ', cinsiyet sınıflandırıcısı açık' : ''}`);
  const report = [];
  const cacheFile = opt('cache', null);
  let cache = {};
  if (cacheFile) { try { cache = JSON.parse(await readFile(cacheFile, 'utf8')); } catch { /* yeni */ } }
  const key = `${m.id}|${SEED}|${NDIAL}|${head ? 'h' : ''}`;
  for (const cond of CONDS) {
    let ms = cache[key]?.[cond.id];
    if (ms) ms = ms.map((d) => d.map((x) => ({ ...x, vector: x.vector && Float32Array.from(x.vector) })));
    else {
      ms = [];
      for (let di = 0; di < dlgs.length; di++) ms.push(await measure(dlgs[di], cond, e, head, di));
      if (cacheFile) {
        (cache[key] ||= {})[cond.id] = ms.map((d) => d.map((x) => ({ ...x, vector: x.vector && Array.from(x.vector, (v) => +v.toFixed(5)) })));
        await writeFile(cacheFile, JSON.stringify(cache));
      }
    }
    for (const src of ['all', 'tts', 'libri']) {
      const pickD = dlgs.map((d, i) => [d, i]).filter(([d]) => src === 'all' || d.src === src);
      if (!pickD.length) continue;
      const D = pickD.map(([d]) => d);
      const methods = {
        eski: pickD.map(([d, i]) => runOld(d, ms[i])),
        'yeni (perde)': pickD.map(([d, i]) => runNew(d, ms[i], cond.ahead, false)),
        ...(head ? { 'yeni (perde+sınıf.)': pickD.map(([d, i]) => runNew(d, ms[i], cond.ahead, true)) } : {}),
      };
      for (const [name, res] of Object.entries(methods)) report.push({ cond: cond.id, label: cond.label, src, method: name, ...score(D, res) });
    }
  }
  await e.dispose();
  const hdr = 'koşul                          kaynak  yöntem               cins.çalınan cins.son  cins.kişi  tutarlılık küme.tut  değişim  saflık  karışık küme/kişi';
  console.log('\n' + hdr);
  for (const r of report) {
    console.log(`${r.label.padEnd(30)} ${r.src.padEnd(7)} ${r.method.padEnd(20)} ${pct(r.genderPlayed).padStart(11)} ${pct(r.genderFinal).padStart(9)} ` +
      `${pct(r.genderSpeaker).padStart(9)} ${pct(r.consistency).padStart(10)} ${pct(r.clusterConsistency).padStart(8)} ${pct(r.flipRate).padStart(8)} ` +
      `${pct(r.purity).padStart(7)} ${String(r.mixedClusters ?? '—').padStart(7)} ${r.clustersPerSpeaker?.toFixed(2) ?? '—'}`);
  }
  return report;
}

const speakers = await loadData();
const model = spkModelById(opt('model', DEFAULT_SPK_MODEL));
if (!model) throw new Error('Bilinmeyen model');
let out;
if (flag('compare')) out = await compare(speakers);
else if (flag('train-gender')) out = await trainGender(speakers, model);
else out = await evaluate(speakers, model);
if (opt('json', null) && out) await writeFile(resolve(opt('json')), JSON.stringify(out, null, 1));
