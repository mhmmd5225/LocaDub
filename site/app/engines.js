// Çeviri ve seslendirme motorlarını doğrudan sayfada çalıştırır (eklentideki offscreen.js'in mesajsız karşılığı).
// Ağır işler motorların kendi Web Worker'larında yapılır; ana iş parçacığı serbest kalır.

const PATHS = {
  real: { mt: './ext/engines/mt/index.js', tts: './ext/engines/tts/index.js' },
  mock: { mt: './ext/engines/_mock/mt.js', tts: './ext/engines/_mock/tts.js' },
};
const LABEL = { mt: 'Çeviri', tts: 'Seslendirme' };

const mods = new Map(); // `${mode}:${engine}` → modül
const state = { mt: { key: null, ready: null }, tts: { key: null, ready: null } };
const queues = { mt: Promise.resolve(), tts: Promise.resolve() };
const jobs = new Map(); // tag → Set<AbortController>

export async function loadModule(engine, mode) {
  const k = `${mode}:${engine}`;
  if (!mods.has(k)) {
    const p = import(PATHS[mode][engine]).catch((e) => {
      mods.delete(k);
      throw new Error(`${LABEL[engine]} motoru yüklenemedi: ${e?.message || e}`);
    });
    mods.set(k, p);
  }
  return mods.get(k);
}

const modeOf = (s) => (s.engineMode === 'mock' ? 'mock' : 'real');

/**
 * Motoru yükler (gerekirse modeli indirir). onProgress({ engine, loaded, total, cached }) dosyalar toplanarak çağrılır.
 */
export async function ensure(engine, settings, onProgress) {
  const mode = modeOf(settings);
  const options = engine === 'mt'
    ? (settings.mtBackend ? { backend: settings.mtBackend } : {})
    : (settings.voice ? { voice: settings.voice } : {});
  const key = mode + '|' + JSON.stringify(options);
  const s = state[engine];
  if (s.key === key && s.ready) return s.ready;
  s.key = key;
  const files = new Map();
  let last = 0;
  const progress = (p = {}) => {
    const loaded = Number(p.loaded) || 0;
    files.set(p.url || p.file || '_', {
      loaded, total: Math.max(Number(p.total) || 0, loaded), cached: !!p.cached || p.phase === 'load' || p.phase === 'ready',
    });
    let L = 0, T = 0, cached = true;
    for (const v of files.values()) { L += v.loaded; T += v.total; cached &&= v.cached; }
    const now = Date.now();
    if (now - last < 200 && L < T) return;
    last = now;
    onProgress?.({ engine, loaded: L, total: T, cached });
  };
  s.ready = (async () => {
    const mod = await loadModule(engine, mode);
    await mod.init({ ...options, onProgress: progress });
    onProgress?.({ engine, done: true });
    return mod;
  })();
  s.ready.catch(() => { if (s.key === key) { s.key = null; s.ready = null; } });
  return s.ready;
}

// Motor başına sıralı çalıştırma; etiketle toplu iptal.
function run(engine, tag, fn) {
  const ac = new AbortController();
  if (!jobs.has(tag)) jobs.set(tag, new Set());
  jobs.get(tag).add(ac);
  const task = queues[engine].then(() => {
    if (ac.signal.aborted) throw Object.assign(new Error('İptal edildi'), { code: 'ABORTED' });
    return fn(ac.signal);
  });
  queues[engine] = task.catch(() => {});
  return task.finally(() => {
    const set = jobs.get(tag);
    set?.delete(ac);
    if (set && !set.size) jobs.delete(tag);
  }).catch((e) => {
    if (e?.name === 'AbortError' || ac.signal.aborted) throw Object.assign(new Error('İptal edildi'), { code: 'ABORTED' });
    throw e;
  });
}

export async function translate(sentences, settings, tag) {
  const mod = await ensure('mt', settings);
  const out = await run('mt', tag, (signal) => mod.translateBatch(sentences, { signal }));
  if (!Array.isArray(out) || out.length !== sentences.length) throw new Error('Çeviri motoru beklenmeyen sonuç döndürdü.');
  return out.map((x) => String(x ?? '').trim());
}

/** → { pcm: Float32Array, sampleRate } */
export async function synthesize(text, speed, settings, tag) {
  const mod = await ensure('tts', settings);
  const voice = settings.voice || undefined;
  const r = await run('tts', tag, (signal) => mod.synthesize(text, { voice, speed, signal }));
  if (!r || !(r.pcm instanceof Float32Array) || !r.sampleRate) throw new Error('Seslendirme motoru beklenmeyen sonuç döndürdü.');
  return r;
}

export function cancel(tag) {
  for (const ac of jobs.get(tag) || []) ac.abort();
  jobs.delete(tag);
}

export async function listAll(settings) {
  const mode = modeOf(settings);
  const out = { mode, backends: [], voices: [], errors: {} };
  try { out.backends = (await (await loadModule('mt', mode)).listBackends?.()) ?? []; } catch (e) { out.errors.mt = e.message; }
  try { out.voices = (await (await loadModule('tts', mode)).listVoices?.()) ?? []; } catch (e) { out.errors.tts = e.message; }
  return out;
}

// Modeller silinmeden önce motorları bellekten boşaltır.
export async function resetAll() {
  for (const p of mods.values()) {
    try { await (await p).dispose?.(); } catch { /* yoksay */ }
  }
  for (const s of Object.values(state)) { s.key = null; s.ready = null; }
}
