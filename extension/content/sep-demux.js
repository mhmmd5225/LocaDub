// MSE ses eklemelerinden kodlanmış paket çıkarır (en küçük akış ayrıştırıcıları; saf, node testleriyle sınanır).
// - WebM/EBML (YouTube'da opus: audio/webm; codecs="opus"): EBML başlığı + Segment/Info/Tracks (ilklendirme) ve
//   Cluster > SimpleBlock / BlockGroup. Eklemeler herhangi bir bayt sınırında bölünebilir.
// - Parçalı MP4 (audio/mp4; codecs="mp4a.40.x"): ftyp/moov (ilklendirme), moof + mdat (tfdt, trun).
// push(bytes, { tso }) → [{ t, dur, data, cfg }]; t = medya zamanı (sn) = akış zamanı + SourceBuffer.timestampOffset.
// cfg WebCodecs AudioDecoder yapılandırmasıdır: { codec, sampleRate, numberOfChannels, description? }.

const EBML = 0x1A45DFA3, SEGMENT = 0x18538067, CLUSTER = 0x1F43B675, INFO = 0x1549A966, TRACKS = 0x1654AE6B;
const TIMECODE = 0xE7, SIMPLEBLOCK = 0xA3, BLOCKGROUP = 0xA0, BLOCK = 0xA1, BLOCKDURATION = 0x9B;
const TRACKENTRY = 0xAE, TRACKNUMBER = 0xD7, TRACKTYPE = 0x83, CODECID = 0x86, CODECPRIVATE = 0x63A2, AUDIO = 0xE1;
const SAMPLINGFREQ = 0xB5, CHANNELS = 0x9F, CONTENTENCODINGS = 0x6D80, TIMECODESCALE = 0x2AD7B1;
// Segment düzeyindeki öğeler: bilinmeyen boylu Cluster'ı kapatır
const TOP = new Set([CLUSTER, 0x1C53BB6B, 0x1254C367, 0x114D9B74, 0x1941A469, 0x1043A770, INFO, TRACKS]);
const MAX_LEAF = 16 << 20;

/** Opus paket süresi (sn), TOC baytından (RFC 6716 §3.1). */
export function opusDuration(pkt) {
  if (!pkt || !pkt.length) return 0;
  const toc = pkt[0];
  const c = toc >> 3;
  let ms;
  if (c < 12) ms = [10, 20, 40, 60][c & 3];
  else if (c < 16) ms = [10, 20][c & 1];
  else ms = [2.5, 5, 10, 20][c & 3];
  const code = toc & 3;
  const n = code === 0 ? 1 : code < 3 ? 2 : (pkt[1] ?? 0) & 0x3F;
  return (ms * n) / 1000;
}

function vint(buf, pos, keepMarker) {
  if (pos >= buf.length) return null;
  const b = buf[pos];
  if (b === 0) return { len: 0 };
  let len = 1, mask = 0x80;
  while (!(b & mask)) { mask >>= 1; len++; }
  if (pos + len > buf.length) return null;
  let v = keepMarker ? b : b & (mask - 1);
  let ones = (b & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) { v = v * 256 + buf[pos + i]; if (buf[pos + i] !== 0xFF) ones = false; }
  return { len, value: v, unknown: !keepMarker && ones };
}

const uint = (b) => { let v = 0; for (const x of b) v = v * 256 + x; return v; };
function float(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return b.length === 4 ? dv.getFloat32(0) : b.length === 8 ? dv.getFloat64(0) : 0;
}

// Tam elde olan bir öğenin çocukları: [{ id, body }]
function children(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const id = vint(buf, pos, true); if (!id || !id.len) break;
    const sz = vint(buf, pos + id.len, false); if (!sz || !sz.len) break;
    const s = pos + id.len + sz.len;
    const e = sz.unknown ? buf.length : Math.min(buf.length, s + sz.value);
    out.push({ id: id.value, body: buf.subarray(s, e) });
    pos = e;
  }
  return out;
}

function concat(a, b) {
  if (!a.length) return b;
  const o = new Uint8Array(a.length + b.length);
  o.set(a); o.set(b, a.length);
  return o;
}

