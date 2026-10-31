// Konuşanın cinsiyeti (content/gender.js) ve favori ses/ton (common/settings.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  estimateF0, genderOf, GenderTracker, predictGender, turnGender, MIN_VOICED, EARLY_VOICED,
} from '../../extension/content/gender.js';
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
  // konuşma gibi kayan perde (≈ 120 Hz ± %4), ara sıra oktav atlaması
  for (let i = 0; i < 30; i++) g.push(10 + i * 0.05, i % 7 === 0 ? 240 : Math.round(120 * (1 + 0.04 * Math.sin(i))));
  assert.equal(g.measure(10, 12).gender, 'male');
  assert.ok(Math.abs(g.measure(10, 12).hz - 120) <= 5, String(g.measure(10, 12).hz));
  assert.equal(g.measure(20, 22), null, 'örnek yok');
  const few = new GenderTracker();
  for (let i = 0; i < MIN_VOICED - 1; i++) few.push(i * 0.05, 220 + (i % 3) * 8);
  assert.equal(few.measure(0, 10), null);
  few.push(0, 0); // ötümsüz çerçeve sayılmaz
  assert.equal(few.measure(0, 10), null);
  g.prune(300);
  assert.equal(g.samples.length, 0);
});

test('GenderTracker: tutulan notalar (müzik) atılır, iki cinsiyet karışıksa belirsiz, erken kararda az örnek yeter', () => {
  const held = new GenderTracker();
  for (let i = 0; i < 40; i++) held.push(i * 0.05, i < 20 ? 220 : 147); // iki sabit nota
  assert.equal(held.measure(0, 2), null);
  const mixed = new GenderTracker();
  for (let i = 0; i < 30; i++) mixed.push(i * 0.05, i % 2 ? 118 + (i % 5) * 3 : 228 + (i % 5) * 4);
  assert.equal(mixed.measure(0, 2).gender, null);
  const early = new GenderTracker();
  for (let i = 0; i < EARLY_VOICED; i++) early.push(i * 0.05, 230 + (i % 4) * 6);
  assert.equal(early.measure(0, 1), null, 'tam ölçüm için az');
  assert.equal(early.measure(0, 1, { min: EARLY_VOICED }).gender, 'female');
});

// Eklentinin kendi sesleriyle üretilmiş 3 sn'lik konuşma (16 kHz), 50 ms'de bir 43 ms'lik çerçeve: tarayıcıdaki gibi
const RATE16 = 16000;
const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
function wav(name) {
  const b = readFileSync(new URL(`./fixtures/${name}.wav`, import.meta.url));
  return Float32Array.from(new Int16Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + b.length)), (v) => v / 32768);
}
// Arka plan müziği: 0.5 sn'lik akorlar (kök + beşli + oktav, harmonikli), konuşmanın `db` altında
function withMusic(x, db) {
  const roots = [220, 196, 262, 247, 220, 330];
  const m = Float32Array.from({ length: x.length }, (_, i) => {
    const r = roots[Math.floor(i / (RATE16 * 0.5)) % roots.length];
    let v = 0;
    for (const f of [r, r * 1.5, r * 2]) for (let h = 1; h <= 3; h++) v += Math.sin((2 * Math.PI * f * h * i) / RATE16) / h;
    return v;
  });
  const k = ((rms(x) || 0.1) * 10 ** (db / 20)) / rms(m);
  return x.map((v, i) => v + m[i] * k);
}
function speech(x, end = 3, opts) {
  const W = Math.round(0.0427 * RATE16);
  const g = new GenderTracker();
  for (let s = 0; s + W <= x.length; s += Math.round(0.05 * RATE16)) g.push(s / RATE16, estimateF0(x.subarray(s, s + W), RATE16));
  return g.measure(0, end, opts);
}
const MALE = ['male-antalia', 'male-supertonic'];
const FEMALE = ['female-ahenk', 'female-ema', 'female-supertonic'];
const cases = [...MALE.map((n) => [n, 'male']), ...FEMALE.map((n) => [n, 'female'])];

test('gerçek konuşma: erkek ve kadın sesler doğru sınıflanır', () => {
  for (const [n, want] of cases) assert.equal(speech(wav(n))?.gender, want, n);
});

test('müzik: hafif müzik altında doğru, belirgin müzikte yanlış değil belirsiz; yalnız müzik ölçülmez', () => {
  for (const [n, want] of cases) {
    assert.equal(speech(withMusic(wav(n), -10))?.gender, want, `${n} −10 dB`);
    const g = speech(withMusic(wav(n), -6))?.gender ?? null;
    assert.ok(g === want || g === null, `${n} −6 dB: ${g}`);
  }
  assert.equal(speech(withMusic(new Float32Array(3 * RATE16), 0))?.gender ?? null, null);
});

test('erken karar: konuşmanın ilk 0.7 sn\'si yeter, yanlış karar yok', () => {
  for (const [n, want] of cases) {
    const g = speech(wav(n), 0.7, { min: EARLY_VOICED })?.gender ?? null;
    if (n === 'male-supertonic') assert.ok(g === want || g === null, `${n}: ${g}`); // başında oktav atlamaları
    else assert.equal(g, want, n);
  }
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
  assert.equal(s.genderVoices, false);
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
  const s = normalizeSettings({ genderVoices: true, voice: 'antalia-mini', style: 'calm', pitch: -1, quality: 'high', favFemale: { voice: 'ahenk-cep', style: 'lively', pitch: 1 } });
  assert.equal(chooseVoice(s, { gender: 'female' }), 'ahenk-cep');
  assert.equal(chooseVoice(s, { gender: 'male' }), 'antalia-mini');
  assert.equal(chooseVoice(s, { gender: null }), 'antalia-mini');
  assert.equal(chooseVoice({ ...s, genderVoices: false }, { gender: 'female' }), 'antalia-mini');
  assert.equal(chooseVoice({ ...s, voice: 'system' }, { gender: 'female' }), 'system');
  assert.deepEqual(toneFor(s, 'ahenk-cep'), { style: 'lively', pitch: 1, quality: 'high' });
  assert.deepEqual(toneFor(s, 'antalia-mini'), { style: 'calm', pitch: -1, quality: 'high' });
  // test motoru: yalnızca favoriler
  const m = normalizeSettings({ genderVoices: true, engineMode: 'mock', voice: 'mock-beep', favFemale: { voice: 'mock-silent' } });
  assert.equal(chooseVoice(m, { gender: 'female' }), 'mock-silent');
  assert.equal(chooseVoice(m, { gender: 'male' }), 'mock-beep');
  assert.deepEqual(voicesInUse(normalizeSettings({ genderVoices: true, voice: 'supertonic-3:F1' })), ['supertonic-3:F1', 'supertonic-3:M1']);
});
