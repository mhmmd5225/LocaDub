// Antalia-2 Mini (cloud0day3/antalia-mini, Apache-2.0): 7.6M params, one synthetic male voice, 48 kHz,
// character input (Turkish letters + punctuation, BOS/EOS). The engine (antalia/tts.js) and text frontend
// (antalia/frontend.js) are copied unchanged from the model's Space; this file puts them behind the same
// speak() interface as Ahenk. Structure follows Harfiyen's src/tts/mini.ts (MIT, Copyright (c) 2026 Özcan Çelik).
//
// Text path: normalizeText (trnorm + local additions: numbers, %, time, money, abbreviations, English names and
// acronyms) and then Antalia's own frontend (modelText), which lowercases, re-checks numbers/abbreviations it still
// finds and drops characters outside the symbol table. Speed goes to the duration predictor natively.

import { createFrontend, decodeAsset } from './antalia/frontend.js';
import { Engine, speak as antaliaSpeak } from './antalia/tts.js';
import { normalizeText } from './normalize.js';
import { concat } from './dsp.js';

export class Antalia {
  constructor(engine, frontend) {
    this.engine = engine;
    this.frontend = frontend;
    this.sampleRate = 48000;
    this.styles = []; // Antalia'da stil gömmesi yok; üslup yalnızca sıcaklık olarak uygulanır
  }

  /** buffers: { manifest (object), text, cond, flow, vocoder (bytes), frontend (gz bytes) } */
  static async create(ort, manifest, buffers, sessionOptions, opts = {}) {
    const frontend = createFrontend(await decodeAsset(buffers.frontend));
    frontend.warmup();
    // Same as Engine.create (antalia/tts.js), but with the caller's full session options (threads in Node)
    const engine = new Engine();
    engine.ort = ort;
    engine.sessions = {};
    engine.defaults = { steps: 4, cfg: 1, speed: 1, temperature: 1, ...(manifest.defaults || {}) };
    engine.options = { prefix: '', suffix: '', prefix_initials: null, gem_stretch: 1, tone: null, fade_ms: 5, ...(manifest.options || {}) };
    engine.symbolId = new Map(manifest.symbols.map((c, i) => [c, i]));
    const so = { graphOptimizationLevel: 'all', ...sessionOptions };
    for (const k of ['text', 'cond', 'flow', 'vocoder']) {
      const b = buffers[k];
      engine.sessions[k] = await ort.InferenceSession.create(b instanceof Uint8Array ? b : new Uint8Array(b), so);
    }
    if (opts.steps) engine.defaults.steps = opts.steps;
    return new Antalia(engine, frontend);
  }

  modelText(text, normalized = false) {
    return this.frontend.modelText(normalized ? text : normalizeText(text));
  }

  /**
   * Text -> 48 kHz mono audio. speed > 1 speaks faster (relative to the release's own 0.95 pace).
   * temperature: noise scale (lower = flatter/steadier, higher = more varied intonation; default: manifest's 0.6);
   * steps: flow steps for this call (default: manifest's 8). Both go straight to antalia/tts.js speak().
   */
  async speak(text, { speed = 1, seed = 0, isCancelled, normalized = false, temperature, steps } = {}) {
    const modelText = this.modelText(text, normalized);
    if (!/\p{L}/u.test(modelText)) return new Float32Array(0);
    const out = [];
    for await (const { audio } of antaliaSpeak(this.engine, modelText, { seed, speed: this.engine.defaults.speed * speed, temperature, steps })) {
      out.push(audio);
      if (isCancelled && isCancelled()) throw new DOMException('Aborted', 'AbortError');
    }
    return concat(out);
  }

  async release() {
    for (const s of Object.values(this.engine.sessions)) await s.release?.();
  }
}
