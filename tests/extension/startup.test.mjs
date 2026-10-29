// Başlangıç hızlandırması: ilk cümleye kadar bekletme, çeviri grubu boyu, çeviri iş parçacıkları, tanılama süreleri.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldHold, trBatchSize, HOLD_HORIZON_SEC } from '../../extension/content/timing.js';
import { defaultThreads } from '../../extension/engines/mt/opus-mt.js';
import { normalizeSettings } from '../../extension/common/settings.js';
import { buildReport } from '../../extension/common/diagnostics.js';

const S = (...xs) => xs.map(([start, end, extra = {}], i) => ({ i, start, end, text: `s${i}`, tr: null, audio: null, ...extra }));

test('shouldHold: altyazı yokken ve yakındaki ilk cümle hazır değilken bekletir', () => {
  assert.equal(shouldHold([], 0, { loaded: false }), true);
  const s = S([0.5, 3], [4, 6]);
  assert.equal(shouldHold(s, 0, { loaded: true }), true, 'çeviri yok');
  s[0].tr = 'merhaba';
  assert.equal(shouldHold(s, 0, { loaded: true }), true, 'ses yok');
  assert.equal(shouldHold(s, 0, { loaded: true, needAudio: false }), false, 'sistem sesi: çeviri yeter');
  s[0].audio = { url: 'blob:x' };
  assert.equal(shouldHold(s, 0, { loaded: true }), false);
  // sesi üretilemeyen ya da boş çevrilen cümle beklenmez
  const f = S([0.5, 3, { tr: 'x', auFailed: true }]);
  assert.equal(shouldHold(f, 0, { loaded: true }), false);
  assert.equal(shouldHold(S([0.5, 3, { tr: '' }]), 0, { loaded: true }), false);
});

test('shouldHold: uzaktaki ilk cümle ve biten video için video durmaz', () => {
  const far = S([HOLD_HORIZON_SEC + 5, HOLD_HORIZON_SEC + 8]);
  assert.equal(shouldHold(far, 0, { loaded: true }), false);
  assert.equal(shouldHold(far, 6, { loaded: true }), true, 'cümleye yaklaşınca bekletir');
  assert.equal(shouldHold(S([0, 2]), 30, { loaded: true }), false);
});

test('trBatchSize: ilk grup 2, yakın cümleler küçük, uzaktakiler büyük grup', () => {
  assert.equal(trBatchSize({ start: 0 }, 0, { first: true }), 2);
  assert.equal(trBatchSize({ start: 5 }, 0), 3);
  assert.equal(trBatchSize({ start: 25 }, 0), 8);
  assert.equal(trBatchSize(undefined, 0), 8);
});

test('çeviri iş parçacıkları: çekirdeklerin yarısı, en çok 4, izolasyon yoksa 1', () => {
  assert.equal(defaultThreads(2, true), 1);
  assert.equal(defaultThreads(4, true), 2);
  assert.equal(defaultThreads(16, true), 4);
  assert.equal(defaultThreads(8, false), 1);
  assert.equal(defaultThreads(0, true), 1, 'çekirdek sayısı bilinmiyorsa 2 sayılır');
});

test('holdStart varsayılan açık; tanılama raporu başlangıç sürelerini gösterir', () => {
  assert.equal(normalizeSettings({}).holdStart, true);
  assert.equal(normalizeSettings({ holdStart: 0 }).holdStart, false);
  const text = buildReport({
    version: '0.4.0', browser: 'Chrome', platform: 'Linux', settings: normalizeSettings({}), now: 0,
    timings: [{ at: 0, line: 'aktif 9.9 sn (altyazı 0.1 sn, çeviri motoru 7.8 sn)' }],
  });
  assert.match(text, /\[Başlangıç süreleri \(1\)\]\n1970-01-01T00:00:00Z aktif 9\.9 sn/);
  assert.match(text, /holdStart: true/);
  assert.match(buildReport({ version: 'x', browser: 'b', platform: 'p', settings: {} }), /\[Başlangıç süreleri \(0\)\]\nyok/);
});
