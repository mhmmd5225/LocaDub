// Hata günlüğü (common/errlog.js): tekrar bastırma, anahtar sınırı, yazıcı, ileti özeti.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logError, setErrorSink, describeError, shouldLog, _resetErrorLog } from '../../extension/common/errlog.js';

test('describeError: ileti, metin, boş; tek satır ve 300 karakter', () => {
  assert.equal(describeError(new Error('bağlantı\n koptu')), 'bağlantı koptu');
  assert.equal(describeError('düz metin'), 'düz metin');
  assert.equal(describeError(undefined), 'bilinmeyen hata');
  assert.equal(describeError(new Error('x'.repeat(900))).length, 300);
});

test('shouldLog: pencere içinde bastırır, sonra yeniden izin verir; anahtar sayısı sınırlı', () => {
  const m = new Map();
  assert.equal(shouldLog(m, 'a', 1000), true);
  assert.equal(shouldLog(m, 'a', 5000), false);
  assert.equal(shouldLog(m, 'b', 5000), true);
  assert.equal(shouldLog(m, 'a', 11001), true, '10 sn sonra');
  const big = new Map();
  for (let i = 0; i < 500; i++) shouldLog(big, 'k' + i, 100 + i, 10000, 100);
  assert.ok(big.size <= 100, String(big.size));
});

test('logError: yazıcıya (alan, ileti) gider; aynı hata 10 sn içinde bir kez; farklı alan ayrı', () => {
  _resetErrorLog();
  const got = [];
  setErrorSink((s, m) => got.push([s, m]));
  assert.equal(logError('ses yakalama', new Error('boom'), { now: 1000 }), true);
  assert.equal(logError('ses yakalama', new Error('boom'), { now: 2000 }), false);
  assert.equal(logError('altyazı indirme', new Error('boom'), { now: 2000 }), true);
  assert.equal(logError('ses yakalama', 'başka', { now: 3000 }), true);
  assert.equal(logError('ses yakalama', new Error('boom'), { now: 12000 }), true);
  assert.deepEqual(got, [['ses yakalama', 'boom'], ['altyazı indirme', 'boom'], ['ses yakalama', 'başka'], ['ses yakalama', 'boom']]);
  setErrorSink(null);
  assert.doesNotThrow(() => logError('x', 'y', { now: 99999 }));
});

test('logError: chrome yokken (Node) varsayılan yazıcı sessiz kalır', () => {
  _resetErrorLog();
  assert.doesNotThrow(() => logError('node', 'yok', { now: 1 }));
});