export class WebmDemuxer {
  constructor() {
    this.kind = 'webm';
    this.buf = new Uint8Array(0);
    this.base = 0;      // buf[0]'ın akıştaki konumu
    this.stack = [];    // açık kaplar { id, end }
    this.skip = 0;      // atlanacak bayt (ilgisiz öğe gövdesi)
    this.cfg = null;
    this.track = null;
    this.scale = 1e6;   // TimecodeScale (ns)
    this.clusterTc = 0;
    this.encrypted = false;
    this.inits = 0;
  }

  /** SourceBuffer.abort(): yarım öğe atılır, ilklendirme korunur. */
  abort() {
    this.buf = new Uint8Array(0);
    this.skip = 0;
    this.stack = this.stack.filter((s) => s.id === SEGMENT);
  }

  push(chunk, { tso = 0 } = {}) {
    const out = [];
    this.buf = concat(this.buf, chunk);
    const buf = this.buf;
    let pos = 0;
    for (;;) {
      if (this.skip > 0) {
        const k = Math.min(this.skip, buf.length - pos);
        pos += k; this.skip -= k;
        if (this.skip > 0) break;
      }
      const abs = this.base + pos;
      while (this.stack.length && abs >= this.stack[this.stack.length - 1].end) this.stack.pop();
      const id = vint(buf, pos, true);
      if (!id) break;
      const sz = id.len ? vint(buf, pos + id.len, false) : { len: 0 };
      if (!sz) break;
      if (!id.len || !sz.len || id.len > 4) { pos = this._resync(buf, pos + 1); if (pos < 0) { pos = Math.max(0, buf.length - 3); break; } continue; }
      const ID = id.value, hdr = id.len + sz.len;
      const size = sz.unknown ? Infinity : sz.value;
      const top = this.stack[this.stack.length - 1];
      if (top && top.id === CLUSTER && top.end === Infinity && TOP.has(ID)) this.stack.pop();
      if (ID === EBML) {
        if (size > MAX_LEAF) { pos = this._resync(buf, pos + 1); if (pos < 0) { pos = Math.max(0, buf.length - 3); break; } continue; }
        if (pos + hdr + size > buf.length) break;
        this.stack = [];
        this.inits++;
        pos += hdr + size;
        continue;
      }
      if (ID === SEGMENT || ID === CLUSTER) {
        if (ID === SEGMENT) this.stack = [];
        else while (this.stack.length && this.stack[this.stack.length - 1].id === CLUSTER) this.stack.pop();
        this.stack.push({ id: ID, end: size === Infinity ? Infinity : abs + hdr + size });
        if (ID === CLUSTER) this.clusterTc = 0;
        pos += hdr;
        continue;
      }
      if (size === Infinity) { pos += hdr; continue; } // bilinmeyen boylu başka kap: içine gir
      if (ID === INFO || ID === TRACKS || ID === TIMECODE || ID === SIMPLEBLOCK || ID === BLOCKGROUP) {
        if (size > MAX_LEAF) { pos = this._resync(buf, pos + 1); if (pos < 0) { pos = Math.max(0, buf.length - 3); break; } continue; }
        if (pos + hdr + size > buf.length) break;
        const body = buf.subarray(pos + hdr, pos + hdr + size);
        pos += hdr + size;
        if (ID === INFO) this._info(body);
        else if (ID === TRACKS) this._tracks(body);
        else if (ID === TIMECODE) this.clusterTc = uint(body);
        else if (ID === SIMPLEBLOCK) this._block(body, null, tso, out);
        else {
          let blk = null, dur = null;
          for (const c of children(body)) {
            if (c.id === BLOCK) blk = c.body;
            else if (c.id === BLOCKDURATION) dur = uint(c.body);
          }
          if (blk) this._block(blk, dur, tso, out);
        }
        continue;
      }
      pos += hdr;
      this.skip = size;
    }
    this.base += pos;
    this.buf = buf.slice(pos);
    return out;
  }

