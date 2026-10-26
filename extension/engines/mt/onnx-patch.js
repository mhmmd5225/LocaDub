// Minimal ONNX (protobuf) reader + "hole filling" for sliced model downloads.
//
// The onnx-community Marian decoders store the shared 57060x1024 embedding twice: once as a
// uint8 (Gather) copy and once as a float32 tensor (234 MB) used by the output projection.
// We download the file *without* the float32 bytes (two HTTP Range requests) and rebuild them
// here by dequantizing the uint8 copy ((q - zero_point) * scale). The rebuilt buffer has
// exactly the original layout, so onnxruntime loads it as the original file.
//
// Pure JS, no DOM: used by the MT worker in the browser and by tests/mt in Node.

/** Reads a protobuf varint. Lengths/offsets in our files are < 2^53, so Number is enough. */
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

/** Iterates the fields of a protobuf message in b[start, end). cb(field, wire, value, a, b). */
function fields(b, start, end, cb) {
  let p = start;
  while (p < end) {
    let key;
    [key, p] = varint(b, p);
    const f = Math.floor(key / 8);
    const w = key & 7;
    if (w === 0) {
      let v;
      [v, p] = varint(b, p);
      if (cb(f, w, v, p, p) === false) return;
    } else if (w === 2) {
      let len;
      [len, p] = varint(b, p);
      if (cb(f, w, null, p, p + len) === false) return;
      p += len;
    } else if (w === 5) {
      if (cb(f, w, null, p, p + 4) === false) return;
      p += 4;
    } else if (w === 1) {
      if (cb(f, w, null, p, p + 8) === false) return;
      p += 8;
    } else {
      throw new Error(`onnx-patch: unsupported protobuf wire type ${w} at ${p}`);
    }
  }
}

const utf8 = new TextDecoder();

/**
 * Finds top-level graph initializers by name.
 * @param {Uint8Array} bytes  a whole .onnx file (holes may be unfilled: raw_data is never read here)
 * @param {Iterable<string>} wanted
 * @returns {Map<string, {dataType:number, dims:number[], raw:[number,number]|null, floats:number[], ints:number[]}>}
 */
export function findInitializers(bytes, wanted) {
  const names = new Set(wanted);
  const found = new Map();
  fields(bytes, 0, bytes.length, (f, w, _v, a, b) => {
    if (f !== 7 || w !== 2) return; // ModelProto.graph
    fields(bytes, a, b, (gf, gw, _gv, ga, gb) => {
      if (gf !== 5 || gw !== 2) return; // GraphProto.initializer (TensorProto)
      const t = { name: '', dataType: 0, dims: [], raw: null, floats: [], ints: [] };
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      fields(bytes, ga, gb, (tf, tw, tv, ta, tb) => {
        if (tf === 1) { // dims (packed or not)
          if (tw === 0) t.dims.push(tv);
          else for (let p = ta; p < tb;) { let d; [d, p] = varint(bytes, p); t.dims.push(d); }
        } else if (tf === 2) t.dataType = tv;
        else if (tf === 8) t.name = utf8.decode(bytes.subarray(ta, tb));
        else if (tf === 9) t.raw = [ta, tb];
        else if (tf === 4) { // float_data
          if (tw === 5) t.floats.push(dv.getFloat32(ta, true));
          else for (let p = ta; p < tb; p += 4) t.floats.push(dv.getFloat32(p, true));
        } else if (tf === 5) { // int32_data (also holds uint8 zero points)
          if (tw === 0) t.ints.push(tv);
          else for (let p = ta; p < tb;) { let d; [d, p] = varint(bytes, p); t.ints.push(d); }
        }
      });
      if (names.has(t.name)) found.set(t.name, t);
      if (found.size === names.size) return false;
    });
    return false;
  });
  return found;
}

function scalarFloat(bytes, t) {
  if (t.floats.length) return t.floats[0];
  if (t.raw) return new DataView(bytes.buffer, bytes.byteOffset + t.raw[0], 4).getFloat32(0, true);
  throw new Error(`onnx-patch: no value for ${t.name}`);
}

