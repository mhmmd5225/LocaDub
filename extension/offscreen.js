// Offscreen document: çeviri (mt) ve seslendirme (tts) motorlarını yükler ve çalıştırır.
// Yalnızca background'dan gelen { target:'offscreen' } mesajlarını işler.

import { clearModels } from './engines/common/model-cache.js';
import { encodePcmBase64 } from './common/pcm.js';

const PATHS = {
  real: { mt: './engines/mt/index.js', tts: './engines/tts/index.js' },
  mock: { mt: './engines/_mock/mt.js', tts: './engines/_mock/tts.js' },
};
const LABEL = { mt: 'Çeviri', tts: 'Seslendirme' };

function newState() {
  return {
    mods: { real: null, mock: null },
    mode: null, key: null, ready: false, loading: false, initP: null, error: null,
    options: {}, queue: Promise.resolve(),
    progress: new Map(), lastEmit: 0,
  };
}
const state = { mt: newState(), tts: newState() };
const jobs = new Map(); // tag → Set<AbortController>

class EngineError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

async function loadModule(engine, mode) {
  const s = state[engine];
  if (s.mods[mode]) return s.mods[mode];
  const path = PATHS[mode][engine];
  let mod;
  try {
    mod = await import(path);
  } catch (e) {
    throw new EngineError(
      `${LABEL[engine]} motoru yüklenemedi (${path.slice(2)}): ${e?.message || e}. ` +
      `Motor henüz kurulmamış olabilir; açılır pencereden "Test motoru" seçeneğini açabilirsiniz.`,
      'ENGINE_MISSING');
  }
  const need = engine === 'mt' ? ['init', 'translateBatch'] : ['init', 'synthesize'];
  for (const fn of need) {
    if (typeof mod[fn] !== 'function') {
      throw new EngineError(`${LABEL[engine]} motoru geçersiz: "${fn}" fonksiyonu yok (${path.slice(2)}).`, 'ENGINE_INVALID');
    }
  }
  s.mods[mode] = mod;
  return mod;
}

// İlerleme: dosya bazında toplar, ~4/sn yayınlar.
function makeProgress(engine) {
  const s = state[engine];
  s.progress = new Map();
  return (p = {}) => {
    const key = p.url || p.file || '_';
    const loaded = Number(p.loaded) || 0;
    const total = Math.max(Number(p.total) || 0, loaded);
    // 'load'/'ready' aşamaları indirme değildir (ör. Chrome çevirmeni hazır bildirimi).
    const cachedPart = !!p.cached || p.phase === 'load' || p.phase === 'ready';
    s.progress.set(key, { loaded, total, cached: cachedPart });
    let L = 0, T = 0, cached = true;
    for (const v of s.progress.values()) { L += v.loaded; T += v.total; cached &&= v.cached; }
    const now = Date.now();
    if (now - s.lastEmit < 250 && L < T) return;
    s.lastEmit = now;
    send({ type: 'engine.progress', engine, loaded: L, total: T, cached, url: p.url || null, files: s.progress.size });
  };
}

