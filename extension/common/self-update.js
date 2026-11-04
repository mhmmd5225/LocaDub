// Kendi kendine güncelleme: eklenti "paketlenmemiş" (klasörden yüklü) olduğu için Chrome onu kendiliğinden güncellemez.
// Kullanıcı eklenti klasörünü bir kez seçer (File System Access, okuma+yazma); sürüm paketi (LocaDub.zip) indirilir,
// doğrulanır, klasöre yazılır ve eklenti yeniden yüklenir. Hiçbir şey yalnız tanınan site adreslerinden indirilir
// (version.js isSiteUrl). Dosya yazımı: değişmeyenler atlanır, manifest.json en sona yazılır.

import { compareVersions, isSiteUrl } from './version.js';

const DB = 'locadub-update';
const KEY = 'extension-dir';

// ---------- seçilen klasör tutamacı (IndexedDB) ----------

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function kv(mode, fn) {
  const db = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export const getDirHandle = () => kv('readonly', (s) => s.get(KEY)).catch(() => null);
export const clearDirHandle = () => kv('readwrite', (s) => s.delete(KEY));

/** Kullanıcı eklenti klasörünü seçer (kullanıcı hareketi gerekir; yalnız eklenti sayfalarında). Doğrulanır ve saklanır. */
export async function pickExtensionDir() {
  const dir = await globalThis.showDirectoryPicker({ id: 'locadub-ext', mode: 'readwrite' });
  const m = await readManifest(dir);
  if (!m || !/LocaDub/i.test(String(m.name))) throw new Error('Bu klasör LocaDub eklenti klasörü değil (manifest.json bulunamadı).');
  await kv('readwrite', (s) => s.put(dir, KEY));
  return dir;
}

export async function permission(dir, request = false) {
  const o = { mode: 'readwrite' };
  if ((await dir.queryPermission(o)) === 'granted') return true;
  return request ? (await dir.requestPermission(o)) === 'granted' : false;
}

async function readManifest(dir) {
  try {
    const f = await (await dir.getFileHandle('manifest.json')).getFile();
    return JSON.parse(await f.text());
  } catch { return null; }
}

// ---------- zip okuma (saf; node testleriyle sınanır) ----------

let crcTable = null;
export function crc32(u8) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function inflateRaw(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** zip (ArrayBuffer/Uint8Array) → [{ name, size, crc, read(): Promise<Uint8Array> }] (dizin girdileri atlanır). */
export function readZip(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let e = u8.length - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Geçersiz zip (bitiş kaydı yok)');
  const count = v.getUint16(e + 10, true);
  let p = v.getUint32(e + 16, true);
  const td = new TextDecoder();
  const out = [];
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('Geçersiz zip (dizin bozuk)');
    const method = v.getUint16(p + 10, true), crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true), size = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true), elen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
    const off = v.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    out.push({
      name, size, crc,
      async read() {
        if (v.getUint32(off, true) !== 0x04034b50) throw new Error('Geçersiz zip (yerel başlık bozuk)');
        const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
        const raw = u8.subarray(start, start + csize);
        const data = method === 0 ? raw : method === 8 ? await inflateRaw(raw) : null;
        if (!data) throw new Error(`Desteklenmeyen sıkıştırma: ${name}`);
        if (data.length !== size || crc32(data) !== crc) throw new Error(`Dosya bozuk: ${name}`);
        return data;
      },
    });
  }
  return out;
}

/** Zip yolu → eklenti klasörüne göreli güvenli yol (LocaDub/ önekini atar); güvensizse null. */
export function targetPath(name) {
  const rel = name.replace(/^LocaDub\//, '');
  if (!rel) return null;
  if (rel.startsWith('/') || rel.includes('\\') || rel.split('/').some((x) => x === '..' || x === '' || x === '.')) return null;
  return rel;
}

// ---------- uygulama ----------

async function fileAt(dir, rel, create) {
  const parts = rel.split('/');
  let d = dir;
  for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x, { create });
  return d.getFileHandle(parts.at(-1), { create });
}

async function sameContent(dir, rel, entry) {
  try {
    const f = await (await fileAt(dir, rel, false)).getFile();
    if (f.size !== entry.size) return false;
    return crc32(new Uint8Array(await f.arrayBuffer())) === entry.crc;
  } catch { return false; }
}

/**
 * Paketi indirir, doğrular ve klasöre yazar. latest: { version, downloadUrl }. Dönen: { written, skipped }.
 * Hata olursa (indirme, sürüm uyuşmazlığı, bozuk dosya) hiçbir şey yazılmadan fırlatır; yazım başladıktan sonraki
 * hatada manifest.json güncellenmemiş kalır (eski sürüm olarak görünür, bir sonraki denemede tamamlanır).
 */
export async function applyUpdate(dir, latest, installedVersion, { fetchFn = fetch, onProgress } = {}) {
  if (!latest || !isSiteUrl(latest.downloadUrl)) throw new Error('Güncelleme adresi geçersiz');
  if (compareVersions(latest.version, installedVersion) <= 0) throw new Error('Kurulu sürüm zaten güncel');
  if (!(await permission(dir))) throw new Error('Klasöre yazma izni yok');
  const cur = await readManifest(dir);
  if (!cur || !/LocaDub/i.test(String(cur.name))) throw new Error('Seçili klasör LocaDub eklenti klasörü değil');

  const res = await fetchFn(latest.downloadUrl, { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error(`İndirme başarısız (HTTP ${res.status})`);
  const entries = readZip(await res.arrayBuffer());
  const files = entries.map((en) => ({ en, rel: targetPath(en.name) }));
  if (files.some((f) => !f.rel)) throw new Error('Pakette geçersiz dosya yolu var');
  const man = files.find((f) => f.rel === 'manifest.json');
  if (!man) throw new Error('Pakette manifest.json yok');
  const nm = JSON.parse(new TextDecoder().decode(await man.en.read()));
  if (nm.version !== latest.version) throw new Error(`Paket sürümü beklenenden farklı (${nm.version})`);

  // önce tüm dosyalar doğrulanır (CRC), sonra yazılır
  const todo = [];
  for (const f of files) {
    if (f.rel === 'manifest.json') continue;
    if (await sameContent(dir, f.rel, f.en)) continue;
    todo.push({ rel: f.rel, data: await f.en.read() });
  }
  const skipped = files.length - 1 - todo.length;
  todo.push({ rel: 'manifest.json', data: await man.en.read() }); // en sona
  let i = 0;
  for (const t of todo) {
    const w = await (await fileAt(dir, t.rel, true)).createWritable();
    await w.write(t.data);
    await w.close();
    onProgress?.(++i, todo.length);
  }
  return { written: todo.length, skipped };
}
