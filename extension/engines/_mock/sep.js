// Sahte ses ayırma işçisi (test için): engines/sep/worker.js ile aynı ileti sözleşmesi, model yok.
// Çıktı = giriş × 0.5 (testler işlenmiş sesi böyle tanır). Worker olarak açılır:
//   new Worker(new URL('../_mock/sep.js', import.meta.url), { type: 'module' })
// Node testleri için handleMessage(msg, post) de dışa aktarılır.
// Akış kipi (startSample): gerçek ayırıcının ızgarasını taklit eder — yalnızca kesinleşen aralık döner
// ((⌊(E − pencere)/adım⌋ + 1)·adım, girdi hızında), kesintide akış sıfırlanır, final kalanı verir.
// Yavaşlatma (e2e): process'e mockRtf (gerçek zaman oranı) eklenirse işlem girdi süresi × mockRtf kadar sürer;
// { type: 'mock-rtf', rtf } süren işin hızını da değiştirir. Yavaşlatma yokken yanıt hemen (eşzamanlı) gelir.
// { type: 'cancel', ids } sıradaki işleri 'cancelled' hatasıyla bırakır.

export const MOCK_GAIN = 0.5;
const CONTEXT_SEC = 1;
const CHUNK_SEC = 5.92;
const STEP_SEC = 2.96;

let loaded = null; // { model, backend }
let rtf = 0;
const queue = [];
let busy = false;
let stream = null; // { sr, inPos, outPos, buf (Float32 L/R, outPos'tan) }
const cancelled = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function handleMessage(msg, post) {
  const { id } = msg || {};
  try {
    if (msg.type === 'load') {
      post({ type: 'progress', id, loaded: 1, total: 1 });
      loaded = { model: msg.model || 'mock', backend: 'mock' };
      post({
        type: 'loaded', id, backend: loaded.backend, model: loaded.model, contextSec: CONTEXT_SEC, chunkSec: CHUNK_SEC,
        stepSec: STEP_SEC, batch: 1, overlap: 0.5, streaming: true,
      });
    } else if (msg.type === 'process') {
      if (!loaded) throw new Error('Ayırma modeli yüklenmedi (önce load)');
      if (msg.mockRtf != null) rtf = Number(msg.mockRtf) || 0;
      if (rtf > 0 || busy) { queue.push([msg, post]); pump(); } else result(msg, post, 0);
    } else if (msg.type === 'mock-rtf') {
      rtf = Number(msg.rtf) || 0;
    } else if (msg.type === 'cancel') {
      for (const x of msg.ids || []) cancelled.add(x);
      for (let i = queue.length - 1; i >= 0; i--) {
        const [m, p] = queue[i];
        if (cancelled.has(m.id)) { queue.splice(i, 1); cancelled.delete(m.id); p({ type: 'error', id: m.id, message: 'cancelled' }); }
      }
    } else if (msg.type === 'dispose') {
      loaded = null;
      stream = null;
      queue.length = 0;
      post({ type: 'disposed', id });
    } else throw new Error(`Bilinmeyen ileti: ${msg.type}`);
  } catch (e) {
    post({ type: 'error', id, message: e?.message || String(e) });
  }
}

function result(msg, post, ms) {
  const L0 = msg.left, R0 = msg.right && msg.right.length ? msg.right : msg.left;
  if (msg.startSample == null) {
    const left = scale(L0), right = scale(R0);
    post({ type: 'result', id: msg.id, left, right, ms, backend: loaded?.backend || 'mock' }, [left.buffer, right.buffer]);
    return;
  }
  const sr = msg.sampleRate || 48000;
  const start = Math.round(msg.startSample);
  let reset = false;
  if (!stream || msg.reset || stream.sr !== sr || stream.inPos !== start) {
    stream = { sr, inPos: start, outPos: start, L: new Float32Array(0), R: new Float32Array(0) };
    reset = true;
  }
  const S = stream;
  const cat = (a, b) => { const c = new Float32Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; };
  S.L = cat(S.L, scale(L0)); S.R = cat(S.R, scale(R0));
  S.inPos += L0.length;
  const E = S.inPos / sr;
  const f = msg.final ? S.inPos : Math.round((Math.floor((E - CHUNK_SEC) / STEP_SEC + 1e-9) + 1) * STEP_SEC * sr);
  const n = Math.max(0, Math.min(S.inPos, f) - S.outPos);
  const left = S.L.slice(0, n), right = S.R.slice(0, n);
  S.L = S.L.slice(n); S.R = S.R.slice(n);
  const outStart = S.outPos;
  S.outPos += n;
  if (msg.final) stream = null;
  post({
    type: 'result', id: msg.id, left, right, ms, backend: loaded?.backend || 'mock',
    startSample: outStart, windows: 0, reset, final: !!msg.final,
  }, [left.buffer, right.buffer]);
}

// sıralı iş: ilerleme anlık hıza göre birikir (test süren işi hızlandırabilsin)
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const [msg, post] = queue.shift();
    const t0 = performance.now();
    const sec = msg.left.length / (msg.sampleRate || 48000);
    let stop = false;
    for (let done = 0; rtf > 0 && done < sec;) {
      await sleep(20);
      done += 0.02 / rtf;
      if (cancelled.has(msg.id)) { stop = true; break; }
    }
    if (!loaded) continue;
    if (stop) { cancelled.delete(msg.id); stream = null; post({ type: 'error', id: msg.id, message: 'cancelled' }); continue; }
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
