// Ses ayırma işçisi (module Web Worker). Konuşmayı çıkarır, müzik + efekti döndürür. Sözleşme:
//
//   → { type:'load', id, model?, backend?:'webgpu'|'wasm'|'auto', threads?, overlap?, batch? }
//       model: models.js kimliği ya da 'auto' (varsayılan): WebGPU'da kim-vocal-2, WASM'da mdxnet-lite
//       batch: bir model çalıştırmasındaki pencere (yoksa WebGPU 4, WASM 1; çıktıyı değiştirmez)
//   ← { type:'progress', id, loaded, total }*   (yalnızca indirme sırasında)
//   ← { type:'loaded', id, backend, model, contextSec, chunkSec, stepSec, batch, overlap, streaming:true }
//       chunkSec: model penceresi (5.92 sn), stepSec: akış ızgarasının adımı  |  { type:'error', id, message }
//   → { type:'process', id, left, right?, sampleRate, startSample?, final?, reset? }   (buffer'ları transfer edin)
//       startSample verilirse akış kipi (separator.js başı): yalnızca kesinleşen aralık döner
//   ← { type:'result', id, left, right, ms, backend, windows, startSample?, reset?, final? }  (transfer edilir)
//       windows: çalıştırılan model penceresi (ölçüm)
//     | { type:'error', id, message }   (iptal edilen: message 'cancelled')
//   → { type:'cancel', ids:[...] }      sıradaki ya da süren işleri bırakır (süren iş grup arasında durur)
//   → { type:'dispose', id? }                            ← { type:'disposed', id }
//
// İstekler sırayla çalışır; iki iş art arda gönderilirse ikincisi birincinin hemen ardından başlar (boru hattı).
// WASM iş parçacığı sayısı ilk yüklemede sabitlenir (ort sınırı); asılı kalan çok iş parçacıklı yükleme için
// 90 sn bekçisi client.js'tedir.

import * as ort from '../../lib/ort/ort.webgpu.min.mjs';
import { createSeparator } from './separator.js';

ort.env.wasm.wasmPaths = new URL('../../lib/ort/', import.meta.url).href;
ort.env.logLevel = 'error';

let sep = null;
let sepKey = '';
let configured = false;
let queue = Promise.resolve();
const cancelled = new Set();

/** Çekirdeklerin yarısı (en çok 4), yalnızca crossOriginIsolated iken; aksi halde 1. */
function defaultThreads() {
  const cores = self.navigator?.hardwareConcurrency || 2;
  return self.crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor(cores / 2))) : 1;
}

function configure(threads) {
  if (configured) return;
  configured = true;
  const t = Number(threads) > 0 ? Math.floor(threads) : defaultThreads();
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, t) : 1;
  ort.env.wasm.proxy = false;
}

async function load(msg) {
  configure(msg.threads);
  const model = msg.model || 'auto';
  const want = msg.backend || 'auto';
  const key = [model, want, msg.overlap ?? '', msg.batch ?? ''].join('|');
  if (sep && sepKey === key) return sep;
  if (sep) await sep.dispose();
  sep = null;
  const s = createSeparator({
    model,
    backend: want,
    ort,
    overlap: msg.overlap,
    batch: msg.batch,
    onProgress: ({ loaded, total }) => self.postMessage({ type: 'progress', id: msg.id, loaded, total }),
  });
  await s.load();
  sep = s;
  sepKey = key;
  return s;
}

self.onmessage = (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'cancel') { for (const id of msg.ids || []) cancelled.add(id); return; } // sıraya girmez
  queue = queue.then(async () => {
    const { id } = msg;
    try {
      if (msg.type === 'load') {
        const s = await load(msg);
        self.postMessage({
          type: 'loaded', id, backend: s.backend, model: s.model.id, contextSec: s.contextSec, chunkSec: s.chunkSec,
          stepSec: s.stepSec, batch: s.batch, overlap: s.overlap, streaming: true,
        });
      } else if (msg.type === 'process') {
        if (!sep) throw new Error('Ayırma modeli yüklenmedi (önce load)');
        if (cancelled.has(id)) throw new Error('cancelled');
        const t0 = performance.now(), w0 = sep.stats.windows;
        const stream = msg.startSample != null
          ? { startSample: msg.startSample, final: !!msg.final, reset: !!msg.reset, isCancelled: () => cancelled.has(id) }
          : undefined;
        const r = await sep.process(msg.left, msg.right, msg.sampleRate, stream);
        const ms = Math.round(performance.now() - t0);
        const extra = stream ? { startSample: r.startSample, reset: r.reset, final: r.final } : {};
        extra.windows = sep.stats.windows - w0;
        self.postMessage({ type: 'result', id, left: r.left, right: r.right, ms, backend: r.backend, ...extra }, [r.left.buffer, r.right.buffer]);
      } else if (msg.type === 'dispose') {
        const s = sep;
        sep = null;
        sepKey = '';
        await s?.dispose();
        self.postMessage({ type: 'disposed', id });
      } else throw new Error(`Bilinmeyen ileti: ${msg.type}`);
    } catch (e) {
      self.postMessage({ type: 'error', id, message: e?.message || String(e) });
    } finally {
      cancelled.delete(id);
    }
  });
};
