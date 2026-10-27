// Kalıcı çeviri önbelleği: videonun cümleleri ve Türkçe çevirileri chrome.storage.local'da tutulur, böylece aynı video
// yeniden açıldığında altyazı çekme ve çeviri beklenmez. En son kullanılan MAX_VIDEOS video saklanır (LRU).
// storage: chrome.storage.local ya da aynı get/set/remove arayüzüne sahip bir nesne (testler).

export const MAX_VIDEOS = 50;
const INDEX = 'trIndex'; // en eskiden en yeniye anahtarlar
const PREFIX = 'tr:';

export const transcriptKey = (videoId, trKey) => `${PREFIX}${videoId}:${trKey}`;

async function readIndex(storage) {
  const { [INDEX]: idx } = await storage.get(INDEX);
  return Array.isArray(idx) ? idx : [];
}

async function touch(storage, key) {
  const idx = (await readIndex(storage)).filter((k) => k !== key);
  idx.push(key);
  const drop = idx.splice(0, Math.max(0, idx.length - MAX_VIDEOS));
  if (drop.length) await storage.remove(drop);
  await storage.set({ [INDEX]: idx });
}

/** → [{ start, end, text, tr }] | null */
export async function loadTranscript(storage, videoId, trKey) {
  const key = transcriptKey(videoId, trKey);
  const { [key]: v } = await storage.get(key);
  if (!Array.isArray(v?.sentences) || !v.sentences.length) return null;
  await touch(storage, key);
  return v.sentences;
}

export async function saveTranscript(storage, videoId, trKey, sentences) {
  if (!videoId || !sentences?.length) return;
  const key = transcriptKey(videoId, trKey);
  const slim = sentences.map(({ start, end, text, tr, speaker }) => ({
    start, end, text, tr: tr ?? null, ...(speaker ? { speaker } : {}),
  }));
  await storage.set({ [key]: { savedAt: Date.now(), sentences: slim } });
  await touch(storage, key);
}

/** Silinen video sayısı. */
export async function clearTranscripts(storage) {
  const idx = await readIndex(storage);
  const all = await storage.get(null);
  const keys = Object.keys(all || {}).filter((k) => k.startsWith(PREFIX));
  await storage.remove([...new Set([...keys, ...idx]), INDEX]);
  return keys.length;
}

export async function transcriptStats(storage) {
  const all = await storage.get(null);
  const keys = Object.keys(all || {}).filter((k) => k.startsWith(PREFIX));
  const bytes = keys.reduce((n, k) => n + JSON.stringify(all[k]).length, 0);
  return { videos: keys.length, bytes };
}
