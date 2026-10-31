// Gerçek dublaj (ses ayırma) saf parçaları: PCM zaman çizelgesi, paket deposu, parça planlayıcı, bekletme histerezisi,
// bağlam kırpma + çapraz geçiş (sahte ayırıcıyla), WebM/MP4 ayrıştırıcı (ffmpeg varsa).
//   node --test tests/extension/separation.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  SEP, PacketStore, PcmTimeline, HoldGate, DriftMeter, planNext, runJob, writeResult, aheadOf, windowFor, bestLag,
  planStream, writeStreamResult, mergeRanges, streamChunkSec,
} from '../../extension/content/sep-core.js';
import { WebmDemuxer, Mp4Demuxer, createDemuxer, opusDuration } from '../../extension/content/sep-demux.js';
import { handleMessage as handleMock } from '../../extension/engines/_mock/sep.js';

const SR = 1000; // testte küçük örnekleme hızı: dizinler okunaklı
const ramp = (n, from = 0) => Float32Array.from({ length: n }, (_, i) => from + i);
const near = (a, b, eps = 1e-5) => Math.abs(a - b) <= eps;

// ---- PcmTimeline ----

test('PCM: bitişik yazımlar birleşir, boşluk ayrı aralık, okuma boşluğu sıfırla doldurur', () => {
  const tl = new PcmTimeline(SR);
  tl.write(0, ramp(100));
  tl.write(100, ramp(50, 100));
  assert.deepEqual(tl.ranges(), [[0, 150]]);
  tl.write(200, ramp(50, 200));
  assert.deepEqual(tl.ranges(), [[0, 150], [200, 250]]);
  const { L } = tl.read(140, 210);
  assert.equal(L[0], 140);
  assert.equal(L[9], 149);
  assert.equal(L[10], 0); // boşluk
  assert.equal(L[60], 200);
  assert.equal(tl.contiguousEnd(10), 150);
  assert.equal(tl.contiguousEnd(170), -1);
  // boşluğu dolduran yazım üç parçayı birleştirir
  tl.write(150, ramp(50, 150));
  assert.deepEqual(tl.ranges(), [[0, 250]]);
  assert.deepEqual(Array.from(tl.read(0, 250).L), Array.from(ramp(250)));
  // tolerans: 2 örneklik boşluk bitişik sayılır
  tl.write(252, ramp(10, 252));
  assert.equal(tl.ranges().length, 1);
});

test('PCM: çakışmada var olan kazanır; kenarda çapraz geçiş', () => {
  const tl = new PcmTimeline(SR);
  tl.write(0, new Float32Array(100).fill(1)); // [0,100) = 1
  // yeni [80, 200) = 3: [80,100) örtüşür → var olan parça yeni verinin içinde bitiyor → 1'den 3'e geçiş
  tl.write(80, new Float32Array(120).fill(3), undefined, { xf: 20 });
  const { L } = tl.read(0, 200);
  assert.equal(L[79], 1);
  assert.ok(L[80] > 1 && L[80] < 1.2, `geçiş başı ${L[80]}`);
  assert.ok(L[99] > 2.8 && L[99] < 3, `geçiş sonu ${L[99]}`);
  for (let i = 81; i < 100; i++) assert.ok(L[i] >= L[i - 1], 'tekdüze artmalı');
  assert.equal(L[100], 3);
  // tamamen içerilen yazım: var olan veri değişmez
  tl.write(10, new Float32Array(20).fill(9), undefined, { xf: 5 });
  assert.equal(tl.read(10, 30).L.every((x) => x === 1), true);
  // boşluk doldururken sonda yeni → var olan
  const t2 = new PcmTimeline(SR);
  t2.write(100, new Float32Array(100).fill(2));
  t2.write(0, new Float32Array(120).fill(4), undefined, { xf: 20 }); // [100,120) örtüşür: 4 → 2
  const r = t2.read(0, 200).L;
  assert.equal(r[99], 4);
  assert.ok(r[100] < 4 && r[100] > 3.8);
  assert.ok(r[119] > 2 && r[119] < 2.2);
  assert.equal(r[120], 2);
});

test('PCM: budama (geride / çok ileride kalan atılır)', () => {
  const tl = new PcmTimeline(SR);
  tl.write(0, ramp(1000));
  tl.prune(300, 700);
  assert.deepEqual(tl.ranges(), [[300, 700]]);
  assert.equal(tl.read(300, 301).L[0], 300);
  assert.deepEqual(tl.rangesSec(), [[0.3, 0.7]]);
});

// ---- PacketStore (kodlanmış zaman çizelgesi: ekleme / ileri sarma / boşluk / çakışma) ----

const pk = (t, dur = 0.02) => ({ t, dur, data: new Uint8Array(1) });