function send(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function engineOptions(engine, settings = {}, explicit = {}) {
  if (engine === 'mt') {
    const backend = explicit.backend ?? settings.mtBackend ?? undefined;
    return backend ? { backend } : {};
  }
  const voice = explicit.voice ?? settings.voice ?? undefined;
  return voice ? { voice } : {};
}

async function ensure(engine, settings = {}, explicit = {}, { userInitiated = false } = {}) {
  const s = state[engine];
  const mode = settings.engineMode === 'mock' ? 'mock' : 'real';
  const options = engineOptions(engine, settings, explicit);
  const key = mode + '|' + JSON.stringify(options);
  if (s.key === key && s.ready) return s.mods[mode];
  if (s.key === key && s.initP) return s.initP;
  if (mode === 'real' && !settings.modelsApproved && !userInitiated) {
    throw new EngineError('Modeller henüz hazırlanmadı. Eklenti simgesine tıklayıp "Modelleri hazırla" düğmesine basın.', 'NOT_APPROVED');
  }

  // Mod değiştiyse eskisini kapat.
  if (s.mode && s.mode !== mode && s.mods[s.mode]) {
    try { await s.mods[s.mode].dispose?.(); } catch { /* yoksay */ }
  }
  s.key = key; s.mode = mode; s.ready = false; s.loading = true; s.error = null; s.options = options;
  const onProgress = makeProgress(engine);
  const p = (async () => {
    const mod = await loadModule(engine, mode);
    await mod.init({ ...options, onProgress });
    return mod;
  })();
  s.initP = p;
  try {
    const mod = await p;
    if (s.initP === p) {
      s.ready = true; s.loading = false;
      send({ type: 'engine.progress', engine, done: true, loaded: 1, total: 1 });
    }
    return mod;
  } catch (e) {
    if (s.initP === p) {
      s.loading = false; s.error = e?.message || String(e); s.key = null; s.initP = null;
      send({ type: 'engine.progress', engine, error: s.error });
    }
    throw e;
  } finally {
    if (s.initP === p && s.ready) s.initP = null;
  }
}

// Motor başına sıralı çalıştırma + etiketle iptal.
function run(engine, tag, fn) {
  const s = state[engine];
  const ac = new AbortController();
  if (tag) {
    if (!jobs.has(tag)) jobs.set(tag, new Set());
    jobs.get(tag).add(ac);
  }
  const task = s.queue.then(async () => {
    if (ac.signal.aborted) throw new EngineError('İptal edildi', 'ABORTED');
    return fn(ac.signal);
  });
  s.queue = task.catch(() => {});
  return task.finally(() => {
    if (tag) {
      const set = jobs.get(tag);
      set?.delete(ac);
      if (set && !set.size) jobs.delete(tag);
    }
  });
}

function status() {
  const one = (engine) => {
    const s = state[engine];
    return {
      ready: s.ready, loading: s.loading, error: s.error, mode: s.mode,
      ...(engine === 'mt' ? { backend: s.options.backend ?? null } : { voice: s.options.voice ?? null }),
    };
  };
  return {
    mt: one('mt'),
    tts: one('tts'),
    crossOriginIsolated: !!self.crossOriginIsolated,
    webgpu: !!navigator.gpu,
    hardwareConcurrency: navigator.hardwareConcurrency || 1,
  };
}

async function resetEngine(engine) {
  const s = state[engine];
  for (const m of Object.values(s.mods)) { try { await m?.dispose?.(); } catch { /* yoksay */ } }
  state[engine] = newState();
}

async function handle(msg) {
  const settings = msg.settings || {};
  switch (msg.type) {
    case 'engine.init': {
      const engine = msg.engine;
      if (engine !== 'mt' && engine !== 'tts') throw new EngineError('Bilinmeyen motor: ' + engine, 'BAD_REQUEST');
      if (engine === 'tts' && (msg.options?.voice ?? settings.voice) === 'system') return status();
      await ensure(engine, settings, msg.options || {}, { userInitiated: !!msg.userInitiated });
      return status();
    }
    case 'engine.status':
      return status();
    case 'engine.list': {
      const mode = settings.engineMode === 'mock' ? 'mock' : 'real';
      const out = { mode, backends: [], voices: [], errors: {} };
      try { out.backends = await (await loadModule('mt', mode)).listBackends?.() ?? []; } catch (e) { out.errors.mt = e.message; }
      try { out.voices = await (await loadModule('tts', mode)).listVoices?.() ?? []; } catch (e) { out.errors.tts = e.message; }
      return out;
    }
    case 'mt.translate': {
      const sentences = Array.isArray(msg.sentences) ? msg.sentences.map((x) => String(x ?? '')) : [];
      if (!sentences.length) return [];
      const mod = await ensure('mt', settings);
      const result = await run('mt', msg.tag, (signal) => mod.translateBatch(sentences, { signal }));
      if (!Array.isArray(result) || result.length !== sentences.length) {
        throw new EngineError('Çeviri motoru beklenmeyen sonuç döndürdü (uzunluk uyuşmuyor).', 'ENGINE_INVALID');
      }
      return result.map((x) => String(x ?? ''));
    }
    case 'tts.synthesize': {
      const voice = msg.voice ?? settings.voice ?? undefined;
      if (voice === 'system') return { system: true };
      const text = String(msg.text ?? '').trim();
      if (!text) return { pcmBase64: '', sampleRate: 22050, format: 's16le', samples: 0 };
      const mod = await ensure('tts', settings, voice ? { voice } : {});
      const speed = Math.min(2, Math.max(0.5, Number(msg.speed) || 1));
      const r = await run('tts', msg.tag, (signal) => mod.synthesize(text, { voice, speed, signal }));
      if (r?.system) return { system: true };
      if (!r || !(r.pcm instanceof Float32Array) || !r.sampleRate) {
        throw new EngineError('Seslendirme motoru beklenmeyen sonuç döndürdü.', 'ENGINE_INVALID');
      }
      return { pcmBase64: encodePcmBase64(r.pcm), sampleRate: r.sampleRate, format: 's16le', samples: r.pcm.length };
    }
    case 'jobs.cancel': {
      const set = jobs.get(msg.tag);
      let n = 0;
      if (set) for (const ac of set) { ac.abort(); n++; }
      return { cancelled: n };
    }
    case 'models.clear': {
      for (const engine of ['mt', 'tts']) await resetEngine(engine);
      const n = await clearModels();
      return { cleared: n };
    }
    case 'engine.reset': {
      // Ayarlar sayfası tek bir modeli silmeden önce motoru bellekten boşaltır.
      if (msg.engine !== 'mt' && msg.engine !== 'tts') throw new EngineError('Bilinmeyen motor: ' + msg.engine, 'BAD_REQUEST');
      await resetEngine(msg.engine);
      return status();
    }
    default:
      throw new EngineError('Bilinmeyen istek: ' + msg.type, 'BAD_REQUEST');
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  handle(msg).then(
    (result) => sendResponse({ ok: true, result }),
    (e) => {
      const aborted = e?.name === 'AbortError' || e?.code === 'ABORTED';
      sendResponse({ ok: false, error: e?.message || String(e), code: aborted ? 'ABORTED' : (e?.code || 'ERROR') });
    },
  );
  return true;
});

send({ type: 'offscreen.ready' });
