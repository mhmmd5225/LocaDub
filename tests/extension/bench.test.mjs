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
function fakeClients({ backend = 'webgpu', msPerSecAudio = { 1: 100, 2: 90, 4: 80 }, failBatch = null, stepSec = 2.96 } = {}) {
  let clock = 0;
  const made = [];
  const createClient = () => {
    let batch = 1;
    const c = {
      calls: [],
      async load(o) { batch = o.batch; c.calls.push(['load', o]); clock += 100; if (failBatch === batch) throw new Error('bellek yetmedi'); return { backend, model: 'kim-vocal-2', stepSec }; },
      async process(l, r, rate, o) { c.calls.push(['process', l.length / rate, o]); clock += (l.length / rate) * (msPerSecAudio[batch] || 100); return {}; },
      async dispose() { c.disposed = true; },
    };
    made.push(c);
    return c;
  };
  return { createClient, now: () => clock, made };
}

// çökme koruması: bellekte tutulan sahte depo
function fakeGuard(init = {}) {
  const st = { inflight: init.inflight ?? null, cap: init.cap ?? null, marks: [] };
  return {
    st,
    read: async () => ({ inflight: st.inflight, cap: st.cap }),
    mark: async (b) => { st.inflight = b; st.marks.push(b); },
    clear: async () => { st.inflight = null; },
    setCap: async (b) => { st.cap = { batch: b, at: 1000 }; },
  };
}

test('runSepBench: WebGPU\'da 1\'den başlar, bir sonrakinin tahmini GPU işi 0.8 sn\'yi aşacaksa denemez; ilk parça ısınma, bitişik startSample', async () => {
  const f = fakeClients();
  const { runs, stopped } = await runSepBench({ createClient: f.createClient, now: f.now });
  // toplu 1: rtf 0.10 → toplu 2 ≈ 0.59 sn (tamam); toplu 2: rtf 0.09 → toplu 4 ≈ 1.07 sn > 0.8 (denenmez)
  assert.deepEqual(runs.map((r) => r.batch), [1, 2]);
  assert.equal(stopped.batch, 4);
  assert.match(stopped.reason, /sürücü sınırına yakın/);
  assert.ok(runs.every((r) => r.backend === 'webgpu' && r.rtfs.length === BENCH.sepChunks));
  assert.equal(runs[0].rtf.toFixed(2), '0.10');
  assert.equal(fastestBatch(runs).batch, 2);
  const proc = f.made[0].calls.filter((c) => c[0] === 'process');
  assert.deepEqual(proc.map((c) => c[2].startSample), [0, 8 * 48000, 16 * 48000]);
  assert.deepEqual(proc.map((c) => c[2].final), [false, false, true]);
  assert.ok(f.made.every((c) => c.disposed), 'istemciler kapatılmalı');
  assert.ok(!BENCH.sepBatches.includes(8), 'toplu 8 denenmez');
});

test('runSepBench: çok hızlı GPU\'da 4\'e kadar çıkar; yavaş GPU\'da toplu 2 bile denenmez', async () => {
  const fast = fakeClients({ msPerSecAudio: { 1: 20, 2: 18, 4: 16 } }); // rtf 0.02 → toplu 4 ≈ 0.2 sn
  const r = await runSepBench({ createClient: fast.createClient, now: fast.now });
  assert.deepEqual(r.runs.map((x) => x.batch), [1, 2, 4]);
  assert.equal(r.stopped, undefined);
  const slow = fakeClients({ msPerSecAudio: { 1: 400 } }); // rtf 0.4 → toplu 2 ≈ 2.4 sn
  const s = await runSepBench({ createClient: slow.createClient, now: slow.now });
  assert.deepEqual(s.runs.map((x) => x.batch), [1]);
  assert.equal(s.stopped.batch, 2);
});

test('runSepBench: WASM\'da yalnız toplu 1; hata olunca durur', async () => {
  const w = fakeClients({ backend: 'wasm' });
  const r = await runSepBench({ createClient: w.createClient, now: w.now });
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].backend, 'wasm');
  const e = fakeClients({ failBatch: 2, msPerSecAudio: { 1: 20, 2: 18, 4: 16 } });
  const r2 = await runSepBench({ createClient: e.createClient, now: e.now });
  assert.deepEqual(r2.runs.map((x) => x.batch), [1, 2]);
  assert.match(r2.runs[1].error, /bellek/);
  assert.equal(fastestBatch(r2.runs).batch, 1);
});