  _resync(buf, from) {
    for (let i = from; i + 4 <= buf.length; i++) {
      if ((buf[i] === 0x1F && buf[i + 1] === 0x43 && buf[i + 2] === 0xB6 && buf[i + 3] === 0x75) ||
          (buf[i] === 0x1A && buf[i + 1] === 0x45 && buf[i + 2] === 0xDF && buf[i + 3] === 0xA3)) return i;
    }
    return -1;
  }

  _info(body) {
    for (const c of children(body)) if (c.id === TIMECODESCALE) this.scale = uint(c.body) || 1e6;
  }

  _tracks(body) {
    for (const te of children(body)) {
      if (te.id !== TRACKENTRY) continue;
      const f = {};
      for (const c of children(te.body)) {
        if (c.id === TRACKNUMBER) f.num = uint(c.body);
        else if (c.id === TRACKTYPE) f.type = uint(c.body);
        else if (c.id === CODECID) f.codec = new TextDecoder().decode(c.body).replace(/\0+$/, '');
        else if (c.id === CODECPRIVATE) f.priv = c.body.slice();
        else if (c.id === CONTENTENCODINGS) f.enc = true;
        else if (c.id === AUDIO) {
          for (const a of children(c.body)) {
            if (a.id === SAMPLINGFREQ) f.sr = float(a.body);
            else if (a.id === CHANNELS) f.ch = uint(a.body);
          }
        }
      }
      if (f.type !== 2 && !/^A_/.test(f.codec || '')) continue;
      this.track = f.num;
      this.encrypted = !!f.enc;
      const codec = f.codec === 'A_OPUS' ? 'opus' : f.codec === 'A_VORBIS' ? 'vorbis' : /^A_AAC/.test(f.codec || '') ? 'mp4a.40.2' : (f.codec || '?');
      this.cfg = {
        codec,
        sampleRate: Math.round(f.sr || 48000),
        numberOfChannels: f.ch || (codec === 'opus' ? 2 : 2),
        ...(f.priv ? { description: f.priv } : {}),
      };
      return;
    }
  }

  _block(b, durTicks, tso, out) {
    if (!this.cfg) return;
    const tn = vint(b, 0, false);
    if (!tn || !tn.len || tn.value !== this.track) return;
    let p = tn.len;
    if (p + 3 > b.length) return;
    const rel = (b[p] << 24 >> 16) | b[p + 1]; // int16
    const flags = b[p + 2];
    p += 3;
    const lacing = (flags >> 1) & 3;
    let frames;
    if (!lacing) frames = [b.subarray(p)];
    else {
      const n = b[p++] + 1;
      const sizes = [];
      if (lacing === 1) { // Xiph
        for (let i = 0; i < n - 1; i++) { let s = 0, x; do { x = b[p++]; s += x; } while (x === 255 && p < b.length); sizes.push(s); }
      } else if (lacing === 3) { // EBML
        const f = vint(b, p, false); if (!f || !f.len) return;
        p += f.len; sizes.push(f.value);
        for (let i = 1; i < n - 1; i++) {
          const d = vint(b, p, false); if (!d || !d.len) return;
          p += d.len;
          const bias = 2 ** (7 * d.len - 1) - 1;
          sizes.push(sizes[i - 1] + (d.value - bias));
        }
      } else { // sabit boy
        const each = Math.floor((b.length - p) / n);
        for (let i = 0; i < n - 1; i++) sizes.push(each);
      }
      sizes.push(b.length - p - sizes.reduce((x, y) => x + y, 0));
      frames = [];
      for (const s of sizes) { if (s < 0 || p + s > b.length) return; frames.push(b.subarray(p, p + s)); p += s; }
    }
    let t = ((this.clusterTc + rel) * this.scale) / 1e9 + tso;
    const blockDur = durTicks != null ? (durTicks * this.scale) / 1e9 / frames.length : 0;
    for (const f of frames) {
      const dur = this.cfg.codec === 'opus' ? opusDuration(f) : blockDur || (this.cfg.codec.startsWith('mp4a') ? 1024 / this.cfg.sampleRate : 0.02);
      out.push({ t, dur, data: f.slice(), cfg: this.cfg });
      t += dur;
    }
  }
}

