// common/glossary.js: kural ayrıştırma ve uygulama.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGlossary, applyGlossary } from '../../extension/common/glossary.js';

const apply = (rules, text) => applyGlossary(text, parseGlossary(rules));

test('tam sözcük, büyük-küçük harf duyarsız, Türkçe I/İ', () => {
  assert.equal(apply('istanbul => İstanbul', 'İSTANBUL ve istanbul, Istanbullu değil'), 'İstanbul ve İstanbul, Istanbullu değil');
  assert.equal(apply('ılık => serin', 'ILIK su'), 'serin su');
});

test('kesme işaretli ek: sözcük sınırı', () => {
  assert.equal(apply('GPT => ci pi ti', "GPT'yi ve GPTX'i"), "ci pi ti'yi ve GPTX'i");
});

test('* ile ekleri korur', () => {
  assert.equal(apply('zeka* => zekâ*', 'Yapay zekanın zekası, zekâ değil'), 'Yapay zekânın zekâsı, zekâ değil');
});

test('sözcük grupları, çoklu boşluk ve öncelik', () => {
  const rules = 'zeka => akıl\nyapay zeka => yapay zekâ';
  assert.equal(apply(rules, 'yapay  zeka ve zeka'), 'yapay zekâ ve akıl');
});

test('yorum, boş ve bozuk satırlar atlanır; özel karakterler güvenli', () => {
  const rules = '# yorum\n\nbozuk satır\nC++ => si artı artı\nfiyat => $5';
  assert.equal(parseGlossary(rules).length, 2);
  assert.equal(apply(rules, 'C++ öğreniyorum, fiyat yüksek'), 'si artı artı öğreniyorum, $5 yüksek');
});

test('kural yoksa metin aynen döner', () => {
  assert.equal(apply('', 'Merhaba'), 'Merhaba');
  assert.equal(applyGlossary(null, []), '');
});