function scalarInt(bytes, t) {
  if (t.ints.length) return t.ints[0];
  if (t.raw) return t.dataType === 3 ? (bytes[t.raw[0]] << 24) >> 24 : bytes[t.raw[0]];
  return 0; // protobuf default
}

/**
 * Rebuilds a float32 initializer of `target` from a dynamically-quantized copy in `source`
 * (`<src>_quantized`, `<src>_scale`, `<src>_zero_point`, as onnxruntime quantize_dynamic names them).
 *
 * @param {Uint8Array} target  file whose `tensor` raw bytes are a hole to fill (modified in place)
 * @param {string} tensor      float32 initializer name in target
 * @param {Uint8Array} source  file holding the quantized copy (may be `target` itself)
 * @param {string} src         base name of the quantized copy in source
 * @param {[number,number]} [expectedRange] the hole that was skipped while downloading; verified
 */
export function fillDequantized(target, tensor, source, src, expectedRange) {
  const t = findInitializers(target, [tensor]).get(tensor);
  if (!t || !t.raw) throw new Error(`onnx-patch: ${tensor} not found in target`);
  if (t.dataType !== 1) throw new Error(`onnx-patch: ${tensor} is not float32`);
  if (expectedRange && (t.raw[0] !== expectedRange[0] || t.raw[1] !== expectedRange[1])) {
    throw new Error(`onnx-patch: ${tensor} at ${t.raw} but the skipped range was ${expectedRange}`);
  }
  const q = findInitializers(source, [`${src}_quantized`, `${src}_scale`, `${src}_zero_point`]);
  const qt = q.get(`${src}_quantized`);
  const st = q.get(`${src}_scale`);
  const zt = q.get(`${src}_zero_point`);
  if (!qt || !qt.raw || !st) throw new Error(`onnx-patch: quantized copy ${src} not found`);
  const count = t.dims.reduce((x, y) => x * y, 1);
  if (qt.dims.join('x') !== t.dims.join('x') || qt.raw[1] - qt.raw[0] !== count) {
    throw new Error(`onnx-patch: shape mismatch ${qt.dims} vs ${t.dims}`);
  }
  if (t.raw[1] - t.raw[0] !== count * 4) throw new Error('onnx-patch: unexpected raw size');
  const scale = scalarFloat(source, st);
  const zp = zt ? scalarInt(source, zt) : 0;
  const signed = qt.dataType === 3; // int8 vs uint8
  const lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) lut[v] = ((signed ? (v << 24) >> 24 : v) - zp) * scale;

  // Chunked so that we never need a second 234 MB buffer; the destination may be unaligned.
  const CH = 1 << 20;
  const tmp = new Float32Array(CH);
  const tmpBytes = new Uint8Array(tmp.buffer);
  const qd = source.subarray(qt.raw[0], qt.raw[1]);
  for (let i = 0; i < count; i += CH) {
    const n = Math.min(CH, count - i);
    for (let j = 0; j < n; j++) tmp[j] = lut[qd[i + j]];
    target.set(n === CH ? tmpBytes : tmpBytes.subarray(0, n * 4), t.raw[0] + i * 4);
  }
  return { count, scale, zeroPoint: zp };
}

/**
 * Assembles a file from downloaded parts into a buffer of the original size; the gaps stay zero.
 * @param {number} size
 * @param {{start:number, data:ArrayBuffer|Uint8Array}[]} parts
 */
export function assemble(size, parts) {
  const out = new Uint8Array(size);
  for (const p of parts) out.set(p.data instanceof Uint8Array ? p.data : new Uint8Array(p.data), p.start);
  return out;
}

/** [start, end) ranges of `size` bytes that are not covered by `holes`. */
export function keptRanges(size, holes = []) {
  const out = [];
  let p = 0;
  for (const [a, b] of [...holes].sort((x, y) => x[0] - y[0])) {
    if (a > p) out.push([p, a]);
    p = Math.max(p, b);
  }
  if (p < size) out.push([p, size]);
  return out;
}
