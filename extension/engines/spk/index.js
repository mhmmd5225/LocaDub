// Konuşmacı gömme motoru (offscreen belgesinde): cümlenin sesi → konuşmacı vektörü + cinsiyet kanıtı. Çıkarım
// modül işçisinde (./worker.js); model ortak önbellekten bir kez indirilir (models.js, sabit commit).
//
//   info() -> { id, label, sizeMB, license, cached, cachePrefix }
//   init({ onProgress })
//   embed(pcm16k: Float32Array, { signal }) -> { vector: Float32Array|null, voicedSec, score: number|null, f0: number[] }
//   dispose()

import { fetchModel, isCached } from '../common/model-cache.js';
import { logError } from '../../common/errlog.js';
import { spkModelById, DEFAULT_SPK_MODEL } from './models.js';

export const id = 'spk';

const model = spkModelById(DEFAULT_SPK_MODEL);
let worker = null;
let seq = 0;
const pending = new Map();
let ready = null;

export async function info() {
  return {
    id: model.id, label: model.label, sizeMB: Math.round(model.bytes / 1e5) / 10, license: model.license,
    cached: await isCached(model.url).catch(() => false), cachePrefix: model.url,
  };
}

function request(msg, transfer = []) {
  const reqId = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject });
    worker.postMessage({ ...msg, reqId }, transfer);
  });
}

function stop(e) {
  for (const p of pending.values()) p.reject(e);
  pending.clear();
  worker?.terminate();
  worker = null;
  ready = null;
}

export function init({ onProgress } = {}) {
  if (ready) return ready;
  ready = (async () => {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'spk' });
    worker.onmessage = (ev) => {
      const m = ev.data || {};
      const p = pending.get(m.reqId);
      if (!p) return;
      pending.delete(m.reqId);
      if (m.type === 'error') p.reject(new Error(m.message));
      else p.resolve(m);
    };
    worker.onerror = (ev) => stop(new Error('Konuşmacı işçisi hatası: ' + (ev.message || 'bilinmiyor')));
    const bytes = await fetchModel(model.url, { onProgress: (p) => onProgress?.({ ...p, total: p.total || model.bytes }) });
    if (bytes.byteLength !== model.bytes) throw new Error(`Konuşmacı modeli bozuk indi (${bytes.byteLength}/${model.bytes} bayt)`);
    let head = null;
    try { head = await (await fetch(new URL(`./gender-${model.id}.json`, import.meta.url))).json(); } catch (e) { logError('konuşmacı sınıflandırıcı', e); /* sınıflandırıcısız: yalnız perde */ }
    await request({ type: 'load', model, bytes, head }, [bytes]);
  })().catch((e) => { stop(e); throw e; });
  return ready;
}

export async function embed(pcm, { signal } = {}) {
  await init();
  if (signal?.aborted) throw new DOMException('İptal edildi', 'AbortError');
  const r = await request({ type: 'embed', pcm }, [pcm.buffer]);
  return { vector: r.vector, voicedSec: r.voicedSec, score: r.score, f0: r.f0, ms: r.ms };
}

export async function dispose() {
  stop(new Error('Konuşmacı motoru kapatıldı'));
}
