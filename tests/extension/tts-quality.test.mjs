// Seslendirme kalitesi: ses seviyesi dengesi, örnek hızı dönüşümü, cümle tohumu, bağlaç virgülü, Supertonic kataloğu,
// ses karıştırma ve konuşmacı sesleri (model gerekmez).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertRate, normalizeLoudness, speechLevel, TARGET_LEVEL_DB } from '../../extension/engines/tts/dsp.js';
import { textSeed } from '../../extension/engines/tts/core.js';
import { addClauseCommas, normalizeText } from '../../extension/engines/tts/normalize.js';
import { VOICES, SUPERTONIC_INT8, SUPERTONIC_PACK, packOf, presetsOf, supertonicFiles, voiceBytes, voiceById } from '../../extension/engines/tts/voices.js';
import { normalizeBlend, normalizeTone, resolveTone, SUPERTONIC_STEPS, toneFromSettings } from '../../extension/engines/tts/styles.js';
import { blendStyles, chunk, preprocess } from '../../extension/engines/tts/supertonic.js';
import { normalizeSettings, speakerVoice, voiceForSpeaker, voicesInUse } from '../../extension/common/settings.js';

const RATE = 24000;
const tone = (hz, db, sec = 1, rate = RATE) =>
  Float32Array.from({ length: Math.round(sec * rate) }, (_, i) => 10 ** (db / 20) * Math.SQRT2 * Math.sin((2 * Math.PI * hz * i) / rate));
const rms = (x) => 20 * Math.log10(Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length));

test('normalizeLoudness: konuşma hedef seviyeye gelir, sessizlik ve duraklama sayılmaz', () => {
  const x = tone(220, -32);
  assert.ok(Math.abs(speechLevel(x, RATE) + 32) < 0.2);
  normalizeLoudness(x, RATE);
  assert.ok(Math.abs(speechLevel(x, RATE) - TARGET_LEVEL_DB) < 0.3, `${speechLevel(x, RATE)}`);
  // yarısı sessiz: seviye konuşma kısmından ölçülür
  const y = new Float32Array(RATE * 2);
  y.set(tone(220, -26), RATE);
  assert.ok(Math.abs(speechLevel(y, RATE) + 26) < 0.3);
});

test('normalizeLoudness: kazanç ±12 dB ile sınırlı, tepe 0.98 altında, sessizliğe dokunmaz', () => {
  const quiet = tone(220, -50);
  normalizeLoudness(quiet, RATE);
  assert.ok(Math.abs(rms(quiet) + 38) < 0.3, 'en fazla +12 dB');
  const loud = tone(220, -3);
  normalizeLoudness(loud, RATE);
  assert.ok(Math.max(...loud.map(Math.abs)) <= 0.98);
  const silent = new Float32Array(1000);
  assert.equal(normalizeLoudness(silent, RATE), silent);
  assert.equal(speechLevel(silent, RATE), -Infinity);
});

test('convertRate 44.1 → 24 kHz: yeni Nyquist üstü örtüşmeden süzülür', () => {
  const hi = convertRate(tone(15000, -10, 0.5, 44100), 44100, 24000);
  const lo = convertRate(tone(1000, -10, 0.5, 44100), 44100, 24000);
  assert.equal(lo.length, 12000);
  assert.ok(rms(hi.subarray(500, -500)) < -45, `15 kHz sızıntısı ${rms(hi)}`);
  assert.ok(Math.abs(rms(lo.subarray(500, -500)) + 10) < 0.5, 'geçirme bandı korunur');
});

test('textSeed: aynı cümle aynı, farklı cümle farklı tohum', () => {
  assert.equal(textSeed('Merhaba dünya.'), textSeed('Merhaba dünya.'));
  assert.notEqual(textSeed('Merhaba dünya.'), textSeed('Merhaba dünya!'));
  assert.ok(Number.isInteger(textSeed('x')) && textSeed('x') >= 0 && textSeed('x') < 2 ** 31);
});

