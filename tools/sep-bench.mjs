#!/usr/bin/env node
// Ses ayırma motorunun (extension/engines/sep) gerçek modelle hız + kalite ölçümü.
//
//   node tools/sep-bench.mjs [--model kim-vocal-2|all] [--runtime node|web] [--threads 4] [--seconds 30]
//                            [--rate 48000] [--overlap 0.5] [--batch 1] [--denoise] [--music müzik.wav]
//                            [--seam] [--out <dizin>] [--dir <model dizini>]
//
// Karışım: tests/extension/fixtures/*.wav konuşmaları (16 kHz mono → girdi hızına), ortada; sentetik müzik
// (davul, bas, akor, arpej; stereo) ya da --music ile verilen stereo/mono WAV. Ölçüler:
//   RTF        işlem süresi / ses süresi (yeniden örnekleme dahil, ısınma hariç)
//   SDR        10·log10(|müzik|² / |eşlik − müzik|²), iki kanal; "karışım" satırı hiç işlem yapılmamış hali
//   kalıntı    eşlikteki konuşma bileşeni: <eşlik − müzik, konuşma> / |konuşma|², dB (girişte 0 dB)
//   sessiz     konuşmasız bölümlerde müziğin bozulması (SDR, dB)
//   --seam     aynı sesi iki çağrıda (CONTEXT_SEC bağlamı + joinOverlap) ve tek çağrıda işleyip farkın SNR'ı
// --runtime web: paketli onnxruntime-web WASM (ort.wasm.min.mjs) Node içinde; node: onnxruntime-node (CPU).
// Modeller --dir'e (varsayılan tests/extension/.models/sep) indirilir, boyut + sha256 denetlenir.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SEP_MODELS, sepModelById } from '../extension/engines/sep/models.js';
import { createSeparator, joinOverlap, CONTEXT_SEC, FADE_SEC } from '../extension/engines/sep/separator.js';
import { resample } from '../extension/engines/sep/resample.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const argv = process.argv.slice(2);
const flag = (k) => argv.includes('--' + k);
const opt = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const modelArg = opt('model', 'kim-vocal-2');
const runtime = opt('runtime', 'node');
const threads = Number(opt('threads', 4));
const seconds = Number(opt('seconds', 30));
const rate = Number(opt('rate', 48000));
const overlap = Number(opt('overlap', 0.5));
const batch = Number(opt('batch', 1));
const denoise = flag('denoise');
const dir = resolve(opt('dir', join(root, 'tests/extension/.models/sep')));
const outDir = opt('out', null);

// ---- WAV ----
function readWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = dv.getUint32(off + 4, true);
    if (id === 'fmt ') fmt = { format: dv.getUint16(off + 8, true), ch: dv.getUint16(off + 10, true), rate: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) };
    if (id === 'data') data = { off: off + 8, size: Math.min(size, buf.length - off - 8) };
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV okunamadı');
  const bps = fmt.bits / 8, frames = Math.floor(data.size / (bps * fmt.ch));
  const chans = Array.from({ length: fmt.ch }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.ch; c++) {
      const p = data.off + (i * fmt.ch + c) * bps;
      chans[c][i] = fmt.format === 3 ? dv.getFloat32(p, true) : fmt.bits === 16 ? dv.getInt16(p, true) / 32768 : fmt.bits === 24 ? ((dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16)) / 8388608) : dv.getInt32(p, true) / 2147483648;
    }
  }
  return { rate: fmt.rate, chans };
}

function writeWav(path, chans, sr) {
  const n = chans[0].length, ch = chans.length;
  const buf = Buffer.alloc(44 + n * ch * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * ch * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * ch * 2, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(chans[c][i] * 32767))), 44 + (i * ch + c) * 2);
  return writeFile(path, buf);
}

