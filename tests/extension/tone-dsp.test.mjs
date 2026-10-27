// Perde kaydırma (dsp.shiftPitch + core.speedPlan), yumuşak sınırlayıcı, üslup hızı ve zamanlama.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shiftPitch, softLimit } from '../../extension/engines/tts/dsp.js';
import { speedPlan } from '../../extension/engines/tts/core.js';
import { pitchRatio, styleSpeed } from '../../extension/engines/tts/styles.js';
import { chooseSynthSpeed, fitRate, estimateSpeechSec } from '../../extension/content/timing.js';

const RATE = 48000;
const sine = (hz, sec) => Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / RATE));
// Pozitif yöne sıfır geçişlerinden frekans tahmini
function freq(x) {
  let first = -1, last = -1, n = 0;
  for (let i = 1; i < x.length; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const f = i - 1 + -x[i - 1] / (x[i] - x[i - 1]);
      if (first < 0) first = f; else n++;
      last = f;
    }
  }
  return (n * RATE) / (last - first);
}

test('perde +12 yarım ton: 440 Hz -> ~880 Hz, süre aynı', () => {
  const k = pitchRatio(12);
  const plan = speedPlan(1, k);
  // motor speed/k ile sentezler: k kat uzun çıkar (burada 440 Hz sinüs, k sn)
  assert.ok(Math.abs(plan.model - 1 / k) < 1e-9);
  const out = shiftPitch(sine(440, 1 * k), k);
  assert.ok(Math.abs(freq(out) - 880) < 6, `frekans ${freq(out)}`);
  assert.ok(Math.abs(out.length / RATE - 1) < 0.02, `süre ${out.length / RATE}`);
});

test('perde -4 yarım ton: frekans ~ 2^(-1/3) kat, süre aynı', () => {
  const k = pitchRatio(-4);
  const out = shiftPitch(sine(440, 1 * k), k);
  assert.ok(Math.abs(freq(out) - 440 * k) < 4);
  assert.ok(Math.abs(out.length / RATE - 1) < 0.02);
});

test('perde 0: birebir; boş dizi güvenli', () => {
  const x = sine(300, 0.2);
  assert.equal(shiftPitch(x, 1), x);
  assert.equal(shiftPitch(new Float32Array(0), 1.5).length, 0);
  assert.equal(shiftPitch(new Float32Array(1), 1.5).length, 1);
  assert.equal(shiftPitch(x, 0), x);
  assert.equal(shiftPitch(x, NaN), x);
});

test('speedPlan: perde yokken eskisi gibi, perdede modele giden hız doğal aralıkta', () => {
  assert.deepEqual(speedPlan(1.2), { speed: 1.2, native: 1.2, model: 1.2, stretch: 1 });
  const p = speedPlan(2, 1);
  assert.deepEqual([p.native, p.model, p.stretch], [1.6, 1.6, 1.25]);
  for (const st of [-4, -2, 0, 2, 4]) {
    for (const s of [0.76, 1, 1.6, 2, 3]) {
      const k = pitchRatio(st), q = speedPlan(s, k);
      assert.ok(q.model >= 0.5 - 1e-9 && q.model <= 1.6 + 1e-9, `model ${q.model} (st ${st}, hız ${s})`);
      // son süre: model çıktısı (1/model) k'ya bölünür, kalan esnetmeye bölünür = 1/s
      const dur = 1 / q.model / k / q.stretch;
      assert.ok(Math.abs(dur * s - 1) < 1e-9, `süre ${dur * s} (st ${st}, hız ${s})`);
    }
  }
});

test('softLimit: taşma yok, küçük değerlere dokunmaz, işaret korunur', () => {
  const x = Float32Array.from([0, 0.5, -0.5, 0.89, 1, -1, 3, -3, 100, -100]);
  const y = softLimit(Float32Array.from(x));
  for (let i = 0; i < y.length; i++) {
    assert.ok(Math.abs(y[i]) <= 0.98 + 1e-6, `taştı: ${y[i]}`);
    assert.equal(Math.sign(y[i]), Math.sign(x[i]));
  }
  assert.deepEqual([...y.slice(0, 4)], [...x.slice(0, 4)]);
  assert.equal(softLimit(new Float32Array(0)).length, 0);
});

test('zamanlama: sakin (×0.95) üslup uzun cümlede slota yine sığar', () => {
  const calm = 1 * styleSpeed('calm');
  assert.equal(calm, 0.95);
  const long = 'x'.repeat(120);
  // Kısa cümle, bol slot: temel hız korunur, süre slota sığar
  const shortText = 'x'.repeat(28);
  const sp = chooseSynthSpeed(shortText, 4, { base: calm });
  assert.equal(sp, 0.95);
  assert.equal(fitRate(estimateSpeechSec(shortText, sp), 4, sp).overflowSec, 0);
  // Uzun cümle, dar slot: gereken hız temelden büyükse yükselir; sakin, doğaldan yavaş ya da eşit hızla biter
  for (const slot of [4, 5, 6, 8]) {
    const a = chooseSynthSpeed(long, slot, { base: 1 });
    const b = chooseSynthSpeed(long, slot, { base: calm });
    assert.ok(b >= calm && b <= 1.6);
    assert.ok(b <= a + 1e-9, 'sakin, doğaldan hızlı olamaz');
    // gerçek ses süresi (burada tahmin) ile ince ayar: taşma kalmaz ya da yalnızca üst sınır yüzünden kalır
    const audio = estimateSpeechSec(long, b);
    const r = fitRate(audio, slot, b);
    assert.ok(r.overflowSec <= 1e-6 || b * r.rate >= 1.6 - 1e-9, `taşma ${r.overflowSec} (slot ${slot})`);
  }
  // Çok yoğun cümle: tavan 1.6 hem sakin hem doğalda aynı
  assert.equal(chooseSynthSpeed(long, 2, { base: calm }), 1.6);
});
