// Sahte çeviri motoru (test için). engines/mt/index.js ile aynı API.

export const id = 'mt';

let ready = false;

const delay = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('İptal edildi', 'AbortError')); }, { once: true });
});

export async function listBackends() {
  return [{ id: 'mock', label: 'Sahte çevirmen (test)', sizeMB: 0, available: true }];
}

export async function init({ backend, onProgress } = {}) {
  if (ready) return;
  const total = 4_000_000;
  for (let loaded = 0; loaded <= total; loaded += 1_000_000) {
    onProgress?.({ url: 'mock://mt/model.onnx', loaded, total });
    await delay(120);
  }
  ready = true;
}

export async function translateBatch(sentences, { signal } = {}) {
  if (!ready) await init();
  await delay(30 + 10 * sentences.length, signal);
  return sentences.map((s) => (s && s.trim() ? '[TR] ' + s.trim() : ''));
}

export async function dispose() {
  ready = false;
}