// ---- parçalı MP4 ----

const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function boxes(b, from = 0, to = b.length) {
  const out = [];
  let p = from;
  while (p + 8 <= to) {
    const dv = new DataView(b.buffer, b.byteOffset + p);
    let size = dv.getUint32(0), hdr = 8;
    const type = fourcc(b, p + 4);
    if (size === 1) { size = Number(dv.getBigUint64(8)); hdr = 16; } else if (size === 0) size = to - p;
    if (size < hdr || p + size > to) break;
    out.push({ type, start: p, body: b.subarray(p + hdr, p + size) });
    p += size;
  }
  return out;
}
const child = (b, type) => boxes(b).find((x) => x.type === type)?.body || null;
const dvOf = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

function descLen(b, p) {
  let len = 0, i = 0, x;
  do { x = b[p + i]; len = (len << 7) | (x & 0x7F); i++; } while (x & 0x80 && i < 4);
  return { len, n: i };
}

// esds → AudioSpecificConfig (DecSpecificInfo, etiket 5)
function esdsConfig(esds) {
  let p = 4;
  if (esds[p] !== 3) return null;
  let d = descLen(esds, p + 1); p += 1 + d.n;
  const fl = esds[p + 2]; p += 3;
  if (fl & 0x80) p += 2;
  if (fl & 0x40) p += 1 + esds[p];
  if (fl & 0x20) p += 2;
  if (esds[p] !== 4) return null;
  d = descLen(esds, p + 1); p += 1 + d.n + 13;
  if (esds[p] !== 5) return null;
  d = descLen(esds, p + 1); p += 1 + d.n;
  return esds.slice(p, p + d.len);
}

