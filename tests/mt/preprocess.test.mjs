// node --test preprocess.test.mjs   (no model needed)
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, analyze, prepareBatch, finishBatch, chunkLong, tidyTurkish } from '../../extension/engines/mt/preprocess.js';
import { repetitionCut } from '../../extension/engines/mt/marian.js';
import { keptRanges } from '../../extension/engines/mt/onnx-patch.js';

test('ASR text becomes sentence-like', () => {
  assert.equal(cleanText("so what i'm gonna do is open the terminal"), "So what I'm going to do is open the terminal.");
  assert.equal(cleanText('um so basically the the idea is simple'), 'So basically the idea is simple.');
  assert.equal(cleanText('do you know what happens'), 'Do you know what happens?');
  assert.equal(cleanText('how much does it cost'), 'How much does it cost?');
  assert.equal(cleanText('what i mean is this'), 'What I mean is this.');
  assert.equal(cleanText('Already fine.'), 'Already fine.');
  assert.equal(cleanText('trailing comma,'), 'Trailing comma.');
  assert.equal(cleanText('uh'), '');
  assert.equal(cleanText('I know that that is true'), 'I know that that is true.');
});

test('tags, music and markers', () => {
  const { units, plan } = prepareBatch(['[Music]', '[Applause] thank you', '', '>> hello there', '♪ la la ♪', '[ __ ] this', '[door creaks]', 'the (laughs) end', '♪♪', '[BLANK_AUDIO]', 'a (very) big deal']);
  assert.deepEqual(units, ['Thank you.', 'Hello there.', 'La la.', 'This.', 'Door creaks', 'The.', 'End.', 'A (very) big deal.']);
  const out = finishBatch(plan, ['Teşekkürler.', 'Merhaba.', 'La la.', 'Bu.', 'kapı gıcırdıyor.', 'Bu.', 'Son.', 'Çok büyük bir şey.']);
  assert.deepEqual(out, ['[Müzik]', '[Alkış] Teşekkürler.', '', 'Merhaba.', '♪ La la. ♪', 'Bu.', '[Kapı gıcırdıyor]', 'Bu. [Gülüyor] Son.', '♪', '', 'Çok büyük bir şey.']);
});

test('same length and order, empty in → empty out', () => {
  const input = ['', '   ', 'hello', 'hello'];
  const { units, plan } = prepareBatch(input);
  assert.deepEqual(units, ['Hello.']);
  assert.deepEqual(finishBatch(plan, ['Merhaba.']), ['', '', 'Merhaba.', 'Merhaba.']);
});

test('long runs are chunked', () => {
  const words = Array.from({ length: 100 }, (_, i) => (i % 20 === 19 ? 'and' : `w${i}`)).join(' ');
  const chunks = chunkLong(words);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.split(' ').length <= 45));
  assert.equal(chunks.join(' '), words);
});

test('turkish tidy + helpers', () => {
  assert.equal(tidyTurkish('istanbul ’a gidiyoruz .'), "İstanbul 'a gidiyoruz.");
  assert.equal(repetitionCut([1, 2, 3, 3, 3, 3]), 3);
  assert.equal(repetitionCut([5, 1, 2, 1, 2, 1, 2, 1, 2]), 3);
  assert.equal(repetitionCut([1, 2, 3, 4]), 0);
  assert.deepEqual(keptRanges(100, [[10, 50]]), [[0, 10], [50, 100]]);
  assert.ok(analyze('x').parts.length === 1);
});
