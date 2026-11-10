// Hız testi yardımcıları (common/bench.js): sahte ayırma istemcisi, sentez ve çeviriyle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BENCH, mean, rtf, benchSignal, runSepBench, runTtsBench, runMtBench, runBench, fastestBatch, formatBench,
  estJobSec, collectEnv, formatEnv,
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
function fakeClients({ backend = 'webgpu', msPerSecAudio = { 1: 100, 2: 90, 4: 80 }, failBatch = null, stepSec = 2.96,
  windows = false, liteMs = 40, failLite = false } = {}) {
  let clock = 0;
  const made = [];
  const createClient = () => {
    let batch = 1, lite = false;
    const c = {
      calls: [],
      async load(o) {
        batch = o.batch; lite = o.quality === 'fast'; c.calls.push(['load', o]); clock += 100;
        if (failBatch === batch && !lite) throw new Error('bellek yetmedi');
        if (failLite && lite) throw new Error('hafif model yok');
        return { backend, model: lite ? 'mdxnet-lite' : 'kim-vocal-2', stepSec };
      },
      async process(l, r, rate, o) {
        const sec = l.length / rate;
        c.calls.push(['process', sec, o]);
        const work = sec * (lite ? liteMs : (msPerSecAudio[batch] || 100));
        // hız sınırı: iş en az ses süresi × targetRtf sürer, fark bekleme
        const idle = o?.pace ? Math.max(0, sec * 1000 * o.pace.targetRtf - work) : 0;
        clock += work + idle;
        return windows ? { windows: Math.round(sec / stepSec * 1000) / 1000, idleMs: idle } : {};
      },
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
  assert.deepEqual(g.st.marks, [1, 2, 4, 4, 1], 'ek ölçümler de işaretlenir (hız sınırı en hızlı toplulukta, hafif model toplu 1)');
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

test('pencere ve tek GPU işi süresi: ölçülen iş / pencere, × toplu; bekleme düşülür', async () => {
  const f = fakeClients({ windows: true, msPerSecAudio: { 1: 20, 2: 18, 4: 16 } });
  const r = await runSepBench({ createClient: f.createClient, now: f.now, extras: false });
  // toplu 2: 18 ms/sn ses × 2.96 sn adım ≈ 53 ms pencere, × 2 ≈ 107 ms GPU işi
  const b2 = r.runs.find((x) => x.batch === 2);
  assert.ok(Math.abs(b2.windowMs - 18 * 2.96) < 0.5, String(b2.windowMs));
  assert.ok(Math.abs(b2.jobMs - 2 * b2.windowMs) < 1e-9);
  const L = formatBench({ sep: r });
  assert.ok(L.includes('  toplu 2: 0.02 rtf (55.6× gerçek zaman) · pencere 53 ms · GPU işi 107 ms'), L.join('\n'));
  // pencere sayısı yoksa satır eski biçimde kalır
  const g = fakeClients();
  const Lg = formatBench({ sep: await runSepBench({ createClient: g.createClient, now: g.now, extras: false }) });
  assert.ok(Lg.includes('  toplu 1: 0.10 rtf (10.0× gerçek zaman)'), Lg.join('\n'));
  // hız sınırlı ölçümde pencere süresi beklemeyi saymaz
  const p = fakeClients({ windows: true, msPerSecAudio: { 1: 20, 2: 18, 4: 16 } });
  const rp = await runSepBench({ createClient: p.createClient, now: p.now });
  assert.ok(Math.abs(rp.paced.windowMs - 16 * 2.96) < 0.5, String(rp.paced.windowMs));
});

test('estJobSec: pencere süresi ve rtf × adımdan büyüğü; ölçülen pencere uzunsa sonraki toplu denenmez', () => {
  assert.equal(estJobSec(null, 2), 0);
  assert.ok(Math.abs(estJobSec({ rtf: 0.1, stepSec: 2.96 }, 2) - 0.592) < 1e-9);
  assert.equal(estJobSec({ rtf: 0.1, stepSec: 2.96, windowMs: 500 }, 2), 1);
});

test('hız sınırı ve hafif model: yalnız WebGPU\'da, en hızlı güvenli toplu boyutta; satır biçimleri', async () => {
  const f = fakeClients({ windows: true, msPerSecAudio: { 1: 20, 2: 18, 4: 16 } });
  const steps = [];
  const r = await runSepBench({ createClient: f.createClient, now: f.now, onStep: (x) => steps.push(x) });
  assert.equal(r.paced.batch, 4);
  assert.equal(r.paced.targetRtf, BENCH.paceRtf);
  assert.ok(Math.abs(r.paced.rtf - 0.6) < 1e-9, 'sınırla gerçek zamanın 0.6\'sı');
  // 2 ölçülen parça × 8 sn × (0.6 − 0.016) sn bekleme
  assert.ok(Math.abs(r.paced.idleMs - 2 * 8 * (600 - 16)) < 1, String(r.paced.idleMs));
  const pacedCalls = f.made[3].calls.filter((c) => c[0] === 'process');
  assert.ok(pacedCalls.every((c) => c[2].pace?.targetRtf === 0.6), 'pace işçiye gider');
  assert.equal(f.made[4].calls[0][1].quality, 'fast');
  assert.equal(f.made[4].calls[0][1].batch, 1);
  assert.equal(r.lite.model, 'mdxnet-lite');
  assert.ok(steps.some((x) => /hız sınırı 0\.6 \(toplu 4\), parça 2\/3/.test(x)), steps.join('\n'));
  assert.ok(steps.some((x) => /hafif model \(toplu 1\) yükleniyor/.test(x)), steps.join('\n'));
  const L = formatBench({ sep: r });
  assert.ok(L.includes('  hız sınırı 0.6: 0.60 rtf · bekleme 9.3 sn (toplu 4)'), L.join('\n'));
  assert.ok(L.some((l) => /^ {2}hafif model: 0\.04 rtf \(25\.0× gerçek zaman\) · model mdxnet-lite · pencere 118 ms · GPU işi 118 ms$/.test(l)), L.join('\n'));
  // WASM'da ek ölçüm yok (hafif model zaten kullanılıyor; hız sınırı yalnız GPU'da)
  const w = fakeClients({ backend: 'wasm' });
  const rw = await runSepBench({ createClient: w.createClient, now: w.now });
  assert.equal(rw.paced, undefined);
  assert.equal(rw.lite, undefined);
  assert.equal(w.made.length, 1);
});

test('0.8 sn kuralı ek ölçümlerde de: ölçülen GPU işi sınırı aşan toplu boyutta hız sınırı ölçülmez; çökme sınırı ek ölçümleri de keser', async () => {
  // toplu 1 pencere 30 ms/sn × 2.96 ≈ 89 ms; toplu 2'de işçi yavaşlıyor: 400 ms/sn → GPU işi ≈ 2.4 sn (ölçüldü ama güvensiz)
  const f = fakeClients({ windows: true, msPerSecAudio: { 1: 30, 2: 400 } });
  const r = await runSepBench({ createClient: f.createClient, now: f.now });
  assert.ok(r.runs[1].jobMs > 800);
  assert.ok(r.stopped && r.stopped.batch === 4, 'toplu 4 tahminle durur');
  assert.equal(r.paced.batch, 1, 'hız sınırı güvenli toplu 1\'de');
  // yavaş GPU: toplu 1 bile sınırı aşıyorsa hız sınırı ölçülmez; hafif model (daha hafif) toplu 1'de yine ölçülür
  const s = fakeClients({ windows: true, msPerSecAudio: { 1: 400 } });
  const rs = await runSepBench({ createClient: s.createClient, now: s.now });
  assert.equal(rs.paced, undefined);
  assert.ok(rs.lite.rtf > 0);
  // önceki test toplu 1'de yarım kaldı: hiçbir ölçüm yapılmaz
  const g = fakeGuard({ inflight: 1 });
  const c = fakeClients({ windows: true });
  const rc = await runSepBench({ createClient: c.createClient, now: c.now, guard: g, nowMs: () => 5000 });
  assert.equal(c.made.length, 0);
  assert.equal(rc.paced, undefined);
  assert.equal(rc.lite, undefined);
  // hafif model ölçümünde çökme: işaret toplu 1 kalır → sonraki test hepsini atlar
  const g2 = fakeGuard();
  const c2 = fakeClients({ windows: true });
  let hang;
  const crashing = () => {
    const cl = c2.createClient();
    const load = cl.load;
    cl.load = async (o) => (o.quality === 'fast' ? new Promise((_, rej) => { hang = rej; }) : load(o));
    return cl;
  };
  const pending = runSepBench({ createClient: crashing, now: c2.now, guard: g2 });
  while (!hang) await new Promise((res) => setTimeout(res, 10));
  assert.equal(g2.st.inflight, 1, 'hafif model denemesi işaretli (sayfa burada giderse toplu 1 sınır olur)');
  hang(new Error('kesildi'));
  await pending;
  assert.equal(g2.st.inflight, null);
});

test('bir adım hata verince diğerleri sürer (ek ölçüm, aşama fırlatsa bile)', async () => {
  const f = fakeClients({ windows: true, msPerSecAudio: { 1: 20, 2: 18, 4: 16 }, failLite: true });
  const res = await runBench({
    sep: { createClient: f.createClient, now: f.now },
    tts: { synth: async () => { throw new Error('ses yok'); }, device: async () => ({ device: 'wasm', threads: 4 }) },
    mt: { translate: async () => {} },
    now: (() => { let t = 0; return () => (t += 61000); })(),
  });
  assert.match(res.sep.lite.error, /hafif model yok/);
  assert.ok(res.sep.paced.rtf > 0, 'hafif model hatası hız sınırını etkilemez');
  const L = formatBench(res);
  assert.ok(L.includes('  hafif model: hata — hafif model yok'), L.join('\n'));
  assert.ok(L.includes('seslendirme: hata — ses yok'));
  assert.ok(L.includes('  TTS aygıtı: wasm (4 iş parçacığı)'), L.join('\n'));
  assert.ok(/^çeviri: 8 cümle/.test(L.find((l) => l.startsWith('çeviri'))));
  assert.equal(L.at(-1), 'toplam süre: 61 sn');
  // aşamanın kendisi fırlatırsa (ör. createClient) yine diğerleri çalışır
  const r2 = await runBench({
    sep: { createClient: () => { throw new Error('işçi açılamadı'); } },
    mt: { translate: async () => {} },
  });
  assert.match(formatBench(r2).join('\n'), /toplu 1: hata — işçi açılamadı/);
  const r3 = await runBench({ sep: { get createClient() { throw new Error('bozuk'); } }, mt: { translate: async () => {} } });
  assert.equal(formatBench(r3)[0], 'ses ayırma: hata — bozuk');
  assert.ok(r3.mt.perSec > 0);
});

test('TTS aygıtı: seçili sesin aygıtı raporda; aygıt bilgisi alınamazsa satır yok', async () => {
  const r = await runTtsBench({ synth: async () => ({ ms: 500, audioSec: 2 }), device: async () => ({ device: 'webgpu' }) });
  assert.deepEqual(r.device, { device: 'webgpu' });
  assert.ok(formatBench({ tts: r }).includes('  TTS aygıtı: webgpu'));
  const r2 = await runTtsBench({ synth: async () => ({ ms: 500, audioSec: 2 }), device: async () => { throw new Error('x'); } });
  assert.equal(r2.device, undefined);
  assert.ok(!formatBench({ tts: r2 }).some((l) => /TTS aygıtı/.test(l)));
  const sk = await runTtsBench({ synth: async () => ({ skipped: 'sistem sesi' }), device: async () => ({ device: 'wasm', threads: 1 }) });
  assert.ok(!formatBench({ tts: sk }).some((l) => /TTS aygıtı/.test(l)), 'sistem sesinde aygıt yok');
});

test('ortam başlığı: platform, Chrome ve eklenti sürümü, ekran kartı, çekirdek, bellek, yalıtım', async () => {
  const win = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    userAgentData: { platform: 'Windows', brands: [{ brand: 'Not A Brand', version: '99' }, { brand: 'Google Chrome', version: '141' }] },
    hardwareConcurrency: 16, deviceMemory: 8,
  };
  const e = collectEnv({ nav: win, adapter: 'nvidia blackwell', coi: true, version: '0.5.14' });
  assert.deepEqual(formatEnv(e), [
    'ortam: Windows · Chrome 141 · LocaDub 0.5.14',
    'ekran kartı: nvidia blackwell (WebGPU)',
    'işlemci: 16 çekirdek · bellek ≥8 GB · crossOriginIsolated evet',
  ]);
  // userAgentData yoksa userAgent'tan; bellek bilinmiyorsa yazılmaz; WebGPU yoksa söylenir
  const mac = collectEnv({ nav: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.1.2 Safari/537.36', hardwareConcurrency: 10 } });
  assert.deepEqual(formatEnv(mac), ['ortam: macOS · Chrome 140 · LocaDub ?', 'ekran kartı: WebGPU yok', 'işlemci: 10 çekirdek · crossOriginIsolated hayır']);
  assert.equal(collectEnv({ nav: { deviceMemory: 4 } }).memoryGb, 4);
  assert.equal(collectEnv().platform, 'bilinmiyor');
  // başlık çıktının ilk satırları
  const res = await runBench({ env: e, mt: { translate: async () => {} } });
  const L = formatBench(res);
  assert.equal(L[0], 'ortam: Windows · Chrome 141 · LocaDub 0.5.14');
  assert.equal(L[3], 'ses ayırma: çalıştırılmadı');
});
