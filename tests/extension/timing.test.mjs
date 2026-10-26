import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateSpeechSec, slotSec, chooseSynthSpeed, fitRate, indexAt, activeIndex, nextDue,
  lastPlayedAfterSeek, windowIndices, maxLateFor, CHARS_PER_SEC, prepStatus,
} from '../../extension/content/timing.js';

test('prepStatus: sıradaki cümlenin beklediği aşama', () => {
  const mk = () => [
    { start: 1, end: 3, tr: null, audio: null },
    { start: 3.2, end: 6, tr: null, audio: null },
    { start: 40, end: 42, tr: null, audio: null },
  ];
  let s = mk();
  assert.deepEqual(prepStatus(s, 0, 30), { phase: 'translate', done: 0, total: 2 });
  s[0].tr = 'a'; s[1].tr = 'b';
  assert.deepEqual(prepStatus(s, 0, 30), { phase: 'synth', done: 0, total: 2 });
  assert.equal(prepStatus(s, 0, 30, { needAudio: false }), null);
  s[0].audio = { url: 'x' };
  assert.equal(prepStatus(s, 0, 30), null);
  // Uzak cümle için bildirim yok
  s = mk();
  assert.equal(prepStatus(s, 20, 30), null);
  assert.equal(prepStatus(s, 38, 30)?.phase, 'translate');
  // Bitmiş cümle sayılmaz
  assert.equal(prepStatus(mk(), 50, 30), null);
});

const S = [
  { start: 1, end: 3, text: 'a' },
  { start: 3.2, end: 6, text: 'b' },
  { start: 10, end: 12, text: 'c' },
  { start: 30, end: 35, text: 'd' },
];

test('estimateSpeechSec', () => {
  assert.equal(estimateSpeechSec('x'.repeat(CHARS_PER_SEC * 2)), 2);
  assert.equal(estimateSpeechSec('x'.repeat(CHARS_PER_SEC * 2), 2), 1);
  assert.equal(estimateSpeechSec(''), 0.4);
});

test('slotSec: sonraki cümleye kadar, en fazla bitiş+0.8', () => {
  assert.ok(Math.abs(slotSec(S, 0) - 2.2) < 1e-9);  // sonraki 3.2'de
  assert.ok(Math.abs(slotSec(S, 1) - 3.6) < 1e-9);  // 6 + 0.8 - 3.2
  assert.ok(Math.abs(slotSec(S, 3) - 5.8) < 1e-9);  // son cümle
  assert.equal(slotSec(S, 99), 0);
  // üst üste binen cümleler: en az bitişe kadar
  assert.equal(slotSec([{ start: 0, end: 4 }, { start: 2, end: 5 }], 0), 4);
});

test('chooseSynthSpeed: sığarsa temel hız, sığmazsa ≤ 1.6', () => {
  const short = 'x'.repeat(14);      // ~1 sn
  const long = 'x'.repeat(14 * 5);   // ~5 sn
  assert.equal(chooseSynthSpeed(short, 3, { base: 1 }), 1);
  assert.equal(chooseSynthSpeed(long, 2, { base: 1 }), 1.6);   // 2.6 gerekirdi
  const mid = chooseSynthSpeed(long, 4, { base: 1 });          // ~1.31
  assert.ok(mid > 1.25 && mid < 1.4, String(mid));
  assert.equal(chooseSynthSpeed(short, 3, { base: 1.2 }), 1.2);
  assert.equal(chooseSynthSpeed(long, 1, { base: 1.8 }), 1.8); // kullanıcı tabanı max'tan büyük
});

test('fitRate: toplam hız 1.6 ile sınırlı, taşma bildirilir', () => {
  assert.deepEqual(fitRate(2, 3, 1), { rate: 1, overflowSec: 0 });
  const a = fitRate(3, 2, 1);
  assert.equal(a.rate, 1.5);
  assert.equal(a.overflowSec, 0);
  const b = fitRate(4, 2, 1.25); // ek oran en fazla 1.6/1.25 = 1.28
  assert.equal(b.rate, 1.28);
  assert.ok(Math.abs(b.overflowSec - (4 / 1.28 - 2)) < 1e-9);
  assert.equal(fitRate(5, 1, 1.6).rate, 1); // zaten max hızda sentezlendi
});

test('indexAt / activeIndex', () => {
  assert.equal(indexAt(S, 0.5), -1);
  assert.equal(indexAt(S, 1), 0);
  assert.equal(indexAt(S, 3.1), 0);
  assert.equal(indexAt(S, 7), 1);
  assert.equal(indexAt(S, 100), 3);
  assert.equal(indexAt([], 5), -1);
  assert.equal(activeIndex(S, 2), 0);
  assert.equal(activeIndex(S, 6.2), 1);   // bitişten sonra kısa kalır
  assert.equal(activeIndex(S, 8), -1);
});

test('nextDue: sıradaki, gecikme sınırı ve atlama', () => {
  assert.deepEqual(nextDue(S, 0.5, -1), { index: -1, late: 0, skipped: [] });
  const a = nextDue(S, 1.1, -1);
  assert.equal(a.index, 0);
  assert.ok(Math.abs(a.late - 0.1) < 1e-9);
  // 0 çalındı, 1 başlamış ve geç değil
  assert.equal(nextDue(S, 3.5, 0).index, 1);
  // 10.5'te: 1 çok geç (atlanır), 2 uygun
  const c = nextDue(S, 10.5, 0);
  assert.deepEqual(c.skipped, [1]);
  assert.equal(c.index, 2);
  // gecikme sınırı 1.2..4 sn
  assert.ok(maxLateFor(S, 0) >= 1.2 && maxLateFor(S, 3) <= 4);
});

test('lastPlayedAfterSeek: sarma sonrası geçmiş cümleler atlanır', () => {
  assert.equal(lastPlayedAfterSeek(S, 10.3), 1);  // 2 (10.0) tolerans içinde → çalınacak
  assert.equal(lastPlayedAfterSeek(S, 11.5), 2);
  assert.equal(lastPlayedAfterSeek(S, 0), -1);
});

test('windowIndices: ileri-bakış penceresi', () => {
  assert.deepEqual(windowIndices(S, 0, 30), [0, 1, 2]);
  assert.deepEqual(windowIndices(S, 4, 30), [1, 2, 3]);
  assert.deepEqual(windowIndices(S, 7, 30), [2, 3]);
  assert.deepEqual(windowIndices(S, 0, 30, (s) => s.text !== 'b'), [0, 2]);
  assert.deepEqual(windowIndices(S, 40, 30), []);
});
