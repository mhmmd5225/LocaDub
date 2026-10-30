// Sahte ses ayırma işçisi (test için): engines/sep/worker.js ile aynı ileti sözleşmesi, model yok, anında.
// Çıktı = giriş × 0.5 (testler işlenmiş sesi böyle tanır). Worker olarak açılır:
//   new Worker(new URL('../_mock/sep.js', import.meta.url), { type: 'module' })
// Node testleri için handleMessage(msg, post) de dışa aktarılır.

export const MOCK_GAIN = 0.5;
const CONTEXT_SEC = 1;
const CHUNK_SEC = 5.92;

let loaded = null; // { model, backend }

export function handleMessage(msg, post) {
  const { id } = msg || {};
  try {
    if (msg.type === 'load') {
      post({ type: 'progress', id, loaded: 1, total: 1 });
      loaded = { model: msg.model || 'mock', backend: 'mock' };
      post({ type: 'loaded', id, backend: loaded.backend, model: loaded.model, contextSec: CONTEXT_SEC, chunkSec: CHUNK_SEC });
    } else if (msg.type === 'process') {
      if (!loaded) throw new Error('Ayırma modeli yüklenmedi (önce load)');
      const left = scale(msg.left);
      const right = scale(msg.right && msg.right.length ? msg.right : msg.left);
      post({ type: 'result', id, left, right, ms: 0, backend: loaded.backend }, [left.buffer, right.buffer]);
    } else if (msg.type === 'dispose') {
      loaded = null;
      post({ type: 'disposed', id });
    } else throw new Error(`Bilinmeyen ileti: ${msg.type}`);
  } catch (e) {
    post({ type: 'error', id, message: e?.message || String(e) });
  }
}

function scale(x) {
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] * MOCK_GAIN;
  return y;
}

// Worker bağlamında kendini bağla
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = (ev) => handleMessage(ev.data || {}, (m, t) => self.postMessage(m, t || []));
}
