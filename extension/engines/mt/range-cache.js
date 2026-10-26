// Byte-range downloads kept in Cache Storage (same cache as engines/common/model-cache.js, so
// clearModels() removes them too). Used for the "slim" opus-mt decoder: the file is fetched in parts
// and the skipped float32 embedding is rebuilt locally (see onnx-patch.js).

export const DEFAULT_CACHE = 'yt-tr-dub-models-v1';

/** Cache key for a range: query parameter (Cache Storage ignores #fragments). */
export const rangeKey = (url, start, end) => `${url}${url.includes('?') ? '&' : '?'}ytdub-bytes=${start}-${end - 1}`;

async function openCache(name) {
  try {
    return await caches.open(name);
  } catch {
    return null; // e.g. no Cache Storage in this context: download every time
  }
}

export async function isRangeCached(url, start, end, cacheName = DEFAULT_CACHE) {
  const cache = await openCache(cacheName);
  if (!cache) return false;
  try {
    return !!(await cache.match(rangeKey(url, start, end)));
  } catch {
    return false;
  }
}

async function readBody(res, expected, onChunk) {
  if (!res.body) {
    const b = await res.arrayBuffer();
    onChunk(b.byteLength);
    return new Uint8Array(b);
  }
  const reader = res.body.getReader();
  let out = expected ? new Uint8Array(expected) : null;
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (out && n + value.length <= out.length) out.set(value, n);
    else {
      if (out) { chunks.push(out.subarray(0, n)); out = null; }
      chunks.push(value);
    }
    n += value.length;
    onChunk(n);
  }
  if (out) return n === out.length ? out : out.subarray(0, n);
  const all = new Uint8Array(n);
  let p = 0;
  for (const c of chunks) { all.set(c, p); p += c.length; }
  return all;
}

/**
 * Bytes [start, end) of url, from Cache Storage or the network (HTTP Range).
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchRange(url, start, end, { onProgress, signal, cacheName = DEFAULT_CACHE } = {}) {
  const len = end - start;
  const key = rangeKey(url, start, end);
  const cache = await openCache(cacheName);
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const b = await hit.arrayBuffer();
        if (b.byteLength === len) {
          onProgress?.({ url: key, loaded: len, total: len, cached: true });
          return b;
        }
        await cache.delete(key);
      }
    } catch { /* fall through to the network */ }
  }
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal, credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  let bytes;
  if (res.status === 206) {
    const cr = res.headers.get('content-range');
    const m = cr && /bytes (\d+)-(\d+)/.exec(cr);
    if (m && (Number(m[1]) !== start || Number(m[2]) !== end - 1)) throw new Error(`unexpected Content-Range ${cr}`);
    bytes = await readBody(res, len, (n) => onProgress?.({ url: key, loaded: n, total: len }));
  } else {
    // Server ignored Range: take the slice from the whole file (slow path, still correct).
    const total = Number(res.headers.get('content-length')) || 0;
    const all = await readBody(res, total, (n) => onProgress?.({ url: key, loaded: Math.round((n / (total || n)) * len), total: len }));
    bytes = all.slice(start, end);
  }
  if (bytes.byteLength !== len) throw new Error(`short read for ${url}: ${bytes.byteLength}/${len}`);
  const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
  if (cache) {
    try {
      // Response copies the bytes, so buf can still be transferred to the worker afterwards.
      await cache.put(key, new Response(buf, {
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(len) },
      }));
    } catch { /* quota: keep going without caching */ }
  }
  return buf;
}
