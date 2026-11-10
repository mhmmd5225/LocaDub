// Cümle sesi deposu ("Tüm videoyu hazırla"): sentezlenen sesler eklentinin kendi kökeninde (chrome-extension://)
// Cache API'ye yazılır. Yazma ve okuma offscreen belgesinde yapılır (offscreen.js: tts.synthesize { store },
// audio.list, audio.get); içerik betiği yalnız anahtarı hesaplar (storeHash) ve iletiyle ister.
// Neden eklenti kökeni: içerik betiğindeki `caches` YouTube'a aittir (YouTube silebilir, kota paylaşılır); eklentinin
// `unlimitedStorage` izni var ve kayıt yalnız bizim. Yazma sentezin yapıldığı yerde olduğundan ek aktarım yok.
//
// Kayıt: https://locadub.invalid/a/<video>/<i>/<hash> → ham PCM (int16 LE, mono), başlık x-sr (örnek hızı).
// Dizin (aynı önbellekte /__index): { v:1, videos: { [video]: { at, bytes, items: { [i]: [hash, bytes] } } } }.
// Bir cümlenin tek kaydı olur: aynı cümle yeni anahtarla yazılınca eskisi silinir (ses / ton / çeviri değişti).

export const AUDIO_CACHE = 'locadub-audio-v1';
export const STORE_LIMIT_BYTES = 1.5 * 1024 ** 3; // toplam sınır; aşılınca en eski videonun kayıtları silinir
const BASE = 'https://locadub.invalid/';
const INDEX_URL = BASE + '__index';

// ---- saf yardımcılar ----

// FNV-1a 32 bit (iki farklı tohumla 64 bit'lik kısa özet)
function fnv(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Kısa metin özeti (16 onaltılık). */
export function shortHash(str) {
  const s = String(str ?? '');
  return fnv(s, 0x811c9dc5) + fnv(s, 0x2b5ae1e3);
}

/**
 * Cümle sesinin depo anahtarı (özet): seslendirilecek metin + ses kimliği (_voiceKey) + ses ayarları anahtarı
 * (audioKey) + sentez hızı + ton. Bunlardan biri değişince anahtar değişir, eski kayıt eşleşmez.
 */
export function storeHash({ text, voiceKey, audioKey, speed, tone }) {
  const t = tone ? `${tone.style ?? ''}:${tone.pitch ?? ''}:${tone.quality ?? ''}:${tone.blend ? JSON.stringify(tone.blend) : ''}` : '';
  return shortHash([shortHash(text), voiceKey ?? '', audioKey ?? '', Number(speed || 1).toFixed(3), t].join('\u0001'));
}

export const entryUrl = (video, i, hash) => `${BASE}a/${encodeURIComponent(video)}/${i}/${hash}`;

/**
 * Kota kararı: `incoming` bayt yazılmadan önce silinecek videolar (en eski `at` önce; şimdiki video silinmez).
 * → { evict: string[], deny: boolean } (deny: şimdiki video tek başına sınırı aşıyor, yazma yapılmaz).
 */
export function planEviction(index, { video, incoming = 0, limit = STORE_LIMIT_BYTES } = {}) {
  const vids = Object.entries(index?.videos || {});
  let total = vids.reduce((a, [, v]) => a + (v.bytes || 0), 0) + incoming;
  const evict = [];
  if (total <= limit) return { evict, deny: false };
  for (const [id, v] of vids.filter(([id]) => id !== video).sort((a, b) => (a[1].at || 0) - (b[1].at || 0))) {
    evict.push(id);
    total -= v.bytes || 0;
    if (total <= limit) return { evict, deny: false };
  }
  return { evict, deny: true };
}

function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Float32 → int16 LE baytları (common/pcm.js float32ToInt16 ile aynı ölçek)
function pcmBytes(pcm) {
  const out = new Uint8Array(pcm.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) {
    let v = pcm[i];
    if (!(v === v)) v = 0;
    v = v > 1 ? 1 : v < -1 ? -1 : v;
    dv.setInt16(i * 2, v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff), true);
  }
  return out;
}

// ---- depo (offscreen belgesinde; Node testlerinde sahte CacheStorage ile) ----