test('addClauseCommas: uzun yan cümlede bağlaçtan önce virgül, kısa olanda yok', () => {
  assert.equal(
    addClauseCommas('Bu yöntem ilk başta zor görünebilir ama birkaç denemeden sonra her şey kolaylaşıyor.'),
    'Bu yöntem ilk başta zor görünebilir, ama birkaç denemeden sonra her şey kolaylaşıyor.',
  );
  assert.equal(addClauseCommas('Küçük ama güçlü bir telefon.'), 'Küçük ama güçlü bir telefon.');
  assert.equal(addClauseCommas('Ama bu işi yarın yapacağız ve herkes buna hazırlıklı olmalı.'), 'Ama bu işi yarın yapacağız ve herkes buna hazırlıklı olmalı.');
  assert.equal(addClauseCommas('Gelmek istedi, ama gelemedi çünkü hastaydı.'), 'Gelmek istedi, ama gelemedi çünkü hastaydı.');
  // soru ve ünlem işaretleri modele ulaşır
  assert.match(normalizeText('Bunu gerçekten denediniz mi?'), /\?$/);
  assert.match(normalizeText('Harika, sonunda başardık!'), /, .*!$/);
});

test('katalog: Supertonic hazır sesleri bir paketi paylaşır', () => {
  const presets = presetsOf('supertonic-3');
  assert.equal(presets.length, 10);
  assert.deepEqual(presets.map((v) => v.preset), ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5']);
  assert.ok(presets.every((v) => v.files === SUPERTONIC_PACK.files && packOf(v) === 'supertonic-3' && v.experimental && v.threads === 4));
  assert.deepEqual([...new Set(presets.map((v) => v.gender))], ['female', 'male']);
  assert.equal(new Set(VOICES.map((v) => v.id)).size, VOICES.length);
  assert.equal(packOf(voiceById('antalia-mini')), 'antalia-mini');
  if (!SUPERTONIC_INT8) {
    const mb = voiceBytes(presets[0]) / 1e6;
    assert.ok(mb > 395 && mb < 402, `${mb}`);
    assert.ok(SUPERTONIC_PACK.files.every((f) => f.url.includes('/resolve/3cadd1ee6394adea1bd021217a0e650ede09a323/')));
    assert.deepEqual(SUPERTONIC_PACK.legacyPrefixes, []);
  } else {
    assert.ok(SUPERTONIC_PACK.files.every((f) => f.url.includes(`/${SUPERTONIC_INT8.repo}/resolve/${SUPERTONIC_INT8.rev}/`)));
    assert.match(SUPERTONIC_INT8.rev, /^[0-9a-f]{40}$/, 'commit kimliğine sabitli');
    assert.equal(SUPERTONIC_PACK.legacyPrefixes.length, 1);
  }
});

test('katalog: 8-bit Supertonic kopyası aynı düzende, ≈ 210 MB', () => {
  const files = supertonicFiles({ repo: 'kim/supertonic-3-int8', rev: 'abc' });
  const fp32 = supertonicFiles(null);
  assert.deepEqual(files.map((f) => f.name), fp32.map((f) => f.name));
  assert.ok(files.every((f) => f.url.startsWith('https://huggingface.co/kim/supertonic-3-int8/resolve/abc/')));
  assert.equal(files.find((f) => f.name === 'vector').url.endsWith('onnx/vector_estimator.int8.onnx'), true);
  // vector_estimator dışındaki dosyalar fp32 paketle aynı
  const rel = (f) => f.url.split('/resolve/')[1].split('/').slice(1).join('/');
  for (const f of files.filter((x) => x.name !== 'vector')) {
    const g = fp32.find((x) => x.name === f.name);
    assert.equal(rel(f), rel(g));
    assert.equal(f.bytes, g.bytes);
  }
  const mb = files.reduce((n, f) => n + f.bytes, 0) / 1e6;
  assert.ok(mb > 209 && mb < 211, `${mb}`);
});

test('supertonic: resmî ön işleme, parçalama, stil karıştırma', () => {
  assert.equal(preprocess('Merhaba  dünya ,nasılsın'), '<tr>' + 'Merhaba dünya,nasılsın.'.normalize('NFKD') + '</tr>');
  assert.equal(preprocess('Gerçekten mi?').endsWith('?</tr>'), true);
  assert.deepEqual(chunk('Bir. İki? Üç!', 8), ['Bir.', 'İki? Üç!']);
  const st = (v) => ({ ttl: { data: Float32Array.of(v, v), dims: [1, 1, 2] }, dp: { data: Float32Array.of(v), dims: [1, 1, 1] } });
  const m = blendStyles(st(0), st(1), 0.25);
  assert.deepEqual([...m.ttl.data], [0.25, 0.25]);
  assert.deepEqual([...m.dp.data], [0.25]);
  assert.equal(blendStyles(st(0), st(1), 0).ttl.data[0], 0);
});

test('üslup: ses karıştırma ve Supertonic adımları', () => {
  assert.equal(normalizeBlend(null), null);
  assert.equal(normalizeBlend({ with: 'X1', amount: 0.5 }), null);
  assert.equal(normalizeBlend({ with: 'M1', amount: 0 }), null);
  assert.deepEqual(normalizeBlend({ with: 'M1', amount: '0.33' }), { with: 'M1', amount: 0.35 });
  assert.deepEqual(normalizeBlend({ with: 'F2', amount: 5 }), { with: 'F2', amount: 0.9 });
  assert.ok(!('blend' in normalizeTone({})));
  assert.deepEqual(toneFromSettings(normalizeSettings({ voiceBlend: { with: 'F3', amount: 0.2 } })).blend, { with: 'F3', amount: 0.2 });
  assert.equal(resolveTone({ quality: 'fast' }, [], 'supertonic').steps, SUPERTONIC_STEPS.fast);
  assert.equal(resolveTone({ quality: 'high' }, [], 'supertonic').steps, SUPERTONIC_STEPS.high);
  assert.equal(resolveTone({ quality: 'fast' }, [], 'ahenk').steps, null);
  assert.equal(resolveTone({ quality: 'high' }, [], 'ahenk').steps, 16);
});

test('konuşmacı sesleri: 2–4 ses, kendiliğinden seçim karşıt cinsiyetten başlar', () => {
  const S = (o) => normalizeSettings({ speakerVoices: true, ...o });
  assert.equal(S({}).speakerCount, 2);
  assert.equal(S({ speakerCount: 9 }).speakerCount, 4);
  assert.equal(S({ speakerCount: 'x' }).speakerCount, 2);
  // küçük sesler: Antalia → Ahenk → EMA, dördüncü ses yoksa baştan döner
  const small = S({ voice: 'antalia-mini', speakerCount: 4 });
  assert.deepEqual([0, 1, 2, 3].map((n) => speakerVoice(small, n)), ['antalia-mini', 'ahenk-cep', 'ema-lightning', 'antalia-mini']);
  // Supertonic: aynı paketten, cinsiyet dönüşümlü (ek indirme yok)
  const sup = S({ voice: 'supertonic-3:F2', speakerCount: 4 });
  assert.deepEqual([1, 2, 3].map((n) => speakerVoice(sup, n)), ['supertonic-3:M1', 'supertonic-3:F1', 'supertonic-3:M2']);
  // seçilen ses önceliklidir; önceki seslerden biriyle aynıysa kendiliğinden seçime düşer
  const pick = S({ voice: 'antalia-mini', voice2: 'ema-lightning', voice3: 'antalia-mini', speakerCount: 3 });
  assert.equal(speakerVoice(pick, 1), 'ema-lightning');
  assert.equal(speakerVoice(pick, 2), 'ahenk-cep');
  // konuşmacı sayacı mod ses sayısı
  assert.equal(voiceForSpeaker(S({ voice: 'antalia-mini', speakerCount: 3 }), 3), 'antalia-mini');
  assert.equal(voiceForSpeaker(S({ voice: 'antalia-mini', speakerCount: 3 }), 5), 'ema-lightning');
  assert.equal(voiceForSpeaker(S({ voice: 'antalia-mini' }), 2), 'antalia-mini');
  assert.deepEqual(voicesInUse(S({ voice: 'antalia-mini', speakerCount: 3 })), ['antalia-mini', 'ahenk-cep', 'ema-lightning']);
  assert.deepEqual(voicesInUse(normalizeSettings({ voice: 'antalia-mini', speakerCount: 3 })), ['antalia-mini']);
  assert.deepEqual(voicesInUse(S({ voice: 'system' })), ['system']);
});
