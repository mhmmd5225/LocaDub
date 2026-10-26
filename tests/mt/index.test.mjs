// node --test index.test.mjs — the public API (extension/engines/mt/index.js) with a fake Chrome
// Translator API, so the contract (order, length, empty input, backend choice, caching) is checked
// without a browser or a model.
import test from 'node:test';
import assert from 'node:assert/strict';

let calls = 0;
globalThis.Translator = class {
  static async availability({ sourceLanguage, targetLanguage }) {
    return sourceLanguage === 'en' && targetLanguage === 'tr' ? 'available' : 'unavailable';
  }
  static async create() { return new Translator(); }
  async translate(t) { calls++; return `TR(${t})`; }
  destroy() {}
};

const mt = await import('../../extension/engines/mt/index.js');

test('listBackends puts an available chrome-translator first', async () => {
  const list = await mt.listBackends();
  assert.deepEqual(list.map((b) => b.id), ['chrome-translator', 'opus-mt']);
  assert.equal(list[0].available, true);
  assert.equal(list[1].sizeMB, 300);
});

test('auto init + translateBatch keeps length/order', async () => {
  assert.deepEqual(await mt.init({}), { backend: 'chrome-translator' });
  assert.deepEqual(mt.status(), { ready: true, backend: 'chrome-translator' });
  const out = await mt.translateBatch(['hello world', '', '[Music]', 'hello world', 'is it raining']);
  assert.deepEqual(out, ['TR(Hello world.)', '', '[Müzik]', 'TR(Hello world.)', 'TR(Is it raining?)']);
  assert.equal(calls, 2);
  await mt.translateBatch(['hello world']);
  assert.equal(calls, 2, 'cached');
  assert.deepEqual(await mt.translateBatch([]), []);
});

test('abort before start rejects', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(mt.translateBatch(['x'], { signal: ac.signal }), { name: 'AbortError' });
  await mt.dispose();
  assert.equal(mt.status().ready, false);
});
