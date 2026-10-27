// Konuşma tanıma işçisi: Whisper (transformers.js, onnxruntime-web WASM). İngilizce ses → zaman damgalı metin.
//
//   → { type:'load', id, model, dtype }                       ← { type:'progress', file, loaded, total } … { type:'ready', id }
//   → { type:'transcribe', id, audio:Float32Array(16 kHz) }   ← { type:'result', id, chunks:[{ start, end, text }] }
//   ← { type:'error', id, message }

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

let asr = null;
let loading = null;

async function load(model, dtype) {
  if (asr) return;
  if (!loading) {
    loading = pipeline('automatic-speech-recognition', model, {
      dtype,
      device: 'wasm',
      progress_callback: (p) => {
        if (p.status === 'progress') self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
      },
    }).then((p) => { asr = p; }, (e) => { loading = null; throw e; });
  }
  await loading;
}

let queue = Promise.resolve();

self.onmessage = (ev) => {
  const m = ev.data || {};
  queue = queue.then(async () => {
    try {
      if (m.type === 'load') {
        await load(m.model, m.dtype);
        self.postMessage({ type: 'ready', id: m.id });
      } else if (m.type === 'transcribe') {
        const out = await asr(m.audio, { return_timestamps: true });
        const dur = m.audio.length / 16000;
        const chunks = (out.chunks || []).map((c) => ({
          start: c.timestamp?.[0] ?? 0,
          end: c.timestamp?.[1] ?? dur,
          text: String(c.text || '').trim(),
        })).filter((c) => c.text);
        self.postMessage({ type: 'result', id: m.id, chunks });
      }
    } catch (e) {
      self.postMessage({ type: 'error', id: m.id, message: String(e?.message || e) });
    }
  });
};