test('Paketler: sıralı ekleme, ileri sarma sonrası boşluk, geri dolan aralık, çakışan yeniden ekleme', () => {
  const s = new PacketStore();
  for (let i = 0; i < 100; i++) s.add(pk(i * 0.02)); // 0–2 sn
  assert.deepEqual(s.ranges().map((r) => r.map((x) => +x.toFixed(3))), [[0, 2]]);
  // ileri sarma: 10 sn'den sonrası gelir
  for (let i = 0; i < 50; i++) s.add(pk(10 + i * 0.02));
  assert.equal(s.ranges().length, 2);
  assert.equal(s.rangeAt(1), s.ranges()[0]);
  assert.equal(s.rangeAt(5), null);
  // geri sarma: aradaki boşluk dolar (sıra dışı ekleme)
  for (let i = 0; i < 400; i++) s.add(pk(2 + i * 0.02));
  assert.equal(s.ranges().length, 1);
  assert.ok(near(s.ranges()[0][1], 11));
  // aynı zamanlara yeniden ekleme (kalite değişimi): sayı artmaz, yenisi kazanır
  const n = s.size;
  const fresh = { t: 4, dur: 0.02, data: new Uint8Array([7]) };
  s.add(fresh);
  assert.equal(s.size, n);
  assert.equal(s.packetsIn(4, 4.01)[0], fresh);
  // farklı boylu (40 ms) yeniden ekleme iki eskiyi örter
  s.add({ t: 6, dur: 0.04, data: new Uint8Array(1) });
  assert.equal(s.size, n - 1);
  assert.equal(s.ranges().length, 1);
  assert.equal(s.packetsIn(1, 1.05).length, 3);
  s.prune(5);
  assert.ok(s.list[0].t >= 5);
});

// ---- planlayıcı ----

const base = { duration: 100, windowSec: 32, ctxSec: 1, xfSec: 0.05 };

test('Plan: oynatma konumundan başlar, tam parça, bağlam iki yanda', () => {
  const j = planNext({ ...base, t: 5, raw: [[0, 60]], sep: [] });
  assert.deepEqual(j, { a: 5, b: 17, ctxL: 1, ctxR: 1 });
  // başta sol bağlam yok
  assert.deepEqual(planNext({ ...base, t: 0, raw: [[0, 60]], sep: [] }), { a: 0, b: 12, ctxL: 0, ctxR: 1 });
});

test('Plan: en yakın önce — ayrılmış parçanın (xf kuyruğu hariç) sonundan devam', () => {
  const j = planNext({ ...base, t: 5, raw: [[0, 60]], sep: [[5, 17.05]] });
  assert.ok(near(j.a, 17) && near(j.b, 29), JSON.stringify(j));
  // konum kuyruktaysa kuyruğun sonundan
  const k = planNext({ ...base, t: 17.02, raw: [[0, 60]], sep: [[5, 17.05]] });
  assert.ok(near(k.a, 17.05), JSON.stringify(k));
});

test('Plan: ileri pencere sınırı; video sonu; sonraki parçaya kadar boşluk doldurma', () => {
  assert.equal(planNext({ ...base, t: 0, raw: [[0, 100]], sep: [[0, 40.05]], windowSec: 32 }), null);
  const end = planNext({ ...base, t: 95, raw: [[0, 100]], sep: [] });
  assert.deepEqual(end, { a: 95, b: 100, ctxL: 1, ctxR: 0 });
  assert.equal(planNext({ ...base, t: 99.99, raw: [[0, 100]], sep: [[90, 100]] }), null);
  // geri sarma: [20, 32.05] hazır, konum 15 → [15, 20] (sonraki parçayla xf'de çapraz geçecek)
  const gap = planNext({ ...base, t: 15, raw: [[0, 60]], sep: [[20, 32.05]] });
  assert.deepEqual(gap, { a: 15, b: 20, ctxL: 1, ctxR: 1 });
});

test('Plan: girdi yetmezse acil değilken bekle, acilken kısa parça; girdi yoksa null', () => {
  // ham girdi 10 sn'ye kadar: tam parça (12 sn) için yetmiyor
  assert.equal(planNext({ ...base, t: 0, raw: [[0, 10]], sep: [[0, 0]], aheadSec: 20 }), null);
  const urgent = planNext({ ...base, t: 0, raw: [[0, 10]], sep: [], aheadSec: 0 });
  assert.deepEqual(urgent, { a: 0, b: 9, ctxL: 0, ctxR: 1 });
  // minSec'ten kısa: bekle
  assert.equal(planNext({ ...base, t: 0, raw: [[0, 2.5]], sep: [], aheadSec: 0 }), null);
  // konumda girdi yok (ağ)
  assert.equal(planNext({ ...base, t: 30, raw: [[0, 10]], sep: [] }), null);
  // video sonunda sağ bağlam beklenmez
  assert.deepEqual(planNext({ ...base, t: 98, raw: [[0, 100]], sep: [] }), { a: 98, b: 100, ctxL: 1, ctxR: 0 });
  assert.equal(windowFor(20), 32);
  assert.equal(windowFor(5), 20);
});

