// Sahte ses ayırma işçisi (test için): engines/sep/worker.js ile aynı ileti sözleşmesi, model yok.
// Çıktı = giriş × 0.5 (testler işlenmiş sesi böyle tanır). Worker olarak açılır:
//   new Worker(new URL('../_mock/sep.js', import.meta.url), { type: 'module' })
// Node testleri için handleMessage(msg, post) de dışa aktarılır.
// Yavaşlatma (e2e): process'e mockRtf (gerçek zaman oranı) eklenirse işlem süre × mockRtf kadar sürer;
// { type: 'mock-rtf', rtf } süren işin hızını da değiştirir. Yavaşlatma yokken yanıt hemen (eşzamanlı) gelir.

export const MOCK_GAIN = 0.5;
const CONTEXT_SEC = 1;
const CHUNK_SEC = 5.92;

let loaded = null; // { model, backend }
let rtf = 0;
const queue = [];
let busy = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function handleMessage(msg, post) {
  const { id } = msg || {};
  try {
    if (msg.type === 'load') {
      post({ type: 'progress', id, loaded: 1, total: 1 });
      loaded = { model: msg.model || 'mock', backend: 'mock' };
      post({ type: 'loaded', id, backend: loaded.backend, model: loaded.model, contextSec: CONTEXT_SEC, chunkSec: CHUNK_SEC });
    } else if (msg.type === 'process') {
      if (!loaded) throw new Error('Ayırma modeli yüklenmedi (önce load)');
      if (msg.mockRtf != null) rtf = Number(msg.mockRtf) || 0;
      if (rtf > 0 || busy) { queue.push([msg, post]); pump(); } else result(msg, post, 0);
    } else if (msg.type === 'mock-rtf') {
      rtf = Number(msg.rtf) || 0;
    } else if (msg.type === 'dispose') {
      loaded = null;
      queue.length = 0;
      post({ type: 'disposed', id });
    } else throw new Error(`Bilinmeyen ileti: ${msg.type}`);
  } catch (e) {
    post({ type: 'error', id, message: e?.message || String(e) });
  }
}

function result(msg, post, ms) {
  const left = scale(msg.left);
  const right = scale(msg.right && msg.right.length ? msg.right : msg.left);
  post({ type: 'result', id: msg.id, left, right, ms, backend: loaded?.backend || 'mock' }, [left.buffer, right.buffer]);
}

// sıralı iş: ilerleme anlık hıza göre birikir (test süren işi hızlandırabilsin)
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const [msg, post] = queue.shift();
    const t0 = performance.now();
    const sec = msg.left.length / (msg.sampleRate || 48000);
    for (let done = 0; rtf > 0 && done < sec;) {
      await sleep(20);
      done += 0.02 / rtf;
    }
    if (!loaded) continue;
    result(msg, post, performance.now() - t0);
  }
  busy = false;
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