test('çökme koruması: her deneme önce işaretlenir, bitince silinir; yarım kalan deneme bir sonraki testte sınır olur', async () => {
  const g = fakeGuard();
  const f = fakeClients({ msPerSecAudio: { 1: 20, 2: 18, 4: 16 } });
  await runSepBench({ createClient: f.createClient, now: f.now, guard: g });
  assert.deepEqual(g.st.marks, [1, 2, 4]);
  assert.equal(g.st.inflight, null, 'başarılı bitişte işaret silinir');
  // sayfa toplu 2'de gitmiş: işaret kalmış
  const crashed = fakeGuard({ inflight: 2 });
  const f2 = fakeClients({ msPerSecAudio: { 1: 20, 2: 18, 4: 16 } });
  const r = await runSepBench({ createClient: f2.createClient, now: f2.now, guard: crashed, nowMs: () => 5000 });
  assert.equal(r.interrupted, 2);
  assert.equal(r.cap, 2);
  assert.deepEqual(r.runs.map((x) => x.batch), [1], '2 ve üstü atlanır');
  assert.equal(crashed.st.cap.batch, 2, 'sınır kalıcılaşır');
  assert.equal(crashed.st.inflight, null);
  // sınır sonraki testte de geçerli (7 gün içinde), sonra silinir
  const again = fakeGuard({ cap: { batch: 2, at: 1000 } });
  const f3 = fakeClients({ msPerSecAudio: { 1: 20, 2: 18, 4: 16 } });
  const r3 = await runSepBench({ createClient: f3.createClient, now: f3.now, guard: again, nowMs: () => 1000 + 86400000 });
  assert.equal(r3.cap, 2);
  assert.deepEqual(r3.runs.map((x) => x.batch), [1]);
  const expired = fakeGuard({ cap: { batch: 2, at: 1000 } });
  const f4 = fakeClients({ msPerSecAudio: { 1: 20, 2: 18, 4: 16 } });
  const r4 = await runSepBench({ createClient: f4.createClient, now: f4.now, guard: expired, nowMs: () => 1000 + 8 * 86400000 });
  assert.equal(r4.cap, undefined);
  assert.deepEqual(r4.runs.map((x) => x.batch), [1, 2, 4]);
  // hata yakalanırsa (sayfa gitmedi) çökme sayılmaz
  const errG = fakeGuard();
  const e = fakeClients({ failBatch: 1 });
  await runSepBench({ createClient: e.createClient, now: e.now, guard: errG });
  assert.equal(errG.st.inflight, null);
  assert.equal(errG.st.cap, null);
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

test('runBench ve formatBench: aşamalar bağımsız, çıktı satırları, uyarılar', async () => {
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
  assert.ok(L.some((l) => /^ {2}toplu 2: 0\.09 rtf \(11\.1× gerçek zaman\)$/.test(l)), L.join('\n'));
  assert.ok(L.includes('  en hızlı: toplu 2'));
  assert.ok(L.some((l) => /^ {2}toplu 4 denenmedi: tahmini tek GPU işi 1\.1 sn > 0\.8 sn \(sürücü sınırına yakın\)$/.test(l)), L.join('\n'));
  assert.ok(L.some((l) => /^seslendirme: 3 cümle, 0\.20 rtf \(5\.0× gerçek zaman\)$/.test(l)));
  assert.ok(L.some((l) => /^çeviri: hata — motor kapalı$/.test(l)));
  const none = formatBench({});
  assert.deepEqual(none, ['ses ayırma: çalıştırılmadı', 'seslendirme: çalıştırılmadı', 'çeviri: çalıştırılmadı']);
  const w = fakeClients({ backend: 'wasm' });
  const Lw = formatBench({ sep: await runSepBench({ createClient: w.createClient, now: w.now }) });
  assert.ok(Lw.some((l) => /WebGPU yok/.test(l)));
  // yarım kalan önceki test: uyarı satırı (koşu olmasa da görünür)
  const g = fakeGuard({ inflight: 1 });
  const none2 = fakeClients();
  const Li = formatBench({ sep: await runSepBench({ createClient: none2.createClient, now: none2.now, guard: g }) });
  assert.ok(Li.some((l) => /UYARI: önceki test toplu 1'de yarım kaldı/.test(l)), Li.join('\n'));
});

test('tanılama raporu: [Hız testi] bölümü yalnız veri varsa', () => {
  const base = { version: '0.5.3', browser: 'Chrome', platform: 'Linux', settings: normalizeSettings({}), now: 0 };
  assert.ok(!buildReport(base).includes('[Hız testi]'));
  const text = buildReport({ ...base, bench: ['ses ayırma: arka uç webgpu', 'çeviri: 8 cümle, 6.1 cümle/sn'], benchAt: 0 });
  assert.match(text, /\[Hız testi \(1970-01-01T00:00:00Z\)\]\nses ayırma: arka uç webgpu\nçeviri: 8 cümle, 6\.1 cümle\/sn/);
});
