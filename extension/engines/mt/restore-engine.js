// Otomatik (ASR) altyazı metnine çeviriden önce noktalama ve büyük harf kazandırır (isteğe bağlı model; punct.js).
// Offscreen belgesinde çalışır; çıkarım punct-worker.js'te. Model yoksa ya da hata olursa metin aynen döner.
// Kıyas: docs/MT-KIYAS.md (otomatik altyazı biçiminde chrF 51.1 → 53.1).

import { fetchModel, isCached } from '../common/model-cache.js';
import { PUNCT_MODEL, punctUrl, punctBytes } from './punct.js';

export const PUNCT_PREFIX = PUNCT_MODEL.repo; // ayarlar sayfası önbellekteki dosyaları bu önekle bulur/siler
export const PUNCT_SIZE_MB = Math.round(punctBytes() / 1e5) / 10;

let worker = null;
let seq = 0;
const pending = new Map();
let readyP = null; // yüklenen model
let failedAt = 0;
const RETRY_MS = 60000;

export async function isPunctDownloaded() {
  try {
    return (await Promise.all(PUNCT_MODEL.files.map((f) => isCached(punctUrl(f.name))))).every(Boolean);
  } catch {
    return false;
  }
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./punct-worker.js', import.meta.url), { type: 'module', name: 'punct' });
  worker.onmessage = (ev) => {
    const m = ev.data || {};
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message));
    else p.resolve(m);
  };
  worker.onerror = (ev) => {
    const e = new Error('Noktalama işçisi hatası: ' + (ev.message || 'bilinmiyor'));
    for (const p of pending.values()) p.reject(e);
    pending.clear();
    worker?.terminate();
    worker = null;
    readyP = null;
  };
  return worker;
}

function request(msg, transfer = []) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id }, transfer);
  });
}

async function load() {
  const [onnx, spm] = await Promise.all(PUNCT_MODEL.files.map((f) => fetchModel(punctUrl(f.name))));
  await request({ type: 'load', onnx, spm }, [onnx, spm]);
}

// Metin zaten büyük harf içeriyorsa (elle yazılmış/noktalanmış) dokunulmaz.
const needsRestore = (t) => /\p{L}/u.test(t) && !/\p{Lu}/u.test(t);

/** Metin listesi → düzeltilmiş liste (aynı uzunluk). Model indirilmemişse ya da hata olursa özgün liste. */
export async function restoreTexts(texts) {
  const idx = texts.map((t, i) => (needsRestore(t) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return texts;
  if (failedAt && Date.now() - failedAt < RETRY_MS) return texts;
  try {
    if (!readyP) {
      if (!(await isPunctDownloaded())) return texts; // indirme yalnızca ayarlar sayfasından, kullanıcı isteğiyle
      readyP = load();
    }
    await readyP;
    const { result } = await request({ type: 'restore', texts: idx.map((i) => texts[i]) });
    const out = texts.slice();
    idx.forEach((i, k) => { if (result[k]?.trim()) out[i] = result[k]; });
    return out;
  } catch (e) {
    console.warn('[locadub] noktalama geri kazanımı kullanılamadı:', e);
    readyP = null;
    failedAt = Date.now();
    return texts;
  }
}

export async function disposePunct() {
  readyP = null;
  failedAt = 0;
  for (const p of pending.values()) p.reject(new Error('İptal edildi'));
  pending.clear();
  worker?.terminate();
  worker = null;
}
