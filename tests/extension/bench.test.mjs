// Hız testi yardımcıları (common/bench.js): sahte ayırma istemcisi, sentez ve çeviriyle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BENCH, mean, rtf, benchSignal, runSepBench, runTtsBench, runMtBench, runBench, fastestBatch, formatBench,
} from '../../extension/common/bench.js';
import { buildReport } from '../../extension/common/diagnostics.js';
import { normalizeSettings } from '../../extension/common/settings.js';

test('mean ve rtf', () => {
  assert.equal(mean([]), 0);
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(rtf(4000, 8), 0.5);
  assert.equal(rtf(1000, 0), 0);
});

test('benchSignal: belirleyici, doğru uzunluk, parçalar mutlak zamana göre bitişik', () => {
  const a = benchSignal(1, 8000, 0);
  const b = benchSignal(1, 8000, 0);
  assert.equal(a.left.length, 8000);
  assert.deepEqual(a.left, b.left);
  const whole = benchSignal(2, 8000, 0);
  const second = benchSignal(1, 8000, 1);
  // aynı mutlak zamanda harmonik kısım aynı (gürültü tohumu parçaya göre farklı olabilir): enerji benzer, sınırlı genlik
  const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
  assert.ok(Math.abs(rms(whole.left.subarray(8000)) - rms(second.left)) < 0.02);
  assert.ok(Math.max(...whole.left.map(Math.abs)) < 1);
});

// sahte istemci: arka uç ve her işlem için sabit süre (now() sahte saatle ilerler)
function fakeClients({ backend = 'webgpu', msPerSecAudio = { 1: 500, 2: 400, 4: 300, 8: 350 }, failBatch = null } = {}) {
  let clock = 0;
  const made = [];
  const createClient = () => {
    let batch = 1;
    const c = {
      calls: [],
      async load(o) { batch = o.batch; c.calls.push(['load', o]); clock += 100; if (failBatch === batch) throw new Error('bellek yetmedi'); return { backend, model: 'kim-vocal-2' }; },
      async process(l, r, rate, o) { c.calls.push(['process', l.length / rate, o]); clock += (l.length / rate) * (msPerSecAudio[batch] || 500); return {}; },
      async dispose() { c.disposed = true; },
    };
    made.push(c);
    return c;
  };
  return { createClient, now: () => clock, made };
}

test('runSepBench: WebGPU\'da tüm toplu boyutları dener, ilk parça ısınma sayılır, bitişik startSample', async () => {
  const f = fakeClients();
  const { runs } = await runSepBench({ createClient: f.createClient, now: f.now });
  assert.deepEqual(runs.map((r) => r.batch), [1, 2, 4, 8]);
  assert.ok(runs.every((r) => r.backend === 'webgpu' && r.rtfs.length === BENCH.sepChunks));
  assert.equal(runs[0].rtf.toFixed(2), '0.50');
  assert.equal(runs[2].rtf.toFixed(2), '0.30');
  assert.equal(fastestBatch(runs).batch, 4);
  const proc = f.made[0].calls.filter((c) => c[0] === 'process');
  assert.deepEqual(proc.map((c) => c[2].startSample), [0, 8 * 48000, 16 * 48000]);
  assert.deepEqual(proc.map((c) => c[2].final), [false, false, true]);
  assert.ok(f.made.every((c) => c.disposed), 'istemciler kapatılmalı');
});

test('runSepBench: WASM\'da yalnız toplu 1; hata olunca durur', async () => {
  const w = fakeClients({ backend: 'wasm' });
  const r = await runSepBench({ createClient: w.createClient, now: w.now });
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].backend, 'wasm');
  const e = fakeClients({ failBatch: 2 });
  const r2 = await runSepBench({ createClient: e.createClient, now: e.now });
  assert.deepEqual(r2.runs.map((x) => x.batch), [1, 2]);
  assert.match(r2.runs[1].error, /bellek/);
  assert.equal(fastestBatch(r2.runs).batch, 1);
});

test('runTtsBench: ilk cümle ısınma, kalan toplam süre / toplam ses; atlama ve hata', async () => {
  const seen = [];
  const r = await runTtsBench({ synth: async (t) => { seen.push(t); return { ms: 500, audioSec: 2 }; } });
  assert.equal(r.sentences, BENCH.tts.length - 1);
  assert.equal(r.rtf, 0.25);
  assert.equal(seen.length, BENCH.tts.length);
  assert.deepEqual(await runTtsBench({ synth: async () => ({ skipped: 'sistem sesi' }) }), { skipped: 'sistem sesi' });
  assert.match((await runTtsBench({ synth: async () => { throw new Error('model yok'); } })).error, /model yok/);
});

test('runMtBench: ısınma + ölçüm; hata', async () => {
  let clock = 0;
  const calls = [];
  const r = await runMtBench({ translate: async (s) => { calls.push(s.length); clock += s.length === 1 ? 5000 : 2000; }, now: () => clock });
  assert.deepEqual(calls, [1, BENCH.mt.length]);
  assert.equal(r.perSec, BENCH.mt.length / 2);
  assert.match((await runMtBench({ translate: async () => { throw new Error('motor kapalı'); } })).error, /motor kapalı/);
});

test('runBench ve formatBench: aşamalar bağımsız, çıktı satırları', async () => {
  const f = fakeClients();
  const steps = [];
  const res = await runBench({
    sep: { createClient: f.createClient, now: f.now },
    tts: { synth: async () => ({ ms: 400, audioSec: 2 }) },
    mt: { translate: async () => { throw new Error('motor kapalı'); } },
    onStep: (s) => steps.push(s), now: () => 123,
  });
  assert.equal(res.at, 123);
  assert.ok(steps.length > 5);
  const L = formatBench(res);
  assert.match(L[0], /^ses ayırma: arka uç webgpu · model kim-vocal-2 · yükleme 0\.1 sn$/);
  assert.ok(L.some((l) => /^ {2}toplu 4: 0\.30 rtf \(3\.3× gerçek zaman\)$/.test(l)), L.join('\n'));
  assert.ok(L.includes('  en hızlı: toplu 4'));
  assert.ok(L.some((l) => /^seslendirme: 3 cümle, 0\.20 rtf \(5\.0× gerçek zaman\)$/.test(l)));
  assert.ok(L.some((l) => /^çeviri: hata — motor kapalı$/.test(l)));
  const none = formatBench({});
  assert.deepEqual(none, ['ses ayırma: çalıştırılmadı', 'seslendirme: çalıştırılmadı', 'çeviri: çalıştırılmadı']);
  const w = fakeClients({ backend: 'wasm' });
  const Lw = formatBench({ sep: await runSepBench({ createClient: w.createClient, now: w.now }) });
  assert.ok(Lw.some((l) => /WebGPU yok/.test(l)));
});

test('tanılama raporu: [Hız testi] bölümü yalnız veri varsa', () => {
  const base = { version: '0.5.3', browser: 'Chrome', platform: 'Linux', settings: normalizeSettings({}), now: 0 };
  assert.ok(!buildReport(base).includes('[Hız testi]'));
  const text = buildReport({ ...base, bench: ['ses ayırma: arka uç webgpu', 'çeviri: 8 cümle, 6.1 cümle/sn'], benchAt: 0 });
  assert.match(text, /\[Hız testi \(1970-01-01T00:00:00Z\)\]\nses ayırma: arka uç webgpu\nçeviri: 8 cümle, 6\.1 cümle\/sn/);
});
