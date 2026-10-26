// SentencePiece unigram tokenizer in plain JS + MarianTokenizer-style vocabulary mapping.
//
// Adapted from Harfiyen (https://github.com/ozcancelik/harfiyen), src/punct/spm.ts and
// src/mt/translator.ts — Copyright (c) Ozcan Celik, MIT License. Changes: plain JS, reads the
// SentencePiece .spm protobuf directly (Harfiyen pre-converts it to JSON in Python), and
// follows sentencepiece's "unknown only if no single-character piece" rule.
//
// Subset implemented (what opus-mt models need): nmt_nfkc normaliser approximated with
// String.prototype.normalize('NFKC'), dummy prefix, whitespace as "▁", no byte fallback.

const SPACE = '▁'; // ▁

function varint(b, p) {
  let r = 0;
  let s = 1;
  for (;;) {
    const x = b[p++];
    r += (x & 127) * s;
    if (!(x & 128)) return [r, p];
    s *= 128;
  }
}

function fields(b, start, end, cb) {
  let p = start;
  while (p < end) {
    let key;
    [key, p] = varint(b, p);
    const f = Math.floor(key / 8);
    const w = key & 7;
    if (w === 0) { let v; [v, p] = varint(b, p); cb(f, w, v, p, p); }
    else if (w === 2) { let l; [l, p] = varint(b, p); cb(f, w, null, p, p + l); p += l; }
    else if (w === 5) { cb(f, w, null, p, p + 4); p += 4; }
    else if (w === 1) { cb(f, w, null, p, p + 8); p += 8; }
    else throw new Error(`spm: unsupported wire type ${w}`);
  }
}

// int32 fields with negative values are 10-byte varints; only -1 occurs in practice.
const int32 = (v) => (v > 2 ** 31 ? -1 : v);

/**
 * Parses a SentencePiece ModelProto (.model / .spm file).
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {{pieces:string[], scores:Float32Array, types:Uint8Array, modelType:number,
 *   byteFallback:boolean, unkId:number, bosId:number, eosId:number, padId:number,
 *   normalizer:{name:string, addDummyPrefix:boolean, removeExtraWhitespaces:boolean}}}
 */
export function parseSpmModel(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const dec = new TextDecoder();
  const pieces = [];
  const scores = [];
  const types = [];
  const m = {
    modelType: 1, byteFallback: false, unkId: 0, bosId: 1, eosId: 2, padId: -1,
    normalizer: { name: '', addDummyPrefix: true, removeExtraWhitespaces: true },
  };
  fields(b, 0, b.length, (f, w, _v, a, e) => {
    if (f === 1 && w === 2) {
      let piece = '';
      let score = 0;
      let type = 1;
      fields(b, a, e, (pf, pw, pv, pa, pe) => {
        if (pf === 1) piece = dec.decode(b.subarray(pa, pe));
        else if (pf === 2 && pw === 5) score = dv.getFloat32(pa, true);
        else if (pf === 3) type = pv;
      });
      pieces.push(piece);
      scores.push(score);
      types.push(type);
    } else if (f === 2 && w === 2) {
      fields(b, a, e, (tf, tw, tv) => {
        if (tw !== 0) return;
        if (tf === 3) m.modelType = tv;
        else if (tf === 35) m.byteFallback = !!tv;
        else if (tf === 40) m.unkId = int32(tv);
        else if (tf === 41) m.bosId = int32(tv);
        else if (tf === 42) m.eosId = int32(tv);
        else if (tf === 43) m.padId = int32(tv);
      });
    } else if (f === 3 && w === 2) {
      fields(b, a, e, (nf, nw, nv, na, ne) => {
        if (nf === 1) m.normalizer.name = dec.decode(b.subarray(na, ne));
        else if (nf === 3 && nw === 0) m.normalizer.addDummyPrefix = !!nv;
        else if (nf === 4 && nw === 0) m.normalizer.removeExtraWhitespaces = !!nv;
      });
    }
  });
  return { pieces, scores: Float32Array.from(scores), types: Uint8Array.from(types), ...m };
}

