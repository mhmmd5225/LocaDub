// Ortak model önbelleği (Cache Storage). Sözleşme: docs/CONTRACT.md
// fetchModel(url, { onProgress, cacheName, signal }) → Promise<ArrayBuffer>
// isCached(url, cacheName?) → Promise<boolean>
// clearModels(cacheName?) → Promise<number>  (silinen önbellek sayısı)

export const DEFAULT_CACHE = 'yt-tr-dub-models-v1';
const CACHE_PREFIX = 'yt-tr-dub-models';
const PROGRESS_INTERVAL_MS = 150;

// Aynı URL'nin eşzamanlı indirmelerini birleştirir.
const inflight = new Map(); // key → { promise, listeners:Set }

function getCaches() {
  if (typeof caches === 'undefined') throw new Error('Cache Storage bu bağlamda kullanılamıyor');
  return caches;
}

function keyOf(cacheName, url) {
  return cacheName + '\n' + url;
}

export async function fetchModel(url, { onProgress, cacheName = DEFAULT_CACHE, signal } = {}) {
  url = String(url);
  const cache = await getCaches().open(cacheName);
  const hit = await cache.match(url);
  if (hit) {
    const buf = await hit.arrayBuffer();
    onProgress?.({ url, loaded: buf.byteLength, total: buf.byteLength, cached: true });
    return buf;
  }

  const key = keyOf(cacheName, url);
  let entry = inflight.get(key);
  if (!entry) {
    const listeners = new Set();
    const emit = (p) => { for (const fn of listeners) { try { fn(p); } catch { /* yoksay */ } } };
    entry = { listeners, promise: null };
    entry.promise = download(url, cache, emit, signal).finally(() => inflight.delete(key));
    inflight.set(key, entry);
  }
  if (onProgress) entry.listeners.add(onProgress);
  try {
    // İlk çağırana orijinal, diğerlerine kopya (tüketici buffer'ı transfer edebilir).
    const buf = await entry.promise;
    if (!entry.handed) { entry.handed = true; return buf; }
    return buf.slice(0);
  } finally {
    if (onProgress) entry.listeners.delete(onProgress);
  }
}

async function download(url, cache, emit, signal) {
  let res;
  try {
    res = await fetch(url, { mode: 'cors', credentials: 'omit', redirect: 'follow', cache: 'no-store', signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new Error(`Model indirilemedi (ağ hatası): ${url} — ${e?.message || e}`);
  }
  if (!res.ok) throw new Error(`Model indirilemedi (HTTP ${res.status}): ${url}`);

  const encoded = !!res.headers.get('content-encoding');
  let total = encoded ? 0 : Number(res.headers.get('content-length')) || 0;
  const contentType = res.headers.get('content-type') || 'application/octet-stream';

  let data;
  let loaded = 0;
  let last = 0;
  emit({ url, loaded: 0, total });

  if (!res.body || typeof res.body.getReader !== 'function') {
    data = new Uint8Array(await res.arrayBuffer());
    loaded = data.byteLength;
  } else {
    const reader = res.body.getReader();
    // Boyut biliniyorsa tek seferde ayır (büyük dosyalarda bellek zirvesini düşürür).
    let buf = total > 0 ? new Uint8Array(total) : null;
    const chunks = buf ? null : [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (buf) {
        if (loaded + value.byteLength > buf.byteLength) {
          const bigger = new Uint8Array(Math.max(buf.byteLength * 2, loaded + value.byteLength));
          bigger.set(buf.subarray(0, loaded));
          buf = bigger;
        }
        buf.set(value, loaded);
      } else {
        chunks.push(value);
      }
      loaded += value.byteLength;
      const now = Date.now();
      if (now - last >= PROGRESS_INTERVAL_MS) {
        last = now;
        emit({ url, loaded, total: Math.max(total, loaded) });
      }
    }
    if (buf) {
      data = loaded === buf.byteLength ? buf : buf.slice(0, loaded);
    } else {
      data = new Uint8Array(loaded);
      let off = 0;
      for (const c of chunks) { data.set(c, off); off += c.byteLength; }
    }
  }
  if (total && loaded < total) throw new Error(`Model eksik indirildi (${loaded}/${total} bayt): ${url}`);
  total = loaded;

  try {
    await cache.put(url, new Response(data, {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': String(loaded),
        'x-yt-tr-dub-cached-at': new Date().toISOString(),
      },
    }));
  } catch (e) {
    // Kota vb.: modeli yine de döndür, sadece kalıcı olmaz.
    console.warn('[yt-tr-dub] Model önbelleğe yazılamadı:', url, e);
  }
  emit({ url, loaded, total, done: true });
  return data.buffer.byteLength === data.byteLength ? data.buffer : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

export async function isCached(url, cacheName = DEFAULT_CACHE) {
  const cache = await getCaches().open(cacheName);
  return !!(await cache.match(String(url)));
}

// cacheName verilmezse eklentinin tüm model önbelleklerini siler.
export async function clearModels(cacheName) {
  const c = getCaches();
  if (cacheName) return (await c.delete(cacheName)) ? 1 : 0;
  let n = 0;
  for (const name of await c.keys()) {
    if (name.startsWith(CACHE_PREFIX) && (await c.delete(name))) n++;
  }
  return n;
}

// Ek: URL'si verilen önekle başlayan tüm önbellek girdilerini siler (tek bir modeli silmek için).
export async function deleteByPrefix(prefix, cacheName = DEFAULT_CACHE) {
  const cache = await getCaches().open(cacheName);
  let n = 0;
  for (const req of await cache.keys()) {
    if (req.url.startsWith(prefix) && (await cache.delete(req))) n++;
  }
  return n;
}

// Ek: önbellekteki dosyalar ve toplam boyut (popup için).
export async function listCached(cacheName = DEFAULT_CACHE) {
  const cache = await getCaches().open(cacheName);
  const out = [];
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    const size = Number(res?.headers.get('content-length')) || 0;
    out.push({ url: req.url, size });
  }
  return out;
}
