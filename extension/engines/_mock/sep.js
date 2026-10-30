// Sahte ses ayırma işçisi (test için; modül Worker). engines/sep/worker.js ile aynı protokol:
//   load    { id, model?, backend? }            → progress* → loaded { id, backend, model, contextSec }
//   process { id, left, right, sampleRate }     → result { id, left, right, ms, backend } (aktarılır)
//   dispose
// Sonuç girdi × 0.5'tir, hemen döner. Testte yavaşlatma: process'e mockRtf (gerçek zaman oranı) eklenirse işlem
// süre × mockRtf kadar sürer; { type:'mock-rtf', rtf } süren işin hızını da değiştirir.

let rtf = 0;
let loaded = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function work(m) {
  const t0 = performance.now();
  if (m.mockRtf != null) rtf = Number(m.mockRtf) || 0;
  const sec = m.left.length / (m.sampleRate || 48000);
  // ilerleme anlık hıza göre birikir (test süren işi hızlandırabilsin)
  for (let done = 0; rtf > 0 && done < sec;) {
    await sleep(20);
    done += 0.02 / rtf;
  }
  const left = new Float32Array(m.left.length), right = new Float32Array(m.right.length);
  for (let i = 0; i < left.length; i++) left[i] = m.left[i] * 0.5;
  for (let i = 0; i < right.length; i++) right[i] = m.right[i] * 0.5;
  return { left, right, ms: performance.now() - t0 };
}

const queue = [];
let busy = false;

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const m = queue.shift();
    try {
      const r = await work(m);
      self.postMessage({ type: 'result', id: m.id, left: r.left, right: r.right, ms: r.ms, backend: 'mock' }, [r.left.buffer, r.right.buffer]);
    } catch (e) {
      self.postMessage({ type: 'error', id: m.id, message: String(e?.message || e) });
    }
  }
  busy = false;
}

self.onmessage = async ({ data: m }) => {
  if (!m) return;
  if (m.type === 'load') {
    for (let k = 1; k <= 4; k++) self.postMessage({ type: 'progress', id: m.id, loaded: k, total: 4 });
    loaded = true;
    self.postMessage({ type: 'loaded', id: m.id, backend: 'mock', model: m.model || 'mock', contextSec: 1 });
  } else if (m.type === 'process') {
    if (!loaded) { self.postMessage({ type: 'error', id: m.id, message: 'Model yüklenmedi' }); return; }
    queue.push(m);
    pump();
  } else if (m.type === 'mock-rtf') {
    rtf = Number(m.rtf) || 0;
  } else if (m.type === 'dispose') {
    loaded = false;
    queue.length = 0;
  }
};