export class Mp4Demuxer {
  constructor(mime = '') {
    this.kind = 'mp4';
    this.mimeCodec = (/codecs\s*=\s*"?([^",;]+)/i.exec(mime) || [])[1] || null;
    this.buf = new Uint8Array(0);
    this.base = 0;
    this.cfg = null;
    this.trackId = null;
    this.timescale = 1;
    this.trex = {};
    this.pending = []; // moof'tan beklenen örnekler { off, size, t, dur }
    this.encrypted = false;
    this.inits = 0;
  }

  abort() { this.buf = new Uint8Array(0); this.pending = []; }

  push(chunk, { tso = 0 } = {}) {
    const out = [];
    this.buf = concat(this.buf, chunk);
    const b = this.buf;
    let p = 0;
    while (p + 8 <= b.length) {
      const dv = new DataView(b.buffer, b.byteOffset + p);
      let size = dv.getUint32(0), hdr = 8;
      const type = fourcc(b, p + 4);
      if (size === 1) { if (p + 16 > b.length) break; size = Number(dv.getBigUint64(8)); hdr = 16; }
      if (size === 0 || size < hdr || !/^[\x20-\x7e]{4}$/.test(type)) { this.abort(); return out; } // bozuk: sonraki eklemeden yeniden
      if (p + size > b.length) break;
      const abs = this.base + p;
      const body = b.subarray(p + hdr, p + size);
      if (type === 'ftyp') { this.pending = []; }
      else if (type === 'moov') { this._moov(body); this.inits++; }
      else if (type === 'moof') this._moof(body, abs, tso);
      else if (type === 'mdat') this._mdat(body, abs + hdr, out);
      p += size;
    }
    this.base += p;
    this.buf = b.slice(p);
    return out;
  }

  _moov(moov) {
    for (const trak of boxes(moov).filter((x) => x.type === 'trak')) {
      const mdia = child(trak.body, 'mdia');
      const hdlr = mdia && child(mdia, 'hdlr');
      if (!hdlr || fourcc(hdlr, 8) !== 'soun') continue;
      const tkhd = child(trak.body, 'tkhd');
      if (tkhd) this.trackId = dvOf(tkhd).getUint32(tkhd[0] === 1 ? 20 : 12);
      const mdhd = child(mdia, 'mdhd');
      if (mdhd) this.timescale = dvOf(mdhd).getUint32(mdhd[0] === 1 ? 20 : 12) || 1;
      const stsd = child(child(child(mdia, 'minf') || new Uint8Array(0), 'stbl') || new Uint8Array(0), 'stsd');
      if (!stsd) continue;
      const entry = boxes(stsd, 8)[0];
      if (!entry) continue;
      this.encrypted = entry.type === 'enca';
      const e = entry.body;
      const ch = dvOf(e).getUint16(16), sr = dvOf(e).getUint32(24) >>> 16;
      const esds = boxes(e, 28).find((x) => x.type === 'esds');
      const asc = esds ? esdsConfig(esds.body) : null;
      let codec = this.mimeCodec && /^mp4a\./.test(this.mimeCodec) ? this.mimeCodec : null;
      if (!codec && asc && asc.length) codec = `mp4a.40.${asc[0] >> 3}`;
      if (entry.type !== 'mp4a' && entry.type !== 'enca') codec = entry.type;
      this.cfg = { codec: codec || 'mp4a.40.2', sampleRate: sr || 44100, numberOfChannels: ch || 2, ...(asc ? { description: asc } : {}) };
      const mvex = child(moov, 'mvex');
      for (const tx of mvex ? boxes(mvex).filter((x) => x.type === 'trex') : []) {
        const d = dvOf(tx.body);
        if (d.getUint32(4) === this.trackId) this.trex = { dur: d.getUint32(12), size: d.getUint32(16) };
      }
      return;
    }
  }

  _moof(moof, moofStart, tso) {
    this.pending = [];
    if (!this.cfg) return;
    for (const traf of boxes(moof).filter((x) => x.type === 'traf')) {
      const tfhd = child(traf.body, 'tfhd');
      if (!tfhd) continue;
      const d = dvOf(tfhd);
      const fl = d.getUint32(0) & 0xFFFFFF;
      if (this.trackId != null && d.getUint32(4) !== this.trackId) continue;
      let o = 8, base = moofStart, defDur = this.trex.dur || 0, defSize = this.trex.size || 0;
      if (fl & 1) { base = Number(d.getBigUint64(o)); o += 8; }
      if (fl & 2) o += 4;
      if (fl & 8) { defDur = d.getUint32(o); o += 4; }
      if (fl & 0x10) { defSize = d.getUint32(o); o += 4; }
      const tfdt = child(traf.body, 'tfdt');
      let dt = 0;
      if (tfdt) dt = tfdt[0] === 1 ? Number(dvOf(tfdt).getBigUint64(4)) : dvOf(tfdt).getUint32(4);
      let off = base;
      for (const tr of boxes(traf.body).filter((x) => x.type === 'trun')) {
        const r = dvOf(tr.body);
        const tf = r.getUint32(0) & 0xFFFFFF;
        const n = r.getUint32(4);
        let q = 8;
        if (tf & 1) { off = base + r.getInt32(q); q += 4; }
        if (tf & 4) q += 4;
        for (let i = 0; i < n; i++) {
          let dur = defDur, size = defSize;
          if (tf & 0x100) { dur = r.getUint32(q); q += 4; }
          if (tf & 0x200) { size = r.getUint32(q); q += 4; }
          if (tf & 0x400) q += 4;
          if (tf & 0x800) q += 4;
          this.pending.push({ off, size, t: dt / this.timescale + tso, dur: dur / this.timescale });
          off += size; dt += dur;
        }
      }
    }
  }

  _mdat(body, start, out) {
    const end = start + body.length;
    for (const s of this.pending) {
      if (s.off < start || s.off + s.size > end || !s.size) continue;
      out.push({ t: s.t, dur: s.dur, data: body.slice(s.off - start, s.off - start + s.size), cfg: this.cfg });
    }
    this.pending = [];
  }
}

/** MIME'e göre ayrıştırıcı; desteklenmiyorsa null. */
export function createDemuxer(mime) {
  const m = String(mime || '').toLowerCase();
  if (/^audio\/webm/.test(m)) return new WebmDemuxer();
  if (/^audio\/mp4/.test(m)) return new Mp4Demuxer(mime);
  return null;
}