test('Hazır süre: kuyruk sayılmaz, video sonunda sayılır', () => {
  assert.ok(near(aheadOf([[0, 12.05]], 2, { duration: 100 }), 10));
  assert.ok(near(aheadOf([[90, 100]], 95, { duration: 100 }), 5));
  assert.equal(aheadOf([[20, 30]], 5, { duration: 100 }), 0);
});

// ---- bekletme ----

test('Bekletme: başta ön tampon, süre sınırı, oynarken < 2 sn beklet / ≥ 8 sn sür (histerezis)', () => {
  const g = new HoldGate();
  const u = (o) => g.update({ prebufferSec: 20, pending: true, ready: true, elapsedMs: 0, aheadSec: 0, ...o });
  assert.equal(u({ ready: false }), true, 'model yüklenirken beklet');
  assert.equal(u({ aheadSec: 12, elapsedMs: 3000 }), true, 'ön tampon dolmadı');
  assert.equal(u({ aheadSec: 20, elapsedMs: 4000 }), false, 'ön tampon doldu');
  assert.equal(g.initial, false);
  assert.equal(u({ aheadSec: 5 }), false, '≥ 2 sn: sür');
  assert.equal(u({ aheadSec: 1.5 }), true, '< 2 sn: beklet');
  assert.equal(u({ aheadSec: 6 }), true, 'histerezis: 8 sn olana dek bekle');
  assert.equal(u({ aheadSec: 8 }), false);
  // girdi darboğazı: işlenecek bir şey yoksa bekletme
  assert.equal(u({ aheadSec: 0.5, pending: false }), false);
  // hata: asla bekletme
  assert.equal(u({ aheadSec: 0, failed: true }), false);

  const t = new HoldGate();
  assert.equal(t.update({ prebufferSec: 5, pending: true, ready: true, elapsedMs: 4000, aheadSec: 1 }), true);
  // süre doldu, hâlâ yetersiz: olağan kurala geçer, bekleme 8 sn'ye kadar sürer
  assert.equal(t.update({ prebufferSec: 5, pending: true, ready: true, elapsedMs: 6000, aheadSec: 3 }), true);
  assert.equal(t.initial, false);
  assert.equal(t.update({ prebufferSec: 5, pending: true, ready: true, elapsedMs: 7000, aheadSec: 8.5 }), false);
  // süre doldu ama model hâlâ iniyor: video orijinal sesle sürer
  const m = new HoldGate();
  assert.equal(m.update({ prebufferSec: 5, pending: true, ready: false, elapsedMs: 6000, aheadSec: 0 }), false);
});

test('Bekletme: kullanıcı oynatırsa ayırma yeniden yetişene dek bekletilmez', () => {
  const g = new HoldGate();
  const u = (o) => g.update({ prebufferSec: 5, pending: true, ready: true, elapsedMs: 60000, aheadSec: 0, ...o });
  g.initial = false;
  assert.equal(u({ aheadSec: 1 }), true);
  g.userOverride();
  assert.equal(u({ aheadSec: 1 }), false);
  assert.equal(u({ aheadSec: 5 }), false);
  assert.equal(u({ aheadSec: 9 }), false); // yeniden yetişti: kural yeniden etkin
  assert.equal(u({ aheadSec: 1 }), true);
});

test('Kayma ölçer: ortanca 40 ms\'yi aşınca yeniden eşitle; tek sıçrama yetmez', () => {
  const d = new DriftMeter();
  for (const x of [0.01, 0.2, 0.0, 0.01]) assert.equal(d.push(x), false);
  assert.equal(d.push(0.02), false);
  for (const x of [0.05, 0.06, 0.05]) d.push(x);
  assert.equal(d.push(0.07), true);
  assert.ok(d.median > 0.04);
});

test('Gecikme ölçümü (çapraz ilinti)', () => {
  let s = 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  const a = Float32Array.from({ length: 2000 }, rnd);
  const b = new Float32Array(2000);
  for (let i = 30; i < 2000; i++) b[i] = 0.5 * a[i - 30]; // b, 30 örnek geride
  assert.equal(bestLag(a, b, 100).lag, 30);
});

// ---- kırpma + çapraz geçiş, sahte ayırıcıyla uçtan uca ----

