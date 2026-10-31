// Ayırma işçisinin (worker.js ya da _mock/sep.js) Promise tabanlı istemcisi. İsteğe bağlı yardımcı: işçi
// sözleşmesi doğrudan da kullanılabilir. TTS'teki gibi çok iş parçacıklı WASM yüklemesi 90 sn'de bitmezse işçi
// tek iş parçacığıyla yeniden başlatılır (ort 1.22'nin bazı Chromium sürümlerindeki askısı).
//
//   const sep = createSepClient();
//   await sep.load({ model: 'kim-vocal-2', backend: 'auto', onProgress });
//   const { left, right, ms, backend } = await sep.process(L, R, 48000);   // L, R transfer edilir

const THREADED_LOAD_TIMEOUT_MS = 90000;

export function createSepClient({ mock = false, workerUrl } = {}) {
  const url = workerUrl || new URL(mock ? '../_mock/sep.js' : './worker.js', import.meta.url);
  let worker = null;
  let seq = 0;
  const pending = new Map(); // id → { resolve, reject, onProgress }

  function spawn() {
    worker = new Worker(url, { type: 'module', name: 'sep' });
    worker.onmessage = (ev) => {
      const m = ev.data || {};
      const p = pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') { p.onProgress?.({ loaded: m.loaded, total: m.total }); return; }
      pending.delete(m.id);
      if (m.type === 'error') p.reject(new Error(m.message));
      else p.resolve(m);
    };
    worker.onerror = (e) => stop(new Error(`Ayırma işçisi hatası: ${e?.message || e}`));
  }

  function stop(err) {
    worker?.terminate();
    worker = null;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  }

  function send(msg, transfer = [], onProgress) {
    if (!worker) spawn();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ ...msg, id }, transfer);
    });
  }

  async function load({ model, backend = 'auto', onProgress, threads, overlap, batch } = {}) {
    const msg = { type: 'load', model, backend, threads, overlap, batch };
    const multi = !mock && globalThis.crossOriginIsolated && (threads === undefined || threads > 1) && backend !== 'webgpu';
    if (!multi) return send(msg, [], onProgress);
    // bekçi indirme bittikten sonra kurulur (model işçinin içinde indirilir; yavaş ağ askı sayılmamalı)
    let timer, fire;
    const timeout = new Promise((_, rej) => { fire = () => rej(new Error('timeout')); });
    const arm = (p) => {
      onProgress?.(p);
      if (!timer && p.total > 0 && p.loaded >= p.total) timer = setTimeout(fire, THREADED_LOAD_TIMEOUT_MS);
    };
    try {
      return await Promise.race([send(msg, [], arm), timeout]);
    } catch (e) {
      if (e?.message !== 'timeout') throw e;
      console.warn('[sep] çok iş parçacıklı yükleme bitmedi, tek iş parçacığıyla yeniden deneniyor');
      stop(new Error('Ayırma işçisi yeniden başlatıldı'));
      return send({ ...msg, threads: 1 }, [], onProgress);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    load,
    process(left, right, sampleRate) {
      const transfer = [left.buffer];
      if (right && right.buffer !== left.buffer) transfer.push(right.buffer);
      return send({ type: 'process', left, right, sampleRate }, transfer);
    },
    async dispose() {
      if (!worker) return;
      await send({ type: 'dispose' }).catch(() => {});
      stop(new Error('Ayırma işçisi kapatıldı'));
    },
  };
}