/** SentencePiece unigram encoder (Viterbi over piece scores, as in unigram_model.cc). */
export class SpmTokenizer {
  /** @param {ReturnType<typeof parseSpmModel>} model */
  constructor(model) {
    if (model.modelType !== 1) throw new Error('spm: only unigram models are supported');
    this.model = model;
    this.ids = new Map();
    this.maxLen = 1;
    let min = Infinity;
    model.pieces.forEach((p, i) => {
      const t = model.types[i];
      if (t !== 1 && t !== 4) return; // normal and user-defined pieces can match text
      this.ids.set(p, i);
      this.maxLen = Math.max(this.maxLen, [...p].length);
      if (t === 1) min = Math.min(min, model.scores[i]);
    });
    // sentencepiece: unknown pieces score (min score - 10).
    this.unkScore = min - 10;
    this.unkId = model.unkId;
  }

  piece(id) {
    return this.model.pieces[id];
  }

  normalize(text) {
    let t = text.normalize('NFKC');
    // nmt_nfkc also maps control/odd whitespace to plain spaces.
    t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[\s ​]+/g, ' ');
    t = t.trim();
    return t;
  }

  /** Text -> piece ids (no BOS/EOS). */
  encode(text) {
    const norm = SPACE + this.normalize(text).replaceAll(' ', SPACE);
    const chars = [...norm];
    const n = chars.length;
    const scores = this.model.scores;
    const best = new Float64Array(n + 1).fill(-Infinity);
    const from = new Int32Array(n + 1).fill(-1);
    const via = new Int32Array(n + 1).fill(-1);
    best[0] = 0;
    for (let i = 0; i < n; i++) {
      if (best[i] === -Infinity) continue;
      let s = '';
      let single = false;
      const lim = Math.min(n, i + this.maxLen);
      for (let j = i; j < lim; j++) {
        s += chars[j];
        const id = this.ids.get(s);
        if (id === undefined) continue;
        if (j === i) single = true;
        const sc = best[i] + scores[id];
        if (sc > best[j + 1]) {
          best[j + 1] = sc;
          from[j + 1] = i;
          via[j + 1] = id;
        }
      }
      if (!single) {
        const sc = best[i] + this.unkScore;
        if (sc > best[i + 1]) {
          best[i + 1] = sc;
          from[i + 1] = i;
          via[i + 1] = this.unkId;
        }
      }
    }
    const ids = [];
    for (let k = n; k > 0; k = from[k]) ids.push(via[k]);
    ids.reverse();
    // sentencepiece merges runs of unknown characters into one <unk>.
    return ids.filter((id, i) => !(id === this.unkId && i > 0 && ids[i - 1] === this.unkId));
  }
}

/**
 * MarianTokenizer: source SentencePiece pieces looked up in the shared vocab.json
 * (pieces missing from it become <unk>), then </s>.
 */
export class MarianTokenizer {
  /**
   * @param {ArrayBuffer|Uint8Array} sourceSpm  source.spm bytes
   * @param {Record<string, number>} vocab        vocab.json (piece -> id)
   */
  constructor(sourceSpm, vocab) {
    this.spm = new SpmTokenizer(parseSpmModel(sourceSpm));
    this.vocab = vocab;
    const size = Math.max(...Object.values(vocab)) + 1;
    this.pieces = new Array(size);
    for (const [p, i] of Object.entries(vocab)) this.pieces[i] = p;
    this.eos = vocab['</s>'];
    this.unk = vocab['<unk>'];
    this.pad = vocab['<pad>'];
  }

  /** Text -> vocabulary ids ending in </s> (truncated to maxLen). */
  encode(text, maxLen = 512) {
    // MarianTokenizer strips language codes like ">>tur<<" before SentencePiece; keep them as-is.
    const codes = [];
    const body = text.replace(/^\s*(>>[a-z_]{2,8}<<)\s*/i, (_m, c) => { codes.push(c); return ''; });
    const out = codes.map((c) => this.vocab[c] ?? this.unk);
    for (const id of this.spm.encode(body)) {
      out.push(id === this.spm.unkId ? this.unk : (this.vocab[this.spm.piece(id)] ?? this.unk));
    }
    return [...out.slice(0, maxLen - 1), this.eos];
  }

  /** Vocabulary ids -> text, without special tokens. */
  decode(ids) {
    return ids
      .filter((id) => id !== this.eos && id !== this.pad && id !== this.unk)
      .map((id) => this.pieces[id] ?? '')
      .join('')
      .replaceAll(SPACE, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