async function mockWorker() {
  const posted = [];
  globalThis.self = { postMessage: (m) => posted.push(m) };
  await import('../../extension/engines/_mock/sep.js?' + Date.now());
  const w = globalThis.self;
  await w.onmessage({ data: { type: 'load', id: 1 } });
  const loaded = posted.find((m) => m.type === 'loaded');
  assert.equal(loaded.backend, 'mock');
  assert.ok(posted.some((m) => m.type === 'progress'));
  let id = 10;
  return {
    contextSec: loaded.contextSec,
    separate: (L, R, sampleRate) => new Promise((resolve, reject) => {
      const my = ++id;
      const poll = setInterval(() => {
        const m = posted.find((x) => x.id === my && (x.type === 'result' || x.type === 'error'));
        if (!m) return;
        clearInterval(poll);
        if (m.type === 'error') reject(new Error(m.message)); else resolve(m);
      }, 1);
      w.onmessage({ data: { type: 'process', id: my, left: L, right: R, sampleRate } });
    }),
  };
}

test('Sahte ayırıcıyla parça parça işleme: bağlam kırpılır, ekler dikişsiz (girdi × 0.5)', async () => {
  const sr = 8000, dur = 40;
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  const rawL = Float32Array.from({ length: sr * dur }, rnd), rawR = Float32Array.from({ length: sr * dur }, rnd);
  const raw = new PcmTimeline(sr);
  raw.write(0, rawL, rawR);
  const mock = await mockWorker();
  const sep = new PcmTimeline(sr);
  const readRaw = async (ra, rb) => raw.read(ra, rb);
  const jobs = [];
  // oynatma 3 sn'de; pencere dolana dek planla + işle
  for (let guard = 0; guard < 20; guard++) {
    const j = planNext({ t: 3, raw: [[0, dur]], sep: sep.rangesSec(), duration: dur, windowSec: 30, ctxSec: mock.contextSec, xfSec: 0.05 });
    if (!j) break;
    jobs.push(j);
    await runJob(j, { timeline: sep, readRaw, separate: mock.separate, xfSec: 0.05 });
  }
  assert.ok(jobs.length >= 3, JSON.stringify(jobs));
  assert.ok(near(jobs[0].a, 3) && near(jobs[1].a, 15), JSON.stringify(jobs));
  assert.equal(sep.ranges().length, 1, 'kesintisiz');
  const [[s0, s1]] = sep.ranges();
  assert.equal(s0, 3 * sr);
  const out = sep.read(s0, s1);
  let maxErr = 0;
  for (let i = 0; i < out.L.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(out.L[i] - 0.5 * rawL[s0 + i]), Math.abs(out.R[i] - 0.5 * rawR[s0 + i]));
  }
  assert.ok(maxErr < 1e-6, 'ekler dikişsiz olmalı, en büyük hata ' + maxErr);
});

test('Kırpma: sonucun bağlam bölgesi atılır; ekte önceki parçanın kuyruğu ile doğrusal geçiş', () => {
  const sr = 1000;
  const tl = new PcmTimeline(sr);
  // ilk parça [0,2], sağ bağlam 1 sn → işçi sonucu 3 sn; değer = 1
  writeResult(tl, { a: 0, b: 2, ctxL: 0, ctxR: 1 }, new Float32Array(3000).fill(1), new Float32Array(3000).fill(1), { xfSec: 0.05 });
  assert.deepEqual(tl.ranges(), [[0, 2050]], 'çekirdek + 50 ms kuyruk');
  // ikinci parça [2,4], iki yanda bağlam; işçi sonucu farklı (2): sol bağlam [1,2] kırpılır
  const res = new Float32Array(4000).fill(2);
  res.fill(99, 0, 1000); // sol bağlam bölgesi: yazılmamalı
  writeResult(tl, { a: 2, b: 4, ctxL: 1, ctxR: 1 }, res, res, { xfSec: 0.05 });
  const { L } = tl.read(0, 4050);
  assert.ok(!L.includes(99), 'bağlam kırpılmadı');
  assert.equal(L[1999], 1);
  assert.ok(L[2000] > 1 && L[2000] < 1.05);
  assert.ok(L[2049] > 1.95 && L[2049] < 2);
  assert.equal(L[2050], 2);
  assert.equal(tl.ranges()[0][1], 4050);
});

// ---- ayrıştırıcılar ----

function ffmpeg(args) {
  try { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]); return true; } catch { return false; }
}

function pushIn(d, bytes, size) {
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(...d.push(bytes.subarray(i, i + size)));
  return out;
}

test('Opus paket süresi (TOC)', () => {
  assert.equal(opusDuration(new Uint8Array([0xFC])), 0.02); // CELT 20 ms, 1 çerçeve
  assert.equal(opusDuration(new Uint8Array([0xFD])), 0.04); // 2 çerçeve
  assert.equal(opusDuration(new Uint8Array([0x1B, 0x03])), 0.18); // SILK 60 ms × 3
  assert.equal(createDemuxer('video/webm; codecs="vp9"'), null);
  assert.ok(createDemuxer('audio/webm; codecs="opus"') instanceof WebmDemuxer);
  assert.ok(createDemuxer('audio/mp4; codecs="mp4a.40.2"') instanceof Mp4Demuxer);
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locadub-sep-'));
const webm = path.join(dir, 'a.webm'), mp4 = path.join(dir, 'a.mp4');
const haveWebm = ffmpeg(['-f', 'lavfi', '-i', 'anoisesrc=d=7:c=white:a=0.3:r=48000', '-ac', '2', '-c:a', 'libopus', '-b:a', '96k', webm]);
const haveMp4 = ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=7:sample_rate=44100', '-c:a', 'aac', '-f', 'mp4',
  '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000', mp4]);

