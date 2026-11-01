// Sahte konuşmacı motoru (test için). engines/spk/index.js ile aynı API. Model yerine perdeden vektör: ötümlü
// çerçevelerin ortanca log-perdesi çevresinde Gauss tümseği (yarım ton kutuları, σ 1.5 yarım ton), birim uzunlukta.
// Yakın perdeli sesler aynı kümeye düşer; e2e (erkek → kadın konuşma) için yeterli.

import { estimateF0, voicedF0 } from '../../content/gender.js';

export const id = 'spk';
const RATE = 16000;
const BINS = 31;

export async function info() {
  return { id: 'mock-spk', label: 'Sahte konuşmacı (test)', sizeMB: 0, license: 'MIT', cached: true, cachePrefix: 'mock://spk/' };
}

export async function init({ onProgress } = {}) {
  onProgress?.({ url: 'mock://spk/model.onnx', loaded: 1, total: 1 });
}

export async function embed(pcm) {
  const W = Math.round(0.0427 * RATE);
  const fr = [];
  for (let s = 0; s + W <= pcm.length; s += 800) fr.push([s / RATE, estimateF0(pcm.subarray(s, s + W), RATE)]);
  const f0 = voicedF0(fr);
  const voicedSec = f0.length * 0.05;
  if (f0.length < 8) return { vector: null, voicedSec, score: null, f0: f0.map(Math.round) };
  const med = [...f0].sort((a, b) => a - b)[f0.length >> 1];
  const b = 12 * Math.log2(med / 70);
  const v = Float32Array.from({ length: BINS }, (_, k) => Math.exp(-((k - b) ** 2) / 4.5));
  const n = Math.hypot(...v) || 1;
  return { vector: v.map((x) => x / n), voicedSec, score: null, f0: f0.map(Math.round) };
}

export async function dispose() {}
