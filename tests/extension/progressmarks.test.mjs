// Oynatıcı çubuğunda dublaj işaretleri (content/progressmarks.js): saf aralık hesabı.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSpans, dubRanges, toPercent } from '../../extension/content/progressmarks.js';

test('mergeSpans: sıralar, boşluk içindekileri birleştirir, boş/ters aralıkları atar', () => {
  assert.deepEqual(mergeSpans([[6, 8], [0, 2], [2.5, 4]], 1.5), [[0, 4], [6, 8]]);
  assert.deepEqual(mergeSpans([[5, 7], [0, 2], [2.5, 4]], 1.5), [[0, 7]], '4 ile 5 arası 1 sn ≤ 1.5');
  assert.deepEqual(mergeSpans([[0, 2], [4, 6]], 1.5), [[0, 2], [4, 6]], 'boşluk 2 sn > 1.5');
  assert.deepEqual(mergeSpans([[3, 3], [4, 2], [1, 2]], 1.5), [[1, 2]]);
  assert.deepEqual(mergeSpans([], 1.5), []);
});

test('dubRanges: sesi üretilmiş / hazır → dubbed; yalnız çevrilmiş → translated; başarısız ve boş atlanır', () => {
  const S = [
    { start: 0, end: 2, tr: 'a', audio: { url: 'blob:x' } },       // hazır
    { start: 2.5, end: 4, tr: 'b', audio: null, dubbed: true },    // bir kez üretilmiş, bellekten atılmış
    { start: 10, end: 12, tr: 'c', audio: null },                  // yalnız çevrilmiş
    { start: 12.5, end: 14, tr: 'd', audio: null },                // yalnız çevrilmiş
    { start: 20, end: 22, tr: 'e', audio: null, auFailed: true },  // ses üretilemedi
    { start: 30, end: 32, tr: '', audio: null },                   // çevirisi boş
    { start: 40, end: 40, tr: 'f', audio: { empty: true } },       // süresiz
    { start: 50, end: 52, tr: null, audio: null },                 // henüz çevrilmemiş
    { start: 60, end: 62, tr: 'g', audio: { empty: true, voice: 'x' } }, // boş ses de "yapıldı" sayılır
  ];
  const r = dubRanges(S);
  assert.deepEqual(r.dubbed, [[0, 4], [60, 62]]);
  assert.deepEqual(r.translated, [[10, 14]]);
});

test('toPercent: süreye göre yüzde; geçersiz süre boş; sınırlar kırpılır; sıfır genişlik atılır', () => {
  assert.deepEqual(toPercent([[0.3, 6.5]], 16), [[1.88, 38.75]]);
  assert.deepEqual(toPercent([[0, 10]], 0), []);
  assert.deepEqual(toPercent([[0, 10]], Infinity), []);
  assert.deepEqual(toPercent([[90, 120]], 100), [[90, 10]], 'süreyi aşan kırpılır');
  assert.deepEqual(toPercent([[5, 5.0001]], 1000000), [], 'görünmeyecek kadar ince');
});