test('WebM/opus: paketler kesintisiz, zaman damgaları doğru; rastgele bölünmüş eklemelerle aynı sonuç', { skip: !haveWebm && 'ffmpeg yok' }, () => {
  const b = new Uint8Array(fs.readFileSync(webm));
  const whole = new WebmDemuxer().push(b);
  const d = new WebmDemuxer();
  const parts = pushIn(d, b, 777);
  assert.equal(d.cfg.codec, 'opus');
  assert.equal(d.cfg.numberOfChannels, 2);
  assert.equal(d.cfg.sampleRate, 48000);
  assert.ok(d.cfg.description?.length >= 19, 'OpusHead');
  assert.equal(parts.length, whole.length);
  assert.ok(parts.length > 300);
  for (let i = 0; i < parts.length; i++) {
    assert.equal(parts[i].t, whole[i].t);
    assert.equal(parts[i].data.length, whole[i].data.length);
  }
  const store = new PacketStore();
  for (const p of parts) store.add(p);
  assert.equal(store.ranges().length, 1, 'boşluk yok');
  assert.ok(Math.abs(store.ranges()[0][1] - 7) < 0.05, String(store.ranges()[0][1]));
  // timestampOffset
  const again = new WebmDemuxer();
  const first = again.push(b.subarray(0, 3000), { tso: 100 });
  assert.ok(first.every((p) => p.t >= 100));
});

test('WebM: ilklendirme yeniden gelince (kalite değişimi) ve bozuk bayt sonrası yeniden eşitleme', { skip: !haveWebm && 'ffmpeg yok' }, () => {
  const b = new Uint8Array(fs.readFileSync(webm));
  const d = new WebmDemuxer();
  const a = d.push(b);
  const again = d.push(b, { tso: 0 }); // aynı akış baştan (yeni init)
  assert.equal(again.length, a.length);
  assert.equal(d.inits, 2);
  // abort: yarım küme atılır, sonraki kümeden devam
  const d3 = new WebmDemuxer();
  const head = d3.push(b.subarray(0, Math.floor(b.length / 2)));
  d3.abort();
  const cl = (() => { for (let i = Math.floor(b.length / 2); i < b.length - 4; i++) if (b[i] === 0x1F && b[i + 1] === 0x43 && b[i + 2] === 0xB6 && b[i + 3] === 0x75) return i; return -1; })();
  assert.ok(cl > 0);
  const tail = d3.push(b.subarray(cl));
  assert.ok(head.length > 0 && tail.length > 0);
  assert.ok(tail[0].t > head[head.length - 1].t);
  // çöp bayt ardından küme: yeniden eşitlenir
  const d4 = new WebmDemuxer();
  d4.push(b.subarray(0, 600));
  d4.abort();
  const junk = new Uint8Array([0, 0, 0, 7, 1, 2]);
  const got = d4.push(new Uint8Array([...junk, ...b.subarray(cl)]));
  assert.ok(got.length > 0);
});

test('MP4/AAC (parçalı): yapılandırma, zaman damgaları, bölünmüş eklemeler', { skip: !haveMp4 && 'ffmpeg yok' }, () => {
  const b = new Uint8Array(fs.readFileSync(mp4));
  const whole = new Mp4Demuxer('audio/mp4; codecs="mp4a.40.2"').push(b);
  const d = new Mp4Demuxer('audio/mp4; codecs="mp4a.40.2"');
  const parts = pushIn(d, b, 1000);
  assert.equal(d.cfg.codec, 'mp4a.40.2');
  assert.equal(d.cfg.sampleRate, 44100);
  assert.equal(d.cfg.numberOfChannels, 1);
  assert.ok(d.cfg.description?.length >= 2, 'AudioSpecificConfig');
  assert.equal(parts.length, whole.length);
  assert.ok(parts.length > 250);
  assert.ok(near(parts[1].t - parts[0].t, 1024 / 44100, 1e-9));
  const store = new PacketStore();
  for (const p of parts) store.add(p);
  assert.equal(store.ranges().length, 1);
  assert.ok(Math.abs(store.ranges()[0][1] - 7) < 0.1, String(store.ranges()[0][1]));
  const tso = new Mp4Demuxer('audio/mp4').push(b, { tso: 50 });
  assert.ok(near(tso[0].t, parts[0].t + 50));
});

