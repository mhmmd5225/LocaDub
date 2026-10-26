// PCM aktarım yardımcıları. Mesajlar JSON olduğundan Float32 PCM → Int16 LE → base64 olarak taşınır.

const CHUNK = 0x8000;

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function float32ToInt16(pcm) {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let v = pcm[i];
    if (!(v === v)) v = 0; // NaN
    v = v > 1 ? 1 : v < -1 ? -1 : v;
    out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
  }
  return out;
}

// Float32Array → base64 (Int16 little-endian)
export function encodePcmBase64(pcm) {
  const i16 = float32ToInt16(pcm);
  const bytes = new Uint8Array(i16.length * 2);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < i16.length; i++) dv.setInt16(i * 2, i16[i], true);
  return bytesToBase64(bytes);
}

// base64 (Int16 LE) → Int16Array
export function decodePcmBase64ToInt16(b64) {
  const bytes = base64ToBytes(b64);
  const n = bytes.length >> 1;
  const out = new Int16Array(n);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true);
  return out;
}

export function int16ToFloat32(i16) {
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] < 0 ? i16[i] / 0x8000 : i16[i] / 0x7fff;
  return out;
}

// Int16Array (mono) → WAV dosyası baytları
export function int16ToWav(i16, sampleRate) {
  const dataLen = i16.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, dataLen, true);
  for (let i = 0; i < i16.length; i++) dv.setInt16(44 + i * 2, i16[i], true);
  return new Uint8Array(buf);
}

// Başta/sondaki sessizliği kırpar (eşik ~ -50 dB). Kısa dolgu bırakır.
export function trimSilenceInt16(i16, sampleRate, { threshold = 100, padMs = 40 } = {}) {
  let a = 0, b = i16.length - 1;
  while (a <= b && Math.abs(i16[a]) < threshold) a++;
  if (a > b) return i16.subarray(0, 0); // tamamen sessiz
  while (b > a && Math.abs(i16[b]) < threshold) b--;
  const pad = Math.round((padMs / 1000) * sampleRate);
  a = Math.max(0, a - pad);
  b = Math.min(i16.length - 1, b + pad);
  if (b <= a) return i16.subarray(0, 0);
  return i16.subarray(a, b + 1);
}
