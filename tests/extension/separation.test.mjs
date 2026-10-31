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
} from '../../extension/content/sep-core.js';
import { WebmDemuxer, Mp4Demuxer, createDemuxer, opusDuration } from '../../extension/content/sep-demux.js';

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