test('SEP sabitleri makul', () => {
  assert.ok(SEP.low < SEP.high && SEP.ctxSec >= SEP.xfSec && SEP.chunkSec >= 10 && SEP.chunkSec <= 15);
});

// ---- akış kipi: planlayıcı, yazma, boru hattı ----

const GEO = { win: 5.92, step: 2.96, lat: 0.005 };

test('Akış planı: yeni akış (bağlam, kısa ilk parça), devam (tam pencereler), final (sınır / video sonu)', () => {
  const base = { raw: [[0, 200]], duration: 200, windowSec: 40, geo: GEO, chunkSec: 4 * GEO.step, ctxSec: 1, xfSec: 0.05 };
  const a = planStream({ ...base, t: 10, sep: [], stream: null });
  assert.equal(a.reset, true);
  assert.equal(a.cont, false);
  assert.ok(near(a.a, 10) && near(a.ra, 9) && near(a.ctxL, 1));
  assert.ok(a.b >= 10 + SEP.firstSec - 1e-6 && a.b < 10 + SEP.firstSec + GEO.step, `ilk parça ${a.b}`);
  assert.ok(near((a.rb - GEO.win - GEO.lat) / GEO.step % 1, 0, 1e-6), 'girdi sonu pencere sonunda');
  // devam: gönderilmiş işin beklenen aralığı sep'te (mergeRanges), girdi akışın sonundan
  const stream = { inEnd: a.rb, out: a.b };
  const b = planStream({ ...base, t: 10, sep: mergeRanges([], [[a.a, a.b]]), stream, aheadSec: 0 });
  assert.equal(b.cont, true);
  assert.equal(b.reset, false);
  assert.ok(near(b.ra, a.rb) && near(b.a, a.b));
  assert.ok(near(b.b - a.b, 4 * GEO.step, 1e-6), 'tam 4 pencere');
  // pencere doluysa yok
  assert.equal(planStream({ ...base, t: 10, sep: [[10, 60]], stream: { inEnd: 63, out: 60 } }), null);
  // sonraki ayrılmış parça yakın: final, sınıra kadar + sağ bağlam
  const c = planStream({ ...base, t: 10, sep: [[10, a.b], [a.b + 3, 90]], stream });
  assert.equal(c.final, true);
  assert.ok(near(c.b, a.b + 3) && near(c.rb, a.b + 4));
  // video sonu
  const d = planStream({ ...base, t: 195, sep: [], stream: null });
  assert.equal(d.final, true);
  assert.ok(near(d.b, 200) && near(d.rb, 200));
  // atlama: akış başka yerde → yeni akış
  const e = planStream({ ...base, t: 120, sep: [[10, a.b]], stream });
  assert.equal(e.reset, true);
  assert.ok(near(e.a, 120));
});

test('Akış planı: girdi yetmezse acil değilken bekle, acilken eldeki pencereler ya da kısa final', () => {
  const base = { duration: 200, windowSec: 40, geo: GEO, chunkSec: 4 * GEO.step, ctxSec: 1, xfSec: 0.05, sep: [[0, 20]] };
  const stream = { inEnd: 20 + GEO.win - GEO.step + GEO.lat, out: 20 };
  assert.equal(planStream({ ...base, t: 0, raw: [[0, 30]], stream, aheadSec: 20 }), null, 'acil değil: tam parçayı bekle');
  const u = planStream({ ...base, t: 17, raw: [[0, 30]], stream, aheadSec: 3 });
  assert.equal(u.cont, true);
  assert.ok(u.rb <= 30 && u.b > 20, JSON.stringify(u));
  const f = planStream({ ...base, t: 19, raw: [[0, 23.5]], stream, aheadSec: 1 });
  assert.equal(f.final, true);
  assert.ok(near(f.b, 22.5) && near(f.rb, 23.5), JSON.stringify(f));
  assert.equal(planStream({ ...base, t: 19, raw: [[0, 22]], stream, aheadSec: 1 }), null, 'girdi yok');
});