// ---- Sentetik müzik (tekrarlanabilir) ----
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function synthMusic(n, sr) {
  const L = new Float32Array(n), R = new Float32Array(n);
  const rnd = rng(7);
  const bpm = 100, beat = (60 / bpm) * sr;
  const chords = [[57, 60, 64], [53, 57, 60], [55, 59, 62], [52, 55, 59]]; // Am F G Em
  const hz = (m) => 440 * 2 ** ((m - 69) / 12);
  let lp = 0, hpPrev = 0, hpOut = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr, b = i / beat, bi = Math.floor(b), ph = (b - bi) * beat / sr; // vuruştaki saniye
    const bar = Math.floor(bi / 4), chord = chords[bar % 4];
    // kick (1 ve 3), snare (2 ve 4), hihat (sekizlik)
    let kick = 0, snare = 0, hat = 0;
    if (bi % 2 === 0) kick = Math.sin(2 * Math.PI * (50 * ph + 60 * (1 - Math.exp(-ph * 30)) / 30)) * Math.exp(-ph * 9);
    const noise = rnd() * 2 - 1;
    if (bi % 2 === 1) snare = noise * Math.exp(-ph * 18) * 0.6 + Math.sin(2 * Math.PI * 190 * ph) * Math.exp(-ph * 25) * 0.3;
    const eighth = ((b * 2) % 1) * beat / 2 / sr;
    hpOut = 0.95 * (hpOut + noise - hpPrev); hpPrev = noise;
    hat = hpOut * Math.exp(-eighth * 60) * 0.25;
    // bas: akorun kökü, sekizlik, testere → alçak geçiren
    const f0 = hz(chord[0] - 24);
    const saw = 2 * ((t * f0) % 1) - 1;
    lp += 0.04 * (saw - lp);
    const bass = lp * (0.6 + 0.4 * Math.exp(-eighth * 8));
    // pad: akor, yumuşak üçgen + biraz detune
    let pad = 0;
    for (const m of chord) {
      const f = hz(m);
      for (const d of [-0.003, 0.003]) { const x = (t * f * (1 + d)) % 1; pad += (4 * Math.abs(x - 0.5) - 1) * 0.08; }
    }
    // arpej (on altılık, akor notaları, oktav üstü), sağa yakın
    const six = Math.floor(b * 4), sph = ((b * 4) % 1) * beat / 4 / sr;
    const af = hz(chord[six % 3] + 12);
    const arp = Math.sin(2 * Math.PI * af * t) * Math.exp(-sph * 14) * 0.18;
    const drums = 0.7 * kick + snare * 0.5 + hat;
    L[i] = drums + bass * 0.5 + pad * 1.0 + arp * 0.4;
    R[i] = drums + bass * 0.5 + pad * 0.8 + arp * 1.0;
  }
  return [L, R];
}

async function speechTrack(n, sr) {
  const fx = join(root, 'tests/extension/fixtures');
  const files = (await readdir(fx)).filter((f) => f.endsWith('.wav')).sort();
  const parts = [];
  for (const f of files) {
    const w = readWav(await readFile(join(fx, f)));
    parts.push(resample(w.chans[0], w.rate, sr));
  }
  // konuşma bölümleri arasında 1.5 sn sessizlik; uzunluk dolana kadar döngü
  const s = new Float32Array(n);
  const gap = Math.round(1.5 * sr);
  let pos = Math.round(1 * sr), k = 0;
  const speechMask = new Uint8Array(n);
  while (pos < n) {
    const p = parts[k++ % parts.length];
    const m = Math.min(p.length, n - pos);
    s.set(p.subarray(0, m), pos);
    speechMask.fill(1, pos, pos + m);
    pos += m + gap;
  }
  return { s, speechMask };
}

const energy = (a, mask, want = 1) => { let e = 0; for (let i = 0; i < a.length; i++) if (!mask || mask[i] === want) e += a[i] * a[i]; return e; };
const db = (x) => 10 * Math.log10(Math.max(x, 1e-20));

