// Pure unit tests of the Turkish normalization (no models needed): node --test unit/
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, respellEnglish } from '../../../extension/engines/tts/normalize.js';
import { splitText, speedPlan } from '../../../extension/engines/tts/core.js';
import { timeStretch, downsample2, trimSilence, encodeWav } from '../../../extension/engines/tts/dsp.js';

const cases = {
  integers: [
    ['Bu yıl 2024.', 'Bu yıl iki bin yirmi dört.'],
    ['1.250 kişi geldi.', 'bin iki yüz elli kişi geldi.'],
    ['3 milyar insan', 'üç milyar insan'],
    ['Toplam 1.000.000 izlenme', 'Toplam bir milyon izlenme'],
  ],
  decimals: [
    ['3,5 kg', 'üç buçuk kilogram'],
    ['Oran 2,75 oldu.', 'Oran iki virgül yetmiş beş oldu.'],
  ],
  ordinals: [
    ['3. bölüm', 'üçüncü bölüm'],
    ['21. yüzyıl', 'yirmi birinci yüzyıl'],
    ['1st place', 'birinci place'],
    ['4th', 'dördüncü'],
  ],
  percent: [
    ['%20 indirim', 'yüzde yirmi indirim'],
    ["%12,5'lik artış", 'yüzde on iki buçukluk artış'],
  ],
  time: [
    ["Saat 14:30'da", 'Saat on dört otuzda'],
    ['09:05', 'dokuz sıfır beş'],
    ['3 PM', 'öğleden sonra üç'],
  ],
  money: [
    ['1.250 TL', 'bin iki yüz elli lira'],
    ['19,99 $', 'on dokuz dolar doksan dokuz sent'],
    ['$5', 'beş dolar'],
    ['12,75 €', 'on iki avro yetmiş beş sent'],
  ],
  abbreviations: [
    ['Dr. Ayşe', 'doktor Ayşe'],
    ['elma, armut vb. meyveler', 'elma, armut ve benzeri meyveler'],
    ['Prof. Dr. Ali', 'profesör doktor Ali'],
  ],
  english: [
    ['NASA ve AI', 'nasa ve ey ay'],
    ['GPU ve CPU', 'ci pi yu ve si pi yu'],
    ['Elon Musk', 'İlon Mask'],
    ['YouTube kanalı', 'Yutub kanalı'],
    ['2,500 people', 'iki bin beş yüz people'],
  ],
  subtitles: [
    ['[Music] Merhaba', 'Merhaba'],
    ['>> Evet ♪', 'Evet'],
  ],
};

for (const [group, list] of Object.entries(cases)) {
  test(`normalize: ${group}`, () => {
    for (const [input, expected] of list) assert.equal(normalizeText(input), expected, `input: ${input}`);
  });
}

test('normalize: no digits survive', () => {
  for (const s of ['Saat 9.15', 'TR42 ve 5G', 'COVID-19 2020-2021 arası', '1/3 oranında', 'x 2,5 y'])
    assert.doesNotMatch(normalizeText(s), /\d/, s);
});

test('normalize: Turkish words with English-looking letters are left alone', () => {
  for (const w of ['Fethiye', 'ishal', 'tashih', 'teyze', 'ideal', 'kreatif', 'saat', 'koordinat'])
    assert.equal(normalizeText(w), w);
});

test('normalize: empty and odd input never throws', () => {
  assert.equal(normalizeText(''), '');
  assert.equal(normalizeText(null), '');
  assert.equal(typeof normalizeText('🙂 ### ...'), 'string');
});

test('respellEnglish', () => {
  assert.equal(respellEnglish('Brooklyn'), 'Bruklin');
  assert.equal(respellEnglish('Knight'), 'Nayt');
  assert.equal(respellEnglish('Matthew'), 'Matyu');
});

test('splitText: packs sentences, splits long ones at clauses', () => {
  const long = Array.from({ length: 30 }, (_, i) => `kelime${i}`).join(' ') + ', ' + 'son kısım burada.';
  const parts = splitText(`Kısa bir cümle. İkinci cümle. ${long}`, 80);
  assert.ok(parts.length >= 2);
  for (const [p] of parts) assert.ok(p.length <= 80, p);
  assert.equal(parts[0][0], 'Kısa bir cümle. İkinci cümle.');
  assert.equal(parts.at(-1)[1], 0);
});

test('speedPlan: native up to 1.6, rest stretched', () => {
  assert.deepEqual(speedPlan(1), { speed: 1, native: 1, model: 1, stretch: 1 });
  assert.equal(speedPlan(1.4).native, 1.4);
  const p = speedPlan(2);
  assert.equal(p.native, 1.6);
  assert.ok(Math.abs(p.stretch - 1.25) < 1e-9);
  assert.equal(speedPlan(0.1).speed, 0.5);
});

test('dsp: timeStretch shortens by the factor, downsample2 halves, trim/wav sane', () => {
  const rate = 48000;
  const x = new Float32Array(rate).map((_, i) => Math.sin((2 * Math.PI * 200 * i) / rate) * 0.5);
  const y = timeStretch(x, 1.5, rate);
  assert.ok(Math.abs(y.length / x.length - 1 / 1.5) < 0.05, `ratio ${y.length / x.length}`);
  assert.equal(downsample2(x).length, rate / 2);
  const padded = new Float32Array(rate * 2);
  padded.set(x, rate / 2);
  assert.ok(trimSilence(padded, rate).length < rate * 1.2);
  assert.equal(encodeWav(x, rate).length, 44 + x.length * 2);
});