test('Akış yazma: yeni akışın bağlamı atılır (xf ile geçiş), orta dikişsiz, final b + xf', () => {
  const tl = new PcmTimeline(SR);
  tl.write(0, new Float32Array(5000).fill(1)); // var olan [0, 5)
  const r1 = { left: new Float32Array(6000).fill(2), right: new Float32Array(6000).fill(2), startSample: 4000, reset: true };
  assert.deepEqual(writeStreamResult(tl, { a: 5, b: 9, ctxL: 1, reset: true }, r1, { xfSec: 0.05 }), [4950, 10000]);
  const { L } = tl.read(4900, 5100);
  assert.equal(L[0], 1);
  assert.ok(L[60] > 1 && L[60] < 2, 'çapraz geçiş');
  assert.equal(L[150], 2);
  const r2 = { left: ramp(3000), right: ramp(3000), startSample: 10000, reset: false };
  assert.deepEqual(writeStreamResult(tl, { a: 10, b: 13, reset: false }, r2), [10000, 13000]);
  assert.deepEqual(tl.ranges(), [[0, 13000]]);
  assert.equal(tl.read(12999, 13000).L[0], 2999);
  // final: sınır 14 + 50 ms
  const r3 = { left: new Float32Array(2000).fill(3), right: new Float32Array(2000).fill(3), startSample: 13000 };
  assert.deepEqual(writeStreamResult(tl, { a: 13, b: 14, final: true, reset: false }, r3, { duration: 100 }), [13000, 14050]);
  // beklenmedik sıfırlama: ilk ctxSec atılır
  const r4 = { left: new Float32Array(3000).fill(4), right: new Float32Array(3000).fill(4), startSample: 20000, reset: true };
  assert.deepEqual(writeStreamResult(tl, { a: 20, b: 23, reset: false }, r4, { ctxSec: 1 }), [21000, 23000]);
});

test('Boru hattı: iki iş uçuşta, sırayla sahte akış işçisinde → önbellek kesintisiz ve girdi × 0.5', async () => {
  const sr = 8000, dur = 60;
  let s = 3;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  const rawL = Float32Array.from({ length: sr * dur }, rnd), rawR = Float32Array.from({ length: sr * dur }, rnd);
  const out = [];
  handleMock({ type: 'load', id: 0 }, (m) => out.push(m));
  const info = out.pop();
  const geo = { win: info.chunkSec, step: info.stepSec };
  const tl = new PcmTimeline(sr);
  let stream = null;
  const inflight = [];
  let id = 0, t = 0;
  const flushOne = () => { // en eski işin sonucu (işçi sırayla yanıtlar)
    const job = inflight.shift();
    writeStreamResult(tl, job, job.res, { duration: dur });
    if (stream && stream.last === job && job.res.left.length) stream.out = (job.res.startSample + job.res.left.length) / sr;
  };
  for (let guard = 0; guard < 200 && t < dur; guard++) {
    while (inflight.length < SEP.inflight) {
      const plan = planStream({
        t, raw: [[0, dur]], sep: mergeRanges(tl.rangesSec(), inflight.map((j) => [j.a, j.b])), stream, geo, duration: dur,
        windowSec: 30, aheadSec: aheadOf(tl.rangesSec(), t, { duration: dur }), chunkSec: streamChunkSec('wasm', geo.step),
      });
      if (!plan) break;
      const raS = plan.cont ? stream.inEndS : Math.round(plan.ra * sr), rbS = Math.round(plan.rb * sr);
      if (plan.final) stream = null;
      else { if (!plan.cont) stream = {}; Object.assign(stream, { inEndS: rbS, inEnd: rbS / sr, out: plan.b, last: plan }); }
      handleMock({ type: 'process', id: ++id, left: rawL.slice(raS, rbS), right: rawR.slice(raS, rbS), sampleRate: sr,
        startSample: raS, final: plan.final, reset: plan.reset }, (m) => { plan.res = m; });
      inflight.push(plan);
    }
    if (inflight.length) flushOne();
    else t += 1; // oynatma ilerler
    if (guard % 3 === 2) t += 4;
  }
  while (inflight.length) flushOne();
  const [[s0, s1]] = tl.ranges();
  assert.equal(tl.ranges().length, 1, 'kesintisiz: ' + JSON.stringify(tl.rangesSec()));
  assert.equal(s0, 0);
  assert.equal(s1, dur * sr);
  const o = tl.read(s0, s1);
  let maxErr = 0;
  for (let i = 0; i < o.L.length; i++) maxErr = Math.max(maxErr, Math.abs(o.L[i] - 0.5 * rawL[i]), Math.abs(o.R[i] - 0.5 * rawR[i]));
  assert.ok(maxErr < 1e-6, 'dikiş ' + maxErr);
});

// ---- bekletme: ölçülen hıza uyan eşikler ----