function metrics({ accL, accR, musL, musR, sp, mask }) {
  let num = 0, err = 0, dot = 0, se = 0, numQ = 0, errQ = 0;
  for (let i = 0; i < accL.length; i++) {
    const eL = accL[i] - musL[i], eR = accR[i] - musR[i];
    num += musL[i] ** 2 + musR[i] ** 2;
    err += eL * eL + eR * eR;
    dot += (eL + eR) * sp[i];
    se += 2 * sp[i] * sp[i];
    if (!mask[i]) { numQ += musL[i] ** 2 + musR[i] ** 2; errQ += eL * eL + eR * eR; }
  }
  return { sdr: db(num / err), residual: 20 * Math.log10(Math.max(Math.abs(dot / se), 1e-10)), quiet: db(numQ / errQ) };
}

// ---- Model dosyası ----
async function ensureModel(m) {
  const path = join(dir, m.file);
  const ok = await stat(path).then((s) => s.size === m.bytes, () => false);
  if (!ok) {
    await mkdir(dir, { recursive: true });
    process.stderr.write(`indiriliyor: ${m.url}\n`);
    const res = await fetch(m.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${m.url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length !== m.bytes) throw new Error(`boyut uyuşmuyor: ${buf.length} ≠ ${m.bytes}`);
    await writeFile(path, buf);
  }
  const buf = await readFile(path);
  const sha = createHash('sha256').update(buf).digest('hex');
  if (m.sha256 && sha !== m.sha256) throw new Error(`sha256 uyuşmuyor: ${m.file}`);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function loadOrt() {
  if (runtime === 'web') {
    const ort = await import(pathToFileURL(join(root, 'extension/lib/ort/ort.wasm.min.mjs')).href);
    ort.env.wasm.numThreads = threads;
    ort.env.wasm.wasmPaths = pathToFileURL(join(root, 'extension/lib/ort/')).href;
    return { ort, backend: 'wasm' };
  }
  const require = createRequire(join(root, 'tests/tts/package.json'));
  let ort;
  try { ort = require('onnxruntime-node'); } catch {
    throw new Error('onnxruntime-node yok: cd tests/tts && ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci');
  }
  return { ort, backend: 'cpu' };
}

async function bench(m, ort, be, mix) {
  const bytes = await ensureModel(m);
  const sep = createSeparator({
    model: m, backend: be, ort, modelData: bytes, overlap, batch, denoise,
    sessionOptions: be === 'cpu' ? { intraOpNumThreads: threads, executionProviders: ['cpu'] } : {},
  });
  let t = performance.now();
  await sep.load();
  const loadMs = performance.now() - t;
  t = performance.now();
  const r = await sep.process(mix.L, mix.R, rate);
  const ms = performance.now() - t;
  const q = metrics({ accL: r.left, accR: r.right, musL: mix.musL, musR: mix.musR, sp: mix.sp, mask: mix.mask });
  const row = { model: m.id, backend: sep.backend, loadMs: Math.round(loadMs), ms: Math.round(ms), rtf: ms / 1000 / seconds, ...q };
  if (flag('seam')) row.seam = await seam(sep, mix, r);
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeWav(join(outDir, `${m.id}-acc.wav`), [r.left, r.right], rate);
  }
  await sep.dispose();
  return row;
}

// İki çağrı (C bağlamı) + joinOverlap ile tek çağrının farkı: birleşme noktası ±0.1 sn ("dikiş") ve çevresindeki
// ±3 sn. Tek çağrının kendisi de iç pencere ızgarasına bağlı olduğundan ±3 sn değeri modelin ızgara gürültüsüdür;
// dikişte belirgin düşüş yoksa birleşme duyulmaz.
async function seam(sep, mix, whole) {
  const out = {};
  const n = mix.L.length;
  const ctxs = opt('contexts', `0.25,0.5,1,${CONTEXT_SEC},3`).split(',').map(Number);
  const snr = (jl, jr, lo, hi) => {
    let s = 0, e = 0;
    for (let i = Math.max(0, lo); i < Math.min(n, hi); i++) {
      s += whole.left[i] ** 2 + whole.right[i] ** 2;
      e += (jl[i] - whole.left[i]) ** 2 + (jr[i] - whole.right[i]) ** 2;
    }
    return +db(s / e).toFixed(1);
  };
  for (const c of ctxs) {
    const ov = Math.round(2 * c * rate);
    const cut = Math.round(n * 0.47); // birinci çağrının sonu
    const a = await sep.process(mix.L.subarray(0, cut), mix.R.subarray(0, cut), rate);
    const b = await sep.process(mix.L.subarray(cut - ov), mix.R.subarray(cut - ov), rate);
    const jl = joinOverlap(a.left, b.left, ov, Math.round(FADE_SEC * rate));
    const jr = joinOverlap(a.right, b.right, ov, Math.round(FADE_SEC * rate));
    const join = cut - ov + Math.floor(ov / 2);
    out[`${c}s`] = { dikiş: snr(jl, jr, join - 0.1 * rate, join + 0.1 * rate), çevre: snr(jl, jr, join - 3 * rate, join + 3 * rate) };
  }
  return out;
}

async function main() {
  const n = Math.round(seconds * rate);
  let musL, musR;
  const musicPath = opt('music', null);
  if (musicPath) {
    const w = readWav(await readFile(musicPath));
    const l = resample(w.chans[0], w.rate, rate), r = resample(w.chans[1] || w.chans[0], w.rate, rate);
    musL = new Float32Array(n); musR = new Float32Array(n);
    musL.set(l.subarray(0, n)); musR.set(r.subarray(0, n));
  } else [musL, musR] = synthMusic(n, rate);
  const { s: sp, speechMask: mask } = await speechTrack(n, rate);
  // konuşma/müzik oranı konuşmalı bölümlerde 0 dB
  const ratio = Math.sqrt(energy(musL, mask) / Math.max(energy(sp, mask), 1e-9));
  for (let i = 0; i < n; i++) sp[i] *= ratio;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(musL[i] + sp[i]), Math.abs(musR[i] + sp[i]));
  const g = 0.9 / peak;
  for (let i = 0; i < n; i++) { musL[i] *= g; musR[i] *= g; sp[i] *= g; }
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = musL[i] + sp[i]; R[i] = musR[i] + sp[i]; }
  const mix = { L, R, musL, musR, sp, mask };
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeWav(join(outDir, 'mix.wav'), [L, R], rate);
    await writeWav(join(outDir, 'music.wav'), [musL, musR], rate);
  }
  const base = metrics({ accL: L, accR: R, musL, musR, sp, mask });
  console.log(`karışım: ${seconds} sn @ ${rate} Hz stereo, ${musicPath ? 'müzik: ' + musicPath : 'sentetik müzik'}; çalışma zamanı ${runtime}, ${threads} iş parçacığı, overlap ${overlap}, batch ${batch}${denoise ? ', denoise' : ''}`);
  console.log(`karışım (işlemsiz): SDR ${base.sdr.toFixed(2)} dB, kalıntı ${base.residual.toFixed(1)} dB`);
  const { ort, backend } = await loadOrt();
  const models = modelArg === 'all' ? SEP_MODELS : modelArg.split(',').map((id) => sepModelById(id) || (() => { throw new Error(`bilinmeyen model ${id}`); })());
  for (const m of models) {
    const r = await bench(m, ort, backend, mix);
    console.log(`${r.model.padEnd(12)} ${r.backend}: RTF ${r.rtf.toFixed(3)} (${r.ms} ms, yükleme ${r.loadMs} ms) · SDR ${r.sdr.toFixed(2)} dB (+${(r.sdr - base.sdr).toFixed(2)}) · kalıntı ${r.residual.toFixed(1)} dB · sessiz bölüm ${r.quiet.toFixed(1)} dB${r.seam ? ' · birleşme SNR ' + JSON.stringify(r.seam) : ''}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
