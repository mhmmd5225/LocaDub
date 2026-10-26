// node --test tokenizer.test.mjs   (needs tests/mt/.models/tc-big-en-tr/source.spm + vocab.json)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MarianTokenizer, parseSpmModel } from '../../extension/engines/mt/spm.js';
import { prepareBatch } from '../../extension/engines/mt/preprocess.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '.models', 'tc-big-en-tr');
const have = existsSync(join(dir, 'source.spm'));

test('source.spm parses as a unigram model', { skip: !have && 'model files not downloaded' }, () => {
  const m = parseSpmModel(readFileSync(join(dir, 'source.spm')));
  assert.equal(m.modelType, 1);
  assert.equal(m.byteFallback, false);
  assert.ok(m.pieces.length > 30000);
  assert.equal(m.types[m.unkId], 2);
});

test('Marian ids: </s> at the end, round trip, few <unk>', { skip: !have && 'model files not downloaded' }, () => {
  const vocab = JSON.parse(readFileSync(join(dir, 'vocab.json'), 'utf8'));
  const tok = new MarianTokenizer(readFileSync(join(dir, 'source.spm')), vocab);
  assert.equal(tok.eos, 43741);
  assert.equal(tok.unk, 52508);
  assert.equal(tok.pad, 57059);
  const texts = [
    'Hello everyone, and welcome back to my channel.',
    "So what I'm going to do is open up the terminal.",
    'The new update improves battery life by up to 20 percent!',
    'Some “quotes” and 3.14 numbers?',
    'Tokenization of supercalifragilisticexpialidocious words.',
  ];
  for (const t of texts) {
    const ids = tok.encode(t);
    assert.equal(ids.at(-1), tok.eos);
    assert.ok(!ids.includes(tok.unk), `unk in ${t}`);
    assert.equal(tok.decode(ids), t.normalize('NFKC'));
  }
  // Accents/dashes outside the vocabulary are mapped by preprocess.js, so no <unk> remains.
  const { units } = prepareBatch(['Café, naïve résumé — great… really'])
  assert.equal(units[0], 'Cafe, naive resume - great... really.');
  assert.ok(!tok.encode(units[0]).includes(tok.unk));
  // An unknown script collapses into a single <unk>.
  const ids = tok.encode('hello 😀😀 world');
  assert.equal(ids.filter((i) => i === tok.unk).length, 1);
});