/** cacheStorage: CacheStorage benzeri ({ open(name) → { match, put, delete } }). */
export function createAudioStore(cacheStorage, { limit = STORE_LIMIT_BYTES, now = () => Date.now() } = {}) {
  let index = null;
  let lock = Promise.resolve();
  let saveTimer = null;
  const cache = () => cacheStorage.open(AUDIO_CACHE);
  // dizin işlemleri sırayla (aynı anda iki yazma dizini bozmasın)
  const serial = (fn) => {
    const p = lock.then(fn);
    lock = p.catch(() => {});
    return p;
  };

  async function load() {
    if (index) return index;
    const c = await cache();
    const res = await c.match(INDEX_URL);
    let idx = null;
    try { idx = res ? await res.json() : null; } catch { idx = null; }
    if (!idx || idx.v !== 1 || typeof idx.videos !== 'object') {
      // dizin yok ya da bozuk: kayıtlar sahipsiz kalmasın diye önbellek baştan kurulur
      if (res || idx) await cacheStorage.delete(AUDIO_CACHE);
      idx = { v: 1, videos: {} };
    }
    index = idx;
    return index;
  }

  async function save() {
    const c = await cache();
    await c.put(INDEX_URL, new Response(JSON.stringify(index), { headers: { 'content-type': 'application/json' } }));
  }
  // dizini kısa gecikmeyle yaz (art arda kayıtlarda her seferinde değil)
  function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; serial(save).catch(() => {}); }, 400);
  }

  async function dropVideo(c, video) {
    const v = index.videos[video];
    if (!v) return;
    for (const [i, [hash]] of Object.entries(v.items || {})) await c.delete(entryUrl(video, i, hash));
    delete index.videos[video];
  }

  return {
    /** Ses kaydı yazar; true: yazıldı. Hata fırlatır (kota, gizli pencere vb.). */
    put(video, i, hash, pcm, sampleRate) {
      return serial(async () => {
        await load();
        const body = pcmBytes(pcm);
        const c = await cache();
        const plan = planEviction(index, { video, incoming: body.length, limit });
        for (const id of plan.evict) await dropVideo(c, id);
        if (plan.deny) { saveSoon(); throw new Error('ses deposu sınırı aşıldı'); }
        const v = index.videos[video] ||= { at: now(), bytes: 0, items: {} };
        const old = v.items[i];
        if (old && old[0] !== hash) await c.delete(entryUrl(video, i, old[0]));
        await c.put(entryUrl(video, i, hash), new Response(body, { headers: { 'content-type': 'application/octet-stream', 'x-sr': String(sampleRate) } }));
        v.bytes += body.length - (old ? old[1] : 0);
        v.items[i] = [hash, body.length];
        v.at = now();
        saveSoon();
        return true;
      });
    },
    /** Videonun kayıtları: { items: { [i]: hash }, bytes } ; videonun "son kullanım" zamanı güncellenir. */
    list(video) {
      return serial(async () => {
        await load();
        const v = index.videos[video];
        if (!v) return { items: {}, bytes: 0 };
        v.at = now();
        saveSoon();
        return { items: Object.fromEntries(Object.entries(v.items).map(([i, [h]]) => [i, h])), bytes: v.bytes };
      });
    },
    /** Kayıt: { pcmBase64, sampleRate } ya da null (yok / silinmiş). */
    async get(video, i, hash) {
      const c = await cache();
      const res = await c.match(entryUrl(video, i, hash));
      if (!res) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { pcmBase64: bytesToBase64(bytes), sampleRate: Number(res.headers.get('x-sr')) || 22050 };
    },
    /** Toplam: { videos, entries, bytes } (tanılama ve testler). */
    stats() {
      return serial(async () => {
        await load();
        const vs = Object.values(index.videos);
        return { videos: vs.length, entries: vs.reduce((a, v) => a + Object.keys(v.items).length, 0), bytes: vs.reduce((a, v) => a + v.bytes, 0) };
      });
    },
    /** Bekleyen dizin yazımını hemen yap (testler). */
    flush() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      return serial(save);
    },
  };
}
