// Konuşanın cinsiyeti (content/gender.js) ve favori ses/ton (common/settings.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { estimateF0, genderOf, GenderTracker, predictGender, turnGender, MIN_VOICED } from '../../extension/content/gender.js';
import {
  normalizeSettings, normalizeFavorite, genderVoice, genderVoiceList, chooseVoice, toneFor, voicesInUse, voiceGender,
} from '../../extension/common/settings.js';

const RATE = 48000;
const FRAME = 2048;
// Konuşmaya benzer harmonikli ses (temel + 4 harmonik, azalan genlik)
const voiced = (hz, n = FRAME, rate = RATE) => Float32Array.from({ length: n }, (_, i) => {
  let v = 0;
  for (let h = 1; h <= 5; h++) v += Math.sin((2 * Math.PI * hz * h * i) / rate) / h;
  return 0.2 * v;
});

test('estimateF0: harmonikli seste temel frekans, sessizlik ve gürültüde 0', () => {
  for (const hz of [95, 120, 150, 190, 220, 260]) {
    const f = estimateF0(voiced(hz), RATE);
    assert.ok(Math.abs(f - hz) / hz < 0.03, `${hz} Hz → ${f}`);
  }
  assert.equal(estimateF0(new Float32Array(FRAME), RATE), 0);
  let seed = 1;
  const noise = Float32Array.from({ length: FRAME }, () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.5);
  assert.equal(estimateF0(noise, RATE), 0);
});

test('genderOf: erkek < 155 Hz < belirsiz < 170 Hz < kadın', () => {
  assert.equal(genderOf(120), 'male');
  assert.equal(genderOf(160), null);
  assert.equal(genderOf(210), 'female');
  assert.equal(genderOf(0), null);
});

test('GenderTracker: aralık ortancası, az örnekte ölçüm yok, oktav hataları ayıklanır', () => {
  const g = new GenderTracker();
  for (let i = 0; i < 30; i++) g.push(10 + i * 0.05, i % 7 === 0 ? 240 : 120); // ara sıra oktav atlaması
  assert.deepEqual(g.measure(10, 12), { hz: 120, gender: 'male' });
  assert.equal(g.measure(20, 22), null, 'örnek yok');
  const few = new GenderTracker();
  for (let i = 0; i < MIN_VOICED - 1; i++) few.push(i * 0.05, 220);
  assert.equal(few.measure(0, 10), null);
  few.push(0, 0); // ötümsüz çerçeve sayılmaz
  assert.equal(few.measure(0, 10), null);
  g.prune(300);
  assert.equal(g.samples.length, 0);
});

// Eklentinin kendi sesleriyle üretilmiş 3 sn'lik konuşma (16 kHz), 50 ms'de bir 43 ms'lik çerçeve: tarayıcıdaki gibi
function speech(name) {
  const b = readFileSync(new URL(`./fixtures/${name}.wav`, import.meta.url));
  const x = Float32Array.from(new Int16Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + b.length)), (v) => v / 32768);
  const rate = 16000;
  const W = Math.round(0.0427 * rate);
  const g = new GenderTracker();
  for (let s = 0; s + W <= x.length; s += Math.round(0.05 * rate)) g.push(s / rate, estimateF0(x.subarray(s, s + W), rate));
  return g.measure(0, 3);
}

test('gerçek konuşma: erkek ve kadın sesler doğru sınıflanır', () => {
  for (const n of ['male-antalia', 'male-supertonic']) assert.equal(speech(n)?.gender, 'male', n);
  for (const n of ['female-ahenk', 'female-ema', 'female-supertonic']) assert.equal(speech(n)?.gender, 'female', n);
});

test('predictGender: kendi ölçümü → sıranın cinsiyeti → iki sıra öncesi → en son duyulan → varsayılan', () => {
  const st = { turns: new Map([[0, 'male'], [1, 'female']]), last: 'female', fallback: 'male' };
  assert.equal(predictGender({ gender: 'female', speaker: 0 }, st), 'female');
  assert.equal(predictGender({ speaker: 0 }, st), 'male');
  assert.equal(predictGender({ speaker: 1 }, st), 'female');
  assert.equal(predictGender({ speaker: 2 }, st), 'male', 'iki kişilik dönüşüm');
  assert.equal(predictGender({ speaker: 7 }, st), 'female', 'en son duyulan');
  assert.equal(predictGender({}, { turns: new Map(), last: null, fallback: 'male' }), 'male');
  assert.equal(predictGender({}, { turns: new Map(), last: null, fallback: null }), null);
});

