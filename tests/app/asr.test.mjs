// Web sürümünün konuşma tanıma yardımcıları (site/app/asr.js): pencereleme, zaman eşleme, kapsama.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SR, Coverage, Segmenter, chunksToCues, quietestCut, speechOnset } from '../../site/app/asr.js';

// sn cinsinden [başla, bitir) aralıklarında 0.3 genlikli ton, gerisi sessiz.
function tone(sec, spans) {
  const a = new Float32Array(Math.round(sec * SR));
  for (const [s, e] of spans) for (let i = Math.round(s * SR); i < Math.round(e * SR); i++) a[i] = 0.3 * Math.sin(i / 3);
  return a;
}

test('Coverage: birleştirme ve sorgu', () => {
  const c = new Coverage();
  c.add(0, 10);
  c.add(11, 20);
  c.add(40, 50);
  assert.deepEqual(c.list, [[0, 20], [40, 50]]);
  assert.equal(c.until(5), 20);
  assert.equal(c.until(30), -1);
  assert.equal(c.until(39), 50);
  assert.equal(c.until(38), -1);
});

test('quietestCut sessiz bölgeyi bulur', () => {
  const a = tone(20, [[0, 9], [10, 20]]);
  const cut = quietestCut(a, 5 * SR, 15 * SR) / SR;
  assert.ok(cut > 9 && cut < 10, String(cut));
});

test('speechOnset konuşmanın başladığı anı bulur', () => {
  const a = tone(5, [[2, 4]]);
  assert.ok(Math.abs(speechOnset(a, 0) - 2) < 0.1);
  assert.equal(speechOnset(tone(5, []), 1), 1);
});

test('chunksToCues: video zamanı, hız ve uydurma kalıpları', () => {
  const cues = chunksToCues([
    { start: 1, end: 3, text: ' Hello there. ' },
    { start: 3, end: 4, text: 'Thank you.' },
    { start: 4, end: null, text: 'Last words' },
  ], 100, 1.25, 8);
  assert.deepEqual(cues, [
    { start: 101250, end: 103750, text: 'Hello there.' },
    { start: 105000, end: 110000, text: 'Last words' },
  ]);
});

test('Segmenter: sessizlikte keser, sarmada pencereyi kapatır', () => {
  const wins = [];
  const seg = new Segmenter((w) => wins.push(w));
  const a = tone(30, [[0, 15], [15.6, 30]]);
  const block = 4096;
  for (let i = 0; i < a.length; i += block) seg.push(a.subarray(i, i + block), i / SR, 1);
  // 15. saniyeden sonraki sessizlikte kesilmiş olmalı
  assert.equal(wins.length, 1);
  assert.ok(wins[0].audio.length / SR > 15 && wins[0].audio.length / SR < 16);
  // ileri sarma: önceki pencere kapanır, yenisi 200. saniyeden başlar
  seg.push(tone(2, [[0, 2]]), 200, 1); // > 5 sn sıçrama
  assert.equal(wins.length, 2);
  assert.equal(wins[0].startVideo, 0);
  assert.ok(Math.abs(wins[1].startVideo - wins[0].audio.length / SR) < 0.01);
  seg.flush();
  assert.equal(wins[2].startVideo, 200);
});
