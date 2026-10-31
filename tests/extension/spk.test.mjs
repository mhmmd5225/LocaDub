// Konuşmacı tanıma: fbank (engines/spk/fbank.js), kümeleme ve küme cinsiyeti (content/gender.js), 16 kHz'e indirme
// (content/capture.js), sahte motor (engines/_mock/spk.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fbank, subtractMean, numFrames } from '../../extension/engines/spk/fbank.js';
import { dropSilence, normalize } from '../../extension/engines/spk/embedder.js';
import { genderScore } from '../../extension/engines/spk/gender-head.js';
import { SPK_MODELS, DEFAULT_SPK_MODEL, spkModelById } from '../../extension/engines/spk/models.js';
import { SpeakerClusters, sentenceGender, cosine, voicedF0, SPK_JOIN, SPK_NEW } from '../../extension/content/gender.js';
import { makeDownsampler, toMono16k } from '../../extension/content/capture.js';
import * as mock from '../../extension/engines/_mock/spk.js';

// Başvuru: kaldi-native-fbank 1.22.5 (dither 0, 80 mel, varsayılan seçenekler), aynı sinyal float32:
//   x[i] = 0.3·sin(2π(200 + 1000·i/N)·i/16000) + 0.05·sin(2π·3000·i/16000), N = 8000
// çerçeve 0/10/40, bin 0/10/40/79.
const N = 8000;
const X = Float32Array.from({ length: N }, (_, i) => 0.3 * Math.sin(2 * Math.PI * (200 + 1000 * i / N) * i / 16000) + 0.05 * Math.sin(2 * Math.PI * 3000 * i / 16000));
const REF = {
  povey: [[-8.0006, -0.1636, -15.9424, -15.9424], [-9.9627, -9.7215, -15.9424, -15.9424], [-12.7884, -15.832, 6.5187, -15.9424]],
  hamming: [[-6.4749, -0.1524, -9.1866, -8.9914], [-7.6317, -6.6061, -8.1423, -8.1588], [-8.8228, -8.0609, 6.5086, -6.4719]],
};

test('fbank: kaldi-native-fbank ile aynı (povey ve hamming)', () => {
  assert.equal(numFrames(N), 48);
  for (const window of ['povey', 'hamming']) {
    const fb = fbank(X, { window });
    assert.equal(fb.frames, 48);
    assert.equal(fb.bins, 80);
    [0, 10, 40].forEach((f, r) => [0, 10, 40, 79].forEach((b, c) => {
      const v = fb.data[f * 80 + b];
      assert.ok(Math.abs(v - REF[window][r][c]) < 2e-3, `${window} [${f},${b}] ${v} ≠ ${REF[window][r][c]}`);
    }));
  }
  assert.equal(fbank(new Float32Array(399)).frames, 0);
});

test('fbank: ortalama çıkarma ve sessizlik atma', () => {
  const fb = fbank(X);
  subtractMean(fb);
  for (const b of [0, 20, 79]) {
    let m = 0;
    for (let f = 0; f < fb.frames; f++) m += fb.data[f * 80 + b];
    assert.ok(Math.abs(m / fb.frames) < 1e-4);
  }
  // yarısı sessiz: sessiz çerçeveler atılır
  const y = new Float32Array(16000);
  y.set(X, 8000);
  const d = dropSilence(fbank(y));
  assert.ok(d.frames >= 45 && d.frames <= 52, String(d.frames));
  const n = normalize(Float32Array.of(3, 4));
  assert.deepEqual(Array.from(n), [0.6000000238418579, 0.800000011920929]);
});

