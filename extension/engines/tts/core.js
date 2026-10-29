// Environment-agnostic synthesis core: the same code runs in the extension's worker (onnxruntime-web) and in the
// Node tests (onnxruntime-node). No DOM, no chrome.*, no fetch: model bytes come in as buffers.
//
//   const voice = await loadVoice(ort, voiceDef, buffers, { sessionOptions });
//   const { pcm, sampleRate } = await synthesizeText(voice, 'Merhaba dünya.', { speed: 1.2 });

import { Ahenk } from './ahenk.js';
import { Antalia } from './antalia.js';
import { Ema } from './ema.js';
import { Supertonic } from './supertonic.js';
import { normalizeText } from './normalize.js';
import { concat, convertRate, normalizeLoudness, shiftPitch, timeStretch, trimSilence } from './dsp.js';
import { pitchRatio, resolveTone } from './styles.js';

/** Up to this speed the models' own duration control is used; the rest is WSOLA time-stretch (same pitch). */
export const NATIVE_MAX_SPEED = 1.6;
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 3;
/** Characters of normalized text per model call (bounds latency/memory; long input is split and joined). */
export const MAX_CHUNK_CHARS = 220;
const SENTENCE_GAP = 0.2;
const CLAUSE_GAP = 0.1;

const u8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));

function parseJson(b) {
  if (b && typeof b === 'object' && !(b instanceof ArrayBuffer) && !ArrayBuffer.isView(b)) return b;
  return JSON.parse(new TextDecoder().decode(u8(b)));
}

/**
 * Create the inference sessions of a voice.
 * @param ort onnxruntime-web or onnxruntime-node module
 * @param voiceDef an entry of VOICES (voices.js)
 * @param buffers { [file.name]: ArrayBuffer | Uint8Array }
 * @param opts { sessionOptions?: object, steps?: number }
 */
export async function loadVoice(ort, voiceDef, buffers, opts = {}) {
  const sessionOptions = { graphOptimizationLevel: 'all', ...(opts.sessionOptions || {}) };
  opts = { ...opts, steps: opts.steps || voiceDef.steps };
  const manifest = parseJson(buffers.manifest);
  const b = {};
  for (const f of voiceDef.files) if (f.kind !== 'json') b[f.name] = u8(buffers[f.name]);
  let model;
  if (voiceDef.model === 'ahenk') model = await Ahenk.create(ort, manifest, b, sessionOptions, opts);
  else if (voiceDef.model === 'antalia') model = await Antalia.create(ort, manifest, b, sessionOptions, opts);
  else if (voiceDef.model === 'ema') model = await Ema.create(ort, manifest, b, sessionOptions);
  else if (voiceDef.model === 'supertonic') {
    const styles = {};
    for (const f of voiceDef.files) if (f.name.startsWith('style:')) styles[f.name.slice(6)] = parseJson(buffers[f.name]);
    model = await Supertonic.create(ort, manifest, parseJson(buffers.indexer), styles, b, sessionOptions, opts);
  }
  else throw new Error(`unknown model ${voiceDef.model}`);
  return { id: voiceDef.id, def: voiceDef, model, sampleRate: model.sampleRate };
}

/**
 * Split normalized text into pieces of at most `max` characters at sentence, then clause, then word boundaries.
 * Returns [piece, gapSecondsAfter][].
 */