test('turnGender: belirgin ölçüm hemen, sınıra yakın ölçüm çoğunlukla', () => {
  const r = [];
  assert.equal(turnGender(r, { hz: 120, gender: 'male' }), 'male');
  assert.equal(turnGender(r, { hz: 125, gender: 'male' }), 'male');
  assert.equal(turnGender(r, { hz: 175, gender: 'female' }), 'male', 'sınıra yakın tek ölçüm çevirmez');
  assert.equal(turnGender(r, { hz: 178, gender: 'female' }), 'female', 'ikinci ölçümle çoğunluk');
  assert.equal(turnGender(r, { hz: 230, gender: 'female' }), 'female');
  assert.equal(turnGender(r, { hz: 110, gender: 'male' }), 'male', 'belirgin erkek hemen');
  assert.equal(r.length, 3);
});

test('favori: cinsiyeti uymayan ses atılır, ton normalleşir', () => {
  assert.deepEqual(normalizeFavorite({ voice: 'ahenk-cep', style: 'lively', pitch: 1.2 }, 'female'), { voice: 'ahenk-cep', style: 'lively', pitch: 1 });
  assert.equal(normalizeFavorite({ voice: 'ahenk-cep' }, 'male'), null);
  assert.equal(normalizeFavorite({ voice: 'system' }, 'male'), null);
  assert.equal(normalizeFavorite('x', 'male'), null);
  // katalog dışı (test motoru) ses yuvasında kalır
  assert.deepEqual(normalizeFavorite({ voice: 'mock-beep' }, 'male'), { voice: 'mock-beep', style: 'natural', pitch: 0 });
  const s = normalizeSettings({ favMale: { voice: 'ema-lightning' } });
  assert.equal(s.favMale, null);
  assert.equal(s.genderVoices, true);
});

test('cinsiyet sesi: favori öncelikli, sonra birinci ses, sonra kendiliğinden', () => {
  const S = (o) => normalizeSettings({ voice: 'antalia-mini', ...o });
  assert.equal(genderVoice(S({}), 'male'), 'antalia-mini');
  assert.equal(genderVoice(S({}), 'female'), 'ahenk-cep');
  assert.deepEqual(genderVoiceList(S({}), 'female'), ['ahenk-cep', 'ema-lightning']);
  assert.equal(genderVoice(S({ favFemale: { voice: 'ema-lightning' } }), 'female'), 'ema-lightning');
  assert.equal(genderVoice(S({ favMale: { voice: 'supertonic-3:M2' } }), 'male'), 'supertonic-3:M2');
  assert.equal(genderVoice(S({ favFemale: { voice: 'ema-lightning' } }), 'female', 1), 'ahenk-cep', 'aynı cinsiyetten ikinci konuşmacı');
  // Supertonic birinci seste karşı cinsiyet aynı paketten
  assert.equal(genderVoice(S({ voice: 'supertonic-3:F2' }), 'male'), 'supertonic-3:M1');
  assert.equal(voiceGender(S({}), 'supertonic-3:F2'), 'female');
});

test('chooseVoice ve toneFor: cinsiyet modu, sistem sesi, favorinin tonu', () => {
  const s = normalizeSettings({ voice: 'antalia-mini', style: 'calm', pitch: -1, quality: 'high', favFemale: { voice: 'ahenk-cep', style: 'lively', pitch: 1 } });
  assert.equal(chooseVoice(s, { gender: 'female' }), 'ahenk-cep');
  assert.equal(chooseVoice(s, { gender: 'male' }), 'antalia-mini');
  assert.equal(chooseVoice(s, { gender: null }), 'antalia-mini');
  assert.equal(chooseVoice({ ...s, genderVoices: false }, { gender: 'female' }), 'antalia-mini');
  assert.equal(chooseVoice({ ...s, voice: 'system' }, { gender: 'female' }), 'system');
  assert.deepEqual(toneFor(s, 'ahenk-cep'), { style: 'lively', pitch: 1, quality: 'high' });
  assert.deepEqual(toneFor(s, 'antalia-mini'), { style: 'calm', pitch: -1, quality: 'high' });
  // test motoru: yalnızca favoriler
  const m = normalizeSettings({ engineMode: 'mock', voice: 'mock-beep', favFemale: { voice: 'mock-silent' } });
  assert.equal(chooseVoice(m, { gender: 'female' }), 'mock-silent');
  assert.equal(chooseVoice(m, { gender: 'male' }), 'mock-beep');
  assert.deepEqual(voicesInUse(normalizeSettings({ voice: 'supertonic-3:F1' })), ['supertonic-3:F1', 'supertonic-3:M1']);
});