test('model kataloğu ve cinsiyet katmanı', () => {
  const m = spkModelById();
  assert.equal(m.id, DEFAULT_SPK_MODEL);
  for (const x of SPK_MODELS) {
    assert.match(x.url, /^https:\/\/huggingface\.co\/csukuangfj\/speaker-embedding-models\/resolve\/[0-9a-f]{40}\//);
    assert.ok(x.bytes > 1e6 && x.bytes < 31e6 && /^[0-9a-f]{64}$/.test(x.sha256));
  }
  const head = JSON.parse(readFileSync(new URL(`../../extension/engines/spk/gender-${m.id}.json`, import.meta.url), 'utf8'));
  assert.equal(head.w.length, 256);
  assert.equal(genderScore({ w: [1, -1], b: 0.5 }, [0.5, 0.25]), 0.75);
  assert.equal(genderScore({ w: [1] }, [1, 2]), null);
});

// Sentetik konuşmacılar: her biri bir merkez vektörün çevresinde (cümle gürültüsü), birim uzunlukta
function speakers(seed, k, dim = 64) {
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  const centers = Array.from({ length: k }, () => normalize(Float32Array.from({ length: dim }, r)));
  // gürültü 0.28: aynı kişinin iki cümlesi ≈ 0.7 benzer (gerçek modelde ortalama ≈ 0.6), farklı kişiler ≈ 0
  const sample = (c, noise = 0.28) => normalize(Float32Array.from(centers[c], (v) => v + noise * r()));
  return { centers, sample };
}
const f0s = (hz, n = 30) => Array.from({ length: n }, (_, i) => hz * (1 + 0.05 * Math.sin(i)));

test('SpeakerClusters: aynı kişi tek küme, farklı kişiler ayrı; benzerlikler eşiklerle uyumlu', () => {
  const { sample } = speakers(7, 3);
  const a = sample(0), b = sample(0), c = sample(1);
  assert.ok(cosine(a, b) > SPK_JOIN, `aynı ${cosine(a, b)}`);
  assert.ok(cosine(a, c) < SPK_NEW, `farklı ${cosine(a, c)}`);
  const C = new SpeakerClusters();
  const seq = [0, 0, 1, 1, 0, 2, 2, 1, 0, 2, 0, 1];
  const ids = seq.map((k) => C.assign(sample(k)));
  const by = new Map();
  seq.forEach((k, i) => { const id = C.resolve(ids[i]); by.set(k, (by.get(k) || new Set()).add(id)); });
  for (const [k, set] of by) assert.equal(set.size, 1, `konuşmacı ${k}: ${[...set]}`);
  assert.equal(new Set(ids.map((i) => C.resolve(i))).size, 3);
});

test('SpeakerClusters: yakınlaşan kümeler birleşir, kimlik takma adla çözülür', () => {
  const C = new SpeakerClusters({ join: 0.9, fresh: 0.7, merge: 0.7 });
  const a = C.assign(Float32Array.of(1, 0, 0), { ev: { f0: f0s(120) } });
  const b = C.assign(Float32Array.of(0.6, 0.8, 0));
  assert.notEqual(a, b, 'benzerlik 0.6 < 0.7: yeni küme');
  // ikisinin arası: b'ye katılır, merkezler 0.707 benzer → birleşir; kanıt da taşınır
  C.assign(Float32Array.of(0.8, 0.6, 0));
  assert.equal(C.resolve(a), C.resolve(b));
  assert.equal(C.clusters.size, 1);
  assert.equal(C.genderOf(b), 'male');
});

test('küme cinsiyeti: birikmiş kanıt, tek aykırı cümle çevirmez, sınıflandırıcı perdeyle tartılır', () => {
  const { sample } = speakers(11, 2);
  const C = new SpeakerClusters();
  const m = C.assign(sample(0), { ev: { f0: f0s(118) } });
  assert.equal(C.genderOf(m), 'male');
  assert.ok(Math.abs(C.medianHz(m) - 118) < 6);
  // bağıran erkek: tek cümlede 200 Hz → karar dönmez
  C.assign(sample(0), { ev: { f0: f0s(205, 20) } });
  assert.equal(C.genderOf(m), 'male');
  for (let i = 0; i < 4; i++) C.assign(sample(0), { ev: { f0: f0s(120) } });
  assert.equal(C.genderOf(m), 'male');
  // kadın: perde sınırda (165 Hz), sınıflandırıcı açıkça kadın
  const f = C.assign(sample(1), { ev: { f0: f0s(165), score: 4 } });
  assert.notEqual(C.resolve(f), C.resolve(m));
  assert.equal(C.genderOf(f), 'female');
  // kanıt yokken karar yok
  const D = new SpeakerClusters();
  const u = D.assign(sample(0), { ev: { f0: [150] } });
  assert.equal(D.genderOf(u), null);
  // altOf: aynı cinsiyetten ikinci küme
  assert.equal(C.altOf(m), 0);
  assert.equal(C.altOf(f), 0);
});

test('sentenceGender ve voicedF0', () => {
  assert.equal(sentenceGender({ f0: f0s(220) }), 'female');
  assert.equal(sentenceGender({ f0: f0s(110) }), 'male');
  assert.equal(sentenceGender({ f0: f0s(162) }), null, 'sınırda belirsiz');
  assert.equal(sentenceGender({ f0: [], score: -3 }), 'male');
  assert.equal(sentenceGender({}), null);
  // tutulan nota atılır
  const fr = Array.from({ length: 10 }, (_, i) => [i * 0.05, 220]);
  assert.equal(voicedF0(fr).length, 0);
  assert.equal(voicedF0([[0, 120], [0.05, 0], [0.1, 125]]).length, 2);
});

test('16 kHz\'e indirme: 48 kHz sinüs korunur, süre doğru; ayırma sesi monoya', () => {
  const d = makeDownsampler(48000);
  const tone = (n, off) => Float32Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * 300 * (i + off) / 48000));
  const out = [];
  for (let k = 0; k < 10; k++) out.push(...d(tone(4096, k * 4096)));
  assert.ok(Math.abs(out.length - 40960 / 3) <= 1, String(out.length));
  // gecikme ≈ 15 giriş örneği: 300 Hz sinüsle karşılaştır (geçişten sonra)
  let err = 0;
  for (let i = 200; i < out.length; i++) err = Math.max(err, Math.abs(out[i] - Math.sin(2 * Math.PI * 300 * (3 * i - 15) / 48000)));
  assert.ok(err < 0.03, String(err));
  // 7.9 kHz üstü (örtüşme) bastırılır
  const d2 = makeDownsampler(48000);
  const hi = d2(Float32Array.from({ length: 48000 }, (_, i) => Math.sin(2 * Math.PI * 12000 * i / 48000)));
  const r = Math.sqrt(hi.slice(100).reduce((a, v) => a + v * v, 0) / (hi.length - 100));
  assert.ok(r < 0.05, String(r));
  const m = toMono16k({ left: Float32Array.of(1, 1, 1), right: Float32Array.of(0, 0, 0), sampleRate: 16000 });
  assert.deepEqual(Array.from(m), [0.5, 0.5, 0.5]);
  assert.equal(toMono16k(null), null);
});

test('sahte motor: erkek ve kadın test sesleri ayrı kümelere, cinsiyet perdeden', async () => {
  const wav = (n) => {
    const b = readFileSync(new URL(`./fixtures/${n}.wav`, import.meta.url));
    return Float32Array.from(new Int16Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + b.length)), (v) => v / 32768);
  };
  const C = new SpeakerClusters();
  const id = {};
  for (const n of ['male-antalia', 'male-supertonic', 'female-ahenk', 'female-ema', 'female-supertonic']) {
    const r = await mock.embed(wav(n));
    id[n] = C.assign(r.vector, { ev: { f0: r.f0 } });
  }
  assert.equal(C.genderOf(id['male-antalia']), 'male');
  assert.equal(C.genderOf(id['male-supertonic']), 'male');
  for (const n of ['female-ahenk', 'female-ema', 'female-supertonic']) assert.equal(C.genderOf(id[n]), 'female', n);
  assert.notEqual(C.resolve(id['male-antalia']), C.resolve(id['female-ahenk']));
});