export function splitText(text, max = MAX_CHUNK_CHARS) {
  const sentences = text
    .split(/(?<=[.!?…])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const units = []; // [text, gap]
  for (const s of sentences) {
    if (s.length <= max) {
      units.push([s, SENTENCE_GAP]);
      continue;
    }
    const clauses = s.split(/(?<=[,;:])\s+/u).filter(Boolean);
    for (const c of clauses) {
      if (c.length <= max) {
        units.push([c, CLAUSE_GAP]);
        continue;
      }
      let cur = '';
      for (const w of c.split(/\s+/)) {
        if (cur && cur.length + 1 + w.length > max) {
          units.push([cur, CLAUSE_GAP]);
          cur = w;
        } else cur = cur ? `${cur} ${w}` : w;
      }
      if (cur) units.push([cur, CLAUSE_GAP]);
    }
    units[units.length - 1][1] = SENTENCE_GAP;
  }
  // pack short sentences together (fewer model calls, natural prosody across them)
  const out = [];
  for (const [t, gap] of units) {
    const last = out[out.length - 1];
    if (last && last[1] === SENTENCE_GAP && last[0].length + 1 + t.length <= max) {
      last[0] = `${last[0]} ${t}`;
      last[1] = gap;
    } else out.push([t, gap]);
  }
  if (out.length) out[out.length - 1][1] = 0;
  return out.filter(([t]) => /\p{L}/u.test(t));
}

/**
 * Split a requested speed into the model's native part and the time-stretch remainder. With a pitch ratio k the
 * model is asked for native/k (k times longer audio) and the result is resampled by k afterwards (shiftPitch), so
 * the duration is the requested one; `model` is the speed the model actually receives (kept within its native range).
 */
export function speedPlan(speed, k = 1) {
  const s = Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number(speed) || 1));
  const native = Math.min(Math.max(s, MIN_SPEED * k), NATIVE_MAX_SPEED * k);
  return { speed: s, native, model: native / k, stretch: Math.max(1, s / native) };
}

/**
 * Text -> mono PCM. Normalizes, splits long text, synthesizes each piece, trims model silence, joins with short
 * pauses, applies any speed beyond NATIVE_MAX_SPEED by time-stretching and brings the line to a common loudness.
 * seed: noise seed (default: a hash of the text); preset: Supertonic preset key (default: the voice's own).
 * tone { style, pitch, quality, blend } (styles.js): voice-specific style/temperature, flow steps, a pitch shift and
 * (Supertonic only) a blend with a second preset.
 * @returns {Promise<{ pcm: Float32Array, sampleRate: number, stats: object }>}
 */
export async function synthesizeText(voice, text, { speed = 1, seed, isCancelled, outputRate, maxChars, tone, preset } = {}) {
  const t0 = now();
  const rate = voice.sampleRate;
  const rt = resolveTone(tone, voice.model.styles || [], voice.def.model);
  const k = pitchRatio(rt.semitones);
  const plan = speedPlan(speed, k);
  const modelOpts = { style: rt.ahenkStyle, temperature: rt.temperature, steps: rt.steps, preset: preset || voice.def.preset, blend: rt.blend };
  const spoken = normalizeText(text);
  // a different (but repeatable) noise per line: with one fixed seed every line started from the same noise and
  // the melodies sounded alike
  if (seed === undefined) seed = textSeed(spoken);
  const pieces = splitText(spoken, maxChars);
  const parts = [];
  for (let i = 0; i < pieces.length; i++) {
    if (isCancelled && isCancelled()) throw abortError();
    const [piece, gap] = pieces[i];
    const audio = await voice.model.speak(piece, { speed: plan.model, seed, isCancelled, normalized: true, ...modelOpts });
    const trimmed = trimSilence(audio, rate);
    if (!trimmed.length) continue;
    parts.push(trimmed);
    if (gap && i < pieces.length - 1) parts.push(new Float32Array(Math.round((gap / plan.model) * rate)));
  }
  let pcm = concat(parts);
  if (rt.semitones) pcm = shiftPitch(pcm, k);
  if (plan.stretch > 1.01) pcm = timeStretch(pcm, plan.stretch, rate);
  normalizeLoudness(pcm, rate);
  let sampleRate = rate;
  if (outputRate && outputRate !== rate) {
    pcm = convertRate(pcm, rate, outputRate);
    sampleRate = outputRate;
  }
  const seconds = pcm.length / sampleRate;
  const computeSec = (now() - t0) / 1000;
  return {
    pcm,
    sampleRate,
    stats: { normalized: spoken, chunks: pieces.length, seconds, computeSec, rtf: seconds ? computeSec / seconds : 0, tone: rt, ...plan },
  };
}

/** 31-bit FNV-1a hash of the text: the default noise seed of a line. */
export function textSeed(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0) & 0x7fffffff;
}

export async function releaseVoice(voice) {
  await voice?.model?.release?.();
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function abortError() {
  try {
    return new DOMException('Aborted', 'AbortError');
  } catch {
    const e = new Error('Aborted');
    e.name = 'AbortError';
    return e;
  }
}
