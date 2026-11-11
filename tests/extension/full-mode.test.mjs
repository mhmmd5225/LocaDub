// Tam kip ("Tüm videoyu hazırla"): sıra (fullIndices), ilerleme ve kalan süre, ses deposu anahtarı ve kota kararı,
// depo (sahte CacheStorage ile).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullIndices, fullProgress, fullEta, windowIndices } from '../../extension/content/timing.js';
import { storeHash, shortHash, planEviction, createAudioStore, entryUrl, AUDIO_CACHE } from '../../extension/content/audio-store.js';

// 10 cümle, her biri 2 sn, 5 sn arayla: start = 5k
const S = Array.from({ length: 10 }, (_, k) => ({ start: 5 * k, end: 5 * k + 2, i: k }));

test('fullIndices: önce yakın pencere, sonra ileri, sonra baştan', () => {
  // t = 20 (4. cümle), pencere 10 sn → 4, 5 (start < 30); ileri 6..9; baştan 0..3
  assert.deepEqual(fullIndices(S, 20, 10), [4, 5, 6, 7, 8, 9, 0, 1, 2, 3]);
  // pencere her zaman windowIndices ile aynı başlar (oynatmanın yanıt süresi bozulmaz)
  assert.deepEqual(fullIndices(S, 20, 10).slice(0, 2), windowIndices(S, 20, 10));
  // pred: hazır olanlar atlanır, sıra korunur
  const done = new Set([4, 6, 0]);
  assert.deepEqual(fullIndices(S, 20, 10, (_, i) => !done.has(i)), [5, 7, 8, 9, 1, 2, 3]);
  // başta: pencere sonra kalanlar, geride bir şey yok
  assert.deepEqual(fullIndices(S, 0, 10), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // sonda: çalan son cümle önce, geri kalanı baştan; her indeks bir kez
  const end = fullIndices(S, 46, 10);
  assert.deepEqual(end, [9, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
  // biten son cümle (t = 48) pencereye girmez, geride sayılır
  assert.deepEqual([...fullIndices(S, 48, 10)].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(fullIndices([], 0, 10), []);
});

test('fullProgress: çeviri sayısı, sesli süre, bitiş', () => {
  const s = [
    { start: 0, end: 2, tr: 'a', audio: {} },
    { start: 3, end: 6, tr: 'b', stored: 'h' },
    { start: 7, end: 8, tr: '' }, // boş çeviri: ses gerekmez, işlendi
    { start: 9, end: 13, tr: 'd' }, // ses yok
    { start: 14, end: 15, tr: null },
  ];
  const has = (x) => !!(x.audio || x.stored);
  const p = fullProgress(s, { hasAudio: has });
  assert.deepEqual(p, { trDone: 4, trTotal: 5, auDone: 3, auTotal: 5, auSec: 6, totalSec: 11, done: false });
  s[3].audio = {}; s[4].tr = 'e'; s[4].auFailed = true;
  assert.equal(fullProgress(s, { hasAudio: has }).done, true);
  // ses gerekmiyorsa (sistem sesi) yalnız çeviri
  assert.equal(fullProgress([{ start: 0, end: 1, tr: 'x' }], { needAudio: false }).done, true);
  assert.equal(fullProgress([{ start: 0, end: 1, tr: 'x' }]).done, false);
  assert.equal(fullProgress([]).done, false);
});

test('fullEta: ölçüm yoksa tahmin yok, varsa paralel işlerin büyüğü', () => {
  assert.equal(fullEta({ trLeft: 10, auLeft: 5, trMs: null, auMs: 100 }), null);
  assert.equal(fullEta({ trLeft: 0, auLeft: 5, trMs: null, auMs: 200 }), 1);
  assert.equal(fullEta({ trLeft: 10, auLeft: 20, trMs: 50, auMs: 300 }), 6);
  assert.equal(fullEta({ trLeft: 0, auLeft: 0 }), 0);
});

test('storeHash: ses, ton, hız ya da çeviri değişince farklı anahtar', () => {
  const base = { text: 'Merhaba dünya.', voiceKey: 'v1', audioKey: 'real|v1|1|', speed: 1.1, tone: { style: 'calm', pitch: 0, quality: 'normal' } };
  const h = storeHash(base);
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(storeHash({ ...base }), h, 'aynı girdi aynı anahtar');
  for (const patch of [{ text: 'Merhaba dünya!' }, { voiceKey: 'v2' }, { voiceKey: 'v1|2' }, { audioKey: 'real|v1|1.2|' },
    { speed: 1.15 }, { tone: { ...base.tone, pitch: 1 } }, { tone: { ...base.tone, style: 'lively' } }]) {
    assert.notEqual(storeHash({ ...base, ...patch }), h, JSON.stringify(patch));
  }
  assert.notEqual(shortHash('a'), shortHash('b'));
});

test('planEviction: sınır aşılınca en eski video silinir, şimdiki korunur', () => {
  const idx = { videos: { a: { at: 3, bytes: 40 }, b: { at: 1, bytes: 30 }, c: { at: 2, bytes: 20 } } };
  assert.deepEqual(planEviction(idx, { video: 'a', incoming: 10, limit: 100 }), { evict: [], deny: false });
  assert.deepEqual(planEviction(idx, { video: 'a', incoming: 20, limit: 100 }), { evict: ['b'], deny: false });
  assert.deepEqual(planEviction(idx, { video: 'a', incoming: 50, limit: 100 }), { evict: ['b', 'c'], deny: false });
  assert.deepEqual(planEviction(idx, { video: 'a', incoming: 70, limit: 100 }), { evict: ['b', 'c'], deny: true });
  assert.deepEqual(planEviction({ videos: {} }, { video: 'x', incoming: 5, limit: 100 }), { evict: [], deny: false });
});

// Sahte CacheStorage (Map): put/match/delete, Response gövdesi saklanır
function fakeCaches() {
  const stores = new Map();
  return {
    stores,
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        async put(url, res) { m.set(String(url), { body: new Uint8Array(await res.arrayBuffer()), headers: [...res.headers] }); },
        async match(url) { const e = m.get(String(url)); return e ? new Response(e.body, { headers: e.headers }) : undefined; },
        async delete(url) { return m.delete(String(url)); },
      };
    },
    async delete(name) { return stores.delete(name); },
  };
}

test('createAudioStore: yaz, listele, oku; yeni anahtar eskisini siler; kota en eski videoyu siler', async () => {
  const fc = fakeCaches();
  let clock = 0;
  const pcm = new Float32Array(100).fill(0.5); // 200 bayt
  const st = createAudioStore(fc, { limit: 500, now: () => ++clock });
  assert.equal(await st.put('vidA', 0, 'h0', pcm, 22050), true);
  assert.equal(await st.put('vidA', 1, 'h1', pcm, 22050), true);
  assert.deepEqual(await st.list('vidA'), { items: { 0: 'h0', 1: 'h1' }, bytes: 400 });
  const got = await st.get('vidA', 1, 'h1');
  assert.equal(got.sampleRate, 22050);
  assert.equal(Buffer.from(got.pcmBase64, 'base64').length, 200);
  assert.equal(await st.get('vidA', 1, 'other'), null);
  // aynı cümle yeni anahtarla: eski kayıt silinir, boyut aynı kalır
  await st.put('vidA', 1, 'h1b', pcm, 22050);
  assert.equal(await st.get('vidA', 1, 'h1'), null);
  assert.deepEqual((await st.list('vidA')).items, { 0: 'h0', 1: 'h1b' });
  assert.deepEqual(await st.stats(), { videos: 1, entries: 2, bytes: 400 });
  // ikinci video sınırı aşar → en eski (vidA) silinir
  await st.put('vidB', 0, 'b0', pcm, 22050);
  await st.put('vidB', 1, 'b1', pcm, 22050);
  assert.deepEqual(await st.list('vidA'), { items: {}, bytes: 0 });
  assert.equal(fc.stores.get(AUDIO_CACHE).has(entryUrl('vidA', 0, 'h0')), false);
  // şimdiki video tek başına sınırı aşıyorsa yazılmaz (hata)
  await assert.rejects(st.put('vidB', 2, 'b2', new Float32Array(200), 22050), /sınır/);
  // dizin kalıcı: yeni depo nesnesi aynı kayıtları görür
  await st.flush();
  const st2 = createAudioStore(fc, { limit: 500 });
  assert.deepEqual((await st2.list('vidB')).items, { 0: 'b0', 1: 'b1' });
});
