// engines/mt/restore.js (kurallar) ve engines/mt/punct.js (model çıktısının çözümü; sahte belirteçleyiciyle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksAsr, restoreRules } from '../../extension/engines/mt/restore.js';
import { decode, tidyCase, tokenizeWords } from '../../extension/engines/mt/punct.js';

test('looksAsr: yalnızca küçük harfli ve noktalamasız metin', () => {
  assert.equal(looksAsr("so what i'm gonna do"), true);
  assert.equal(looksAsr('So what I am going to do.'), false);
  assert.equal(looksAsr('so, what'), false);
  assert.equal(looksAsr('123 456'), false);
});

test('restoreRules: i ve kısaltmaları, cümle başı, son nokta', () => {
  assert.equal(restoreRules("so i think i'm right and i'll go"), "So I think I'm right and I'll go.");
  assert.equal(restoreRules('the iphone is in it'), 'The iphone is in it.');
  assert.equal(restoreRules('Already Punctuated.'), 'Already Punctuated.');
  assert.equal(restoreRules(''), '');
});

test('tidyCase: kısaltmalar korunur, karışık büyük harf düzelir', () => {
  assert.deepEqual(['BrEAkING', 'NASA', 'U.S.', 'mEtacomet', "I'm", 'JO25'].map(tidyCase),
    ['Breaking', 'NASA', 'U.S.', 'metacomet', "I'm", 'JO25']);
});

// Sahte belirteçleyici: her sözcük "▁" + ilk iki harf ve kalanı olarak iki parçaya bölünür; "🙂" tanınmaz.
function fakeTok() {
  const pieces = ['<unk>'];
  const idOf = (p) => { let i = pieces.indexOf(p); if (i < 0) { pieces.push(p); i = pieces.length - 1; } return i; };
  return {
    unkId: 0,
    piece: (id) => pieces[id],
    encode: (w) => (w === '🙂' ? [0] : w.length > 2 ? [idOf('▁' + w.slice(0, 2)), idOf(w.slice(2))] : [idOf('▁' + w)]),
  };
}

test('decode: noktalama, büyük harf ("▁" kayması dahil), kısaltma, cümle sınırı, tanınmayan sözcük', () => {
  const tok = fakeTok();
  const enc = tokenizeWords(tok, 'the us team won 🙂 we cheered');
  // parçalar: 0 ▁th · 1 e · 2 ▁us · 3 ▁te · 4 am · 5 ▁wo · 6 n · 7 🙂(unk) · 8 ▁we · 9 ▁ch · 10 eered
  assert.equal(enc.ids.length, 11);
  const z = (n) => new Array(n).fill(0);
  const pred = { post: z(11), seg: z(11), cap: enc.ids.map((id) => z([...tok.piece(id)].length)) };
  pred.post[2] = 1; // <ACRONYM>
  pred.post[7] = 2; pred.seg[7] = 1; // "." + cümle sonu (tanınmayan sözcükte de)
  pred.post[10] = 2; pred.seg[10] = 1;
  pred.cap[0] = [0, 1, 0]; // "▁th": büyük harf "t"de ("▁" de sayılır)
  pred.cap[2] = [0, 1, 1]; // "US"
  pred.cap[8] = [0, 1, 0]; // "We"
  assert.deepEqual(decode(tok, enc, pred), ['The U.S. team won 🙂.', 'We cheered.']);
});
