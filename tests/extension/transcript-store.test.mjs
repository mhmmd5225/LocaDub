// common/transcript-store.js: sahte chrome.storage.local ile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_VIDEOS, loadTranscript, loadTranscriptEntry, saveTranscript, clearTranscripts, transcriptStats, transcriptKey,
} from '../../extension/common/transcript-store.js';

class FakeStorage {
  constructor() { this.data = new Map(); }
  async get(keys) {
    if (keys === null) return Object.fromEntries(this.data);
    const out = {};
    for (const k of [].concat(keys)) if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
    return out;
  }
  async set(obj) { for (const [k, v] of Object.entries(obj)) this.data.set(k, structuredClone(v)); }
  async remove(keys) { for (const k of [].concat(keys)) this.data.delete(k); }
}

const S = [
  { start: 0, end: 2, text: 'Hello.', tr: 'Merhaba.', audio: { url: 'blob:x' }, trPending: false, i: 0 },
  { start: 2, end: 4, text: 'Bye.', tr: null, i: 1 },
];

test('kaydet ve oku: yalnızca gerekli alanlar saklanır', async () => {
  const st = new FakeStorage();
  await saveTranscript(st, 'vid1', 'real|opus-mt', S);
  assert.deepEqual(await loadTranscript(st, 'vid1', 'real|opus-mt'), [
    { start: 0, end: 2, text: 'Hello.', tr: 'Merhaba.' },
    { start: 2, end: 4, text: 'Bye.', tr: null },
  ]);
  assert.equal(await loadTranscript(st, 'vid1', 'real|chrome-translator'), null);
  assert.equal(await loadTranscript(st, 'vid2', 'real|opus-mt'), null);
});

test('LRU: en eski video düşer, okunan video tazelenir', async () => {
  const st = new FakeStorage();
  for (let i = 0; i < MAX_VIDEOS; i++) await saveTranscript(st, 'v' + i, 'k', S);
  await loadTranscript(st, 'v0', 'k'); // v0 en yeni olur
  await saveTranscript(st, 'yeni', 'k', S);
  assert.ok(st.data.has(transcriptKey('v0', 'k')));
  assert.ok(!st.data.has(transcriptKey('v1', 'k')));
  assert.equal((await transcriptStats(st)).videos, MAX_VIDEOS);
});

test('temizle: yalnızca çeviri önbelleği silinir', async () => {
  const st = new FakeStorage();
  await st.set({ enabled: true });
  await saveTranscript(st, 'a', 'k', S);
  await saveTranscript(st, 'b', 'k', S);
  assert.equal(await clearTranscripts(st), 2);
  assert.deepEqual([...st.data.keys()], ['enabled']);
});

test('boş liste kaydedilmez', async () => {
  const st = new FakeStorage();
  await saveTranscript(st, 'a', 'k', []);
  assert.equal(st.data.size, 0);
});

test('altyazı türü saklanır; eski kayıtlarda "manual" sayılır', async () => {
  const st = new FakeStorage();
  await saveTranscript(st, 'asrvideo', 'k', S, 'asr');
  assert.equal((await loadTranscriptEntry(st, 'asrvideo', 'k')).kind, 'asr');
  await saveTranscript(st, 'manvideo', 'k', S);
  assert.equal((await loadTranscriptEntry(st, 'manvideo', 'k')).kind, 'manual');
  // türü olmayan eski kayıt (B1 sürümü)
  await st.set({ [transcriptKey('old', 'k')]: { savedAt: 1, sentences: [{ start: 0, end: 1, text: 'a', tr: null }] } });
  assert.equal((await loadTranscriptEntry(st, 'old', 'k')).kind, 'manual');
  assert.equal((await loadTranscript(st, 'old', 'k')).length, 1);
});
