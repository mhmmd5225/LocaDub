// Measurement-only prosody and level analysis for synthesized speech (tests/tts/compare.mjs). Not part of the
// extension: a YIN pitch tracker plus a gated RMS level, enough to compare voices and tone settings.
//
//   const a = analyze(pcm, sampleRate);
//   a.f0Std      F0 standard deviation in semitones (how much the melody moves; flat/robotic speech is low)
//   a.f0Range    5th–95th percentile F0 span in semitones
//   a.finalRise  semitones from the body of the utterance to its last 20% voiced frames (questions should rise)
//   a.levelDb    gated RMS level, dBFS (silence and pauses excluded)
//   a.peakDb     sample peak, dBFS

import { resample } from '../../extension/engines/tts/dsp.js';

const RATE = 16000;
const FRAME = 0.04;
const HOP = 0.01;
const FMIN = 65;
const FMAX = 420;
const THRESHOLD = 0.15;

const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));
const st = (f, ref) => 12 * Math.log2(f / ref);

/** YIN F0 per 10 ms frame (0 = unvoiced). */
export function trackF0(pcm, sampleRate) {
  const x = sampleRate === RATE ? pcm : resample(pcm, sampleRate / RATE);
  const W = Math.round(FRAME * RATE);
  const H = Math.round(HOP * RATE);
  const tMin = Math.floor(RATE / FMAX);
  const tMax = Math.ceil(RATE / FMIN);
  const d = new Float32Array(tMax + 1);
  const f0 = [];
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  for (let s = 0; s + W + tMax < x.length; s += H) {
    let energy = 0;
    for (let i = 0; i < W; i++) energy += x[s + i] * x[s + i];
    if (Math.sqrt(energy / W) < peak * 0.03) {
      f0.push(0);
      continue;
    }
    for (let tau = 1; tau <= tMax; tau++) {
      let sum = 0;
      for (let i = 0; i < W; i++) {
        const diff = x[s + i] - x[s + i + tau];
        sum += diff * diff;
      }
      d[tau] = sum;
    }
    // cumulative mean normalized difference
    let run = 0;
    let best = -1;
    for (let tau = 1; tau <= tMax; tau++) {
      run += d[tau];
      d[tau] = run ? (d[tau] * tau) / run : 1;
    }
    for (let tau = tMin; tau <= tMax; tau++) {
      if (d[tau] < THRESHOLD) {
        while (tau + 1 <= tMax && d[tau + 1] < d[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) {
      f0.push(0);
      continue;
    }
    const a = d[best - 1] ?? d[best];
    const b = d[best];
    const c = d[best + 1] ?? d[best];
    const den = a - 2 * b + c;
    const t = den ? best + (0.5 * (a - c)) / den : best;
    f0.push(RATE / t);
  }
  return f0;
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];

/** Gated RMS level (dBFS): 20 ms blocks, absolute gate −60 dBFS, relative gate −20 dB below the ungated mean. */
export function level(pcm, sampleRate) {
  const B = Math.round(0.02 * sampleRate);
  const blocks = [];
  for (let s = 0; s + B <= pcm.length; s += B) {
    let e = 0;
    for (let i = 0; i < B; i++) e += pcm[s + i] * pcm[s + i];
    const ms = e / B;
    if (db(Math.sqrt(ms)) > -60) blocks.push(ms);
  }
  if (!blocks.length) return -Infinity;
  const mean = blocks.reduce((a, b) => a + b, 0) / blocks.length;
  const gated = blocks.filter((ms) => ms >= mean / 100);
  return db(Math.sqrt(gated.reduce((a, b) => a + b, 0) / gated.length));
}

export function analyze(pcm, sampleRate) {
  const f0 = trackF0(pcm, sampleRate);
  // drop octave jumps: keep frames within an octave of the median
  const voiced = f0.filter((f) => f > 0);
  const sorted = [...voiced].sort((a, b) => a - b);
  const med = sorted.length ? percentile(sorted, 0.5) : 0;
  const ok = voiced.filter((f) => f > med / 1.9 && f < med * 1.9);
  let peak = 0;
  for (const v of pcm) peak = Math.max(peak, Math.abs(v));
  const out = { f0Median: med, f0Std: 0, f0Range: 0, finalRise: 0, voicedFrames: ok.length, levelDb: level(pcm, sampleRate), peakDb: db(peak) };
  if (ok.length < 10) return out;
  const semis = ok.map((f) => st(f, med));
  const mean = semis.reduce((a, b) => a + b, 0) / semis.length;
  out.f0Std = Math.sqrt(semis.reduce((a, b) => a + (b - mean) ** 2, 0) / semis.length);
  const s = [...semis].sort((a, b) => a - b);
  out.f0Range = percentile(s, 0.95) - percentile(s, 0.05);
  const tail = Math.max(3, Math.round(semis.length * 0.2));
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  out.finalRise = avg(semis.slice(-tail)) - avg(semis.slice(Math.round(semis.length * 0.2), -tail));
  return out;
}
