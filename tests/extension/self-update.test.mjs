import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readZip, crc32, targetPath, applyUpdate } from '../../extension/common/self-update.js';

// küçük zip üretici (deflate / depolama)
function makeZip(files) {
  const parts = [], central = [];
  let off = 0;
  for (const [name, text, store] of files) {
    const data = Buffer.from(text), comp = store ? data : zlib.deflateRawSync(data), nm = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(store ? 0 : 8, 8);
    h.writeUInt32LE(crc32(data), 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(store ? 0 : 8, 10);
    c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, nm, comp); central.push(c, nm);
    off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}

// bellekte sahte klasör tutamacı
function fakeDir(init = {}) {
  const files = new Map(Object.entries(init));
  const handle = (prefix) => ({
    queryPermission: async () => 'granted',
    async getFileHandle(n, { create } = {}) {
      const k = prefix + n;
      if (!files.has(k) && !create) throw new Error('yok');
      return {
        async getFile() { const b = Buffer.from(files.get(k)); return { size: b.length, text: async () => b.toString(), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; },
        async createWritable() { let d; return { write: async (x) => { d = Buffer.from(x).toString(); }, close: async () => { files.set(k, d); } }; },
      };
    },
    async getDirectoryHandle(n) { return handle(prefix + n + '/'); },
  });
  return Object.assign(handle(''), { files });
}

const man = (v) => JSON.stringify({ name: 'LocaDub — test', version: v });
const U = 'https://localdub.mhmmd.app/LocaDub.zip';

test('readZip: deflate ve depolama, CRC doğrulanır', async () => {
  const z = readZip(makeZip([['LocaDub/a.txt', 'merhaba '.repeat(50)], ['LocaDub/b.bin', 'xyz', true]]));
  assert.deepEqual(z.map((e) => e.name), ['LocaDub/a.txt', 'LocaDub/b.bin']);
  assert.equal(Buffer.from(await z[0].read()).toString(), 'merhaba '.repeat(50));
  assert.equal(Buffer.from(await z[1].read()).toString(), 'xyz');
});

test('readZip: bozuk veri reddedilir', async () => {
  const b = makeZip([['LocaDub/a.txt', 'abc', true]]);
  b[b.indexOf('abc')] ^= 1;
  await assert.rejects(readZip(b)[0].read(), /bozuk/);
  assert.throws(() => readZip(Buffer.from('nope')), /zip/);
});

test('targetPath: güvenli yollar', () => {
  assert.equal(targetPath('LocaDub/lib/ort/x.wasm'), 'lib/ort/x.wasm');
  for (const bad of ['LocaDub/../x', 'LocaDub//x', 'LocaDub/a\\b', 'LocaDub/']) assert.equal(targetPath(bad), null);
});

test('applyUpdate: yazar, değişmeyeni atlar, manifest en sonda', async () => {
  const dir = fakeDir({ 'manifest.json': man('0.5.6'), 'same.txt': 'aynı', 'old.txt': 'eski' });
  const zip = makeZip([['LocaDub/manifest.json', man('0.5.7')], ['LocaDub/same.txt', 'aynı'], ['LocaDub/old.txt', 'yeni'], ['LocaDub/lib/n.js', 'x']]);
  const order = [];
  const r = await applyUpdate(dir, { version: '0.5.7', downloadUrl: U }, '0.5.6',
    { fetchFn: async () => ({ ok: true, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length) }), onProgress: (i) => order.push(i) });
  assert.deepEqual(r, { written: 3, skipped: 1 });
  assert.equal(dir.files.get('old.txt'), 'yeni');
  assert.equal(dir.files.get('lib/n.js'), 'x');
  assert.equal(JSON.parse(dir.files.get('manifest.json')).version, '0.5.7');
});

test('applyUpdate: sürüm uyuşmazlığı ve yabancı adres reddedilir, hiçbir şey yazılmaz', async () => {
  const dir = fakeDir({ 'manifest.json': man('0.5.6') });
  const zip = makeZip([['LocaDub/manifest.json', man('0.5.9')], ['LocaDub/a.txt', 'a']]);
  const fetchFn = async () => ({ ok: true, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length) });
  await assert.rejects(applyUpdate(dir, { version: '0.5.7', downloadUrl: U }, '0.5.6', { fetchFn }), /farklı/);
  await assert.rejects(applyUpdate(dir, { version: '0.5.7', downloadUrl: 'https://evil.example/x.zip' }, '0.5.6', { fetchFn }), /adres/);
  await assert.rejects(applyUpdate(dir, { version: '0.5.6', downloadUrl: U }, '0.5.6', { fetchFn }), /güncel/);
  assert.equal(dir.files.size, 1);
});