test('Bekletme (rtf 0.6): gereken ön tampon parça·rtf ile; dolunca süre beklenmeden sürer, oynarken eşik dibi kapsar', () => {
  const g = new HoldGate();
  const chunkSec = 11.84;
  const u = (o) => g.update({ prebufferSec: 20, pending: true, ready: true, elapsedMs: 3000, aheadSec: 0, rtf: 0.6, chunkSec, ...o });
  assert.equal(u({ aheadSec: 5 }), true);
  const need = 2 + chunkSec * 0.6 + 1;
  assert.ok(near(g.needSec, need), String(g.needSec));
  assert.ok(near(g.etaSec, Math.round((need - 5) * 0.6 * 10) / 10), 'eta = (need − ahead)·rtf');
  assert.equal(u({ aheadSec: need }), false, 'gereken doldu');
  assert.equal(g.initial, false);
  assert.equal(g.etaSec, null);
  assert.equal(u({ aheadSec: 1.5 }), true);
  assert.ok(near(g.needSec, need), 'oynarken sürme eşiği = low + dip + 1');
  assert.equal(u({ aheadSec: 8.5 }), true, 'eski 8 sn eşiği parça dibini kapsamaz');
  assert.equal(u({ aheadSec: need }), false);
  // süre dolsa da rtf < 1 iken gereken dolana dek (en çok holdMaxSec) beklenir
  const s = new HoldGate();
  assert.equal(s.update({ prebufferSec: 5, pending: true, ready: true, elapsedMs: 30000, aheadSec: 2, rtf: 0.6, chunkSec }), true);
  assert.equal(s.initial, true);
  assert.ok(near(s.needSec, 5), 'ön tamponla sınırlı');
  assert.equal(s.update({ prebufferSec: 5, pending: true, ready: true, elapsedMs: 31000, aheadSec: 5, rtf: 0.6, chunkSec }), false);
});

test('Bekletme (rtf 0.95 ve 1.3): seyrek, uzun bekleme (30 sn hedef, kalan süreyle sınırlı), eta bildirilir', () => {
  for (const rtf of [0.95, 1.3]) {
    const g = new HoldGate();
    const u = (o) => g.update({ prebufferSec: 10, pending: true, ready: true, elapsedMs: 0, aheadSec: 0, rtf, chunkSec: 23.68, ...o });
    assert.equal(u({ aheadSec: 4, elapsedMs: 5000 }), true);
    assert.equal(g.needSec, 10, 'rtf ≥ 1 ya da yakın: başta ön tampon kadar');
    assert.equal(u({ aheadSec: 10, elapsedMs: 9000 }), false);
    assert.equal(u({ aheadSec: 3 }), false);
    assert.equal(u({ aheadSec: 1.9 }), true);
    assert.equal(g.needSec, SEP.highSlow);
    assert.ok(near(g.etaSec, Math.round((30 - 1.9) * rtf * 10) / 10), `eta ${g.etaSec}`);
    assert.equal(u({ aheadSec: 20 }), true, 'sık kısa bekleme yerine 30 sn\'ye dek');
    assert.equal(u({ aheadSec: 30 }), false);
    // video sonuna yakın: kalan süre kadar
    assert.equal(u({ aheadSec: 1, remainingSec: 12 }), true);
    assert.ok(near(g.needSec, 11.9));
    assert.equal(u({ aheadSec: 11.9, remainingSec: 12 }), false);
  }
  // rtf bilinmiyorken süre dolarsa olağan kurala geçilir (eski davranış, 8 sn)
  const t = new HoldGate();
  assert.equal(t.update({ prebufferSec: 5, pending: true, ready: true, elapsedMs: 4000, aheadSec: 1 }), true);
  assert.equal(t.update({ prebufferSec: 5, pending: true, ready: true, elapsedMs: 6000, aheadSec: 3 }), true);
  assert.equal(t.needSec, SEP.high);
  assert.equal(t.etaSec, null, 'rtf bilinmiyor');
});

test('Bekletme: girdi yokken başlangıçta bekletilmez ama başlangıç evresi bitmez', () => {
  const g = new HoldGate();
  const u = (o) => g.update({ prebufferSec: 20, ready: true, elapsedMs: 3000, aheadSec: 9, pending: true, ...o });
  assert.equal(u({ pending: false }), false);
  assert.equal(g.initial, true, 'kısa girdi boşluğu ön tamponu bitirmemeli');
  assert.equal(u({}), true);
});

test('speechAt: orijinal − eşlik; aralığın tamamı yoksa null', async () => {
  const w = new EventTarget();
  globalThis.window ??= w;
  globalThis.location ??= { origin: 'https://www.youtube.com' };
  const { SeparatedAudio } = await import('../../extension/content/separation.js');
  const sa = Object.create(SeparatedAudio.prototype);
  sa.sep = new PcmTimeline(SR);
  sa.orig = new PcmTimeline(SR);
  sa.orig.write(0, ramp(10000), ramp(10000));
  sa.sep.write(2000, new Float32Array(5000).fill(1), new Float32Array(5000).fill(2));
  const sp = sa.speechAt(3, 4);
  assert.equal(sp.sampleRate, SR);
  assert.equal(sp.left.length, 1000);
  assert.equal(sp.left[0], 3000 - 1);
  assert.equal(sp.right[999], 3999 - 2);
  assert.equal(sa.speechAt(6, 8), null, 'ayrılmış ses yetmiyor');
  sa.orig.prune(0, 3500);
  assert.equal(sa.speechAt(3, 4), null, 'orijinal yetmiyor');
});
