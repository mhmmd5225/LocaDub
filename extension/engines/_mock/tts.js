// Sahte seslendirme motoru (test için). engines/tts/index.js ile aynı API.
// Metin uzunluğuna göre hece benzeri kısa bip'ler üretir.

export const id = 'tts';

const SAMPLE_RATE = 22050;
const CHARS_PER_SEC = 14; // speed=1'de yaklaşık Türkçe konuşma hızı
let ready = false;

export async function listVoices() {
  return [
    { id: 'mock-beep', label: 'Sahte bip (test)', gender: 'unknown', sizeMB: 0, license: 'MIT', available: true },
    { id: 'mock-silent', label: 'Sahte sessizlik (test)', gender: 'unknown', sizeMB: 0, license: 'MIT', available: true },
  ];
}

export async function init({ voice, onProgress } = {}) {
  if (ready) return;
  onProgress?.({ url: 'mock://tts/voice.onnx', loaded: 1, total: 1 });
  ready = true;
}

export async function synthesize(text, { voice = 'mock-beep', speed = 1.0, tone, signal } = {}) {
  if (!ready) await init();
  globalThis.__lastTtsTone = tone ?? null; // e2e: motorun aldığı son ton ({ style, pitch, quality })
  globalThis.__ttsToneCalls = (globalThis.__ttsToneCalls || 0) + 1;
  // e2e: offscreen belgesine doğrudan erişilemez; ton, eklenti sayfalarının dinleyebileceği bir iletiyle de yayımlanır
  try { chrome.runtime.sendMessage({ type: 'mock.tts.tone', tone: tone ?? null, text: String(text || '') }).catch(() => {}); } catch { /* chrome yok (Node) */ }
  if (signal?.aborted) throw new DOMException('İptal edildi', 'AbortError');
  const chars = String(text || '').replace(/^\[TR\]\s*/, '').length;
  const sec = Math.max(0.3, chars / CHARS_PER_SEC / Math.max(0.5, speed));
  const n = Math.round(sec * SAMPLE_RATE);
  const pcm = new Float32Array(n);
  if (voice !== 'mock-silent') {
    const syl = Math.round(0.18 * SAMPLE_RATE / Math.max(0.5, speed)); // hece süresi
    for (let i = 0; i < n; i++) {
      const k = Math.floor(i / syl);
      const ph = (i % syl) / syl;
      const env = ph < 0.75 ? Math.sin(Math.PI * ph / 0.75) : 0;
      const f = 220 + 60 * ((k * 7) % 5);
      pcm[i] = 0.2 * env * Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE);
    }
  }
  await new Promise((r) => setTimeout(r, Math.min(200, sec * 50))); // RTF ~0.05
  return { pcm, sampleRate: SAMPLE_RATE };
}

export async function dispose() {
  ready = false;
}
