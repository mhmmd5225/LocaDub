// model-cache.js: sahte Cache Storage + sahte fetch ile.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

class FakeCache {
  constructor() { this.map = new Map(); }
  async match(req) {
    const r = this.map.get(typeof req === 'string' ? req : req.url);
    return r ? r.clone() : undefined;
  }
  async put(req, res) {
    const buf = await res.arrayBuffer();
    this.map.set(typeof req === 'string' ? req : req.url, new Response(buf, { headers: res.headers }));
  }
  async keys() { return [...this.map.keys()].map((url) => ({ url })); }
}
class FakeCacheStorage {
  constructor() { this.caches = new Map(); }
  async open(n) { if (!this.caches.has(n)) this.caches.set(n, new FakeCache()); return this.caches.get(n); }
  async delete(n) { return this.caches.delete(n); }
  async keys() { return [...this.caches.keys()]; }
}

let fetchCalls = [];
function streamOf(bytes, chunk = 1000) {
  let off = 0;
  return new ReadableStream({
    async pull(ctrl) {
      if (off >= bytes.length) { ctrl.close(); return; }
      await new Promise((r) => setTimeout(r, 1));
      ctrl.enqueue(bytes.slice(off, off + chunk));
      off += chunk;
    },
  });
}
function installFetch({ size = 10_000, status = 200, lengthHeader = true, truncate = false } = {}) {
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    const bytes = new Uint8Array(size).map((_, i) => i % 251);
    const headers = lengthHeader ? { 'content-length': String(size) } : {};
    if (status !== 200) return new Response('no', { status });
    return new Response(streamOf(truncate ? bytes.slice(0, size / 2) : bytes), { status, headers });
  };
}

const mc = await import('../../extension/engines/common/model-cache.js');

beforeEach(() => {
  globalThis.caches = new FakeCacheStorage();
  fetchCalls = [];
});

test('fetchModel: indirir, ilerleme bildirir, önbelleğe yazar; ikinci çağrı ağsız', async () => {
  installFetch({ size: 25_000 });
  const url = 'https://huggingface.co/x/resolve/main/model.onnx';
  const prog = [];
  const buf = await mc.fetchModel(url, { onProgress: (p) => prog.push(p) });
  assert.ok(buf instanceof ArrayBuffer);
  assert.equal(buf.byteLength, 25_000);
  assert.equal(new Uint8Array(buf)[252], 1);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].init.mode, 'cors');
  assert.equal(fetchCalls[0].init.credentials, 'omit');
  assert.ok(prog.length >= 2);
  assert.deepEqual(prog.at(-1), { url, loaded: 25_000, total: 25_000, done: true });
  assert.equal(await mc.isCached(url), true);

  const prog2 = [];
  const again = await mc.fetchModel(url, { onProgress: (p) => prog2.push(p) });
  assert.equal(again.byteLength, 25_000);
  assert.equal(fetchCalls.length, 1, 'önbellekten geldi');
  assert.equal(prog2[0].cached, true);
});

test('fetchModel: content-length yoksa da çalışır', async () => {
  installFetch({ size: 3_500, lengthHeader: false });
  const buf = await mc.fetchModel('https://hf.co/a.bin');
  assert.equal(buf.byteLength, 3_500);
});

test('fetchModel: eşzamanlı çağrılar tek indirmede birleşir, kopyalar bağımsız', async () => {
  installFetch({ size: 8_000 });
  const url = 'https://hf.co/b.bin';
  const [a, b] = await Promise.all([mc.fetchModel(url), mc.fetchModel(url)]);
  assert.equal(fetchCalls.length, 1);
  assert.notEqual(a, b);
  assert.equal(a.byteLength, 8_000);
  assert.equal(b.byteLength, 8_000);
});

test('fetchModel: HTTP hatası ve eksik indirme önbelleğe yazılmaz', async () => {
  installFetch({ status: 404 });
  await assert.rejects(mc.fetchModel('https://hf.co/missing'), /HTTP 404/);
  assert.equal(await mc.isCached('https://hf.co/missing'), false);
  installFetch({ size: 10_000, truncate: true });
  await assert.rejects(mc.fetchModel('https://hf.co/trunc'), /eksik/);
  assert.equal(await mc.isCached('https://hf.co/trunc'), false);
});

test('clearModels ve listCached', async () => {
  installFetch({ size: 100 });
  await mc.fetchModel('https://hf.co/1');
  await mc.fetchModel('https://hf.co/2', { cacheName: 'yt-tr-dub-models-v2' });
  await caches.open('other-cache');
  const list = await mc.listCached();
  assert.deepEqual(list, [{ url: 'https://hf.co/1', size: 100 }]);
  assert.equal(await mc.clearModels(), 2);
  assert.deepEqual(await caches.keys(), ['other-cache']);
  assert.equal(await mc.isCached('https://hf.co/1'), false);
});
