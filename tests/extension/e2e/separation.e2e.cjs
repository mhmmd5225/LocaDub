// Gerçek dublaj (ses ayırma), test motoru (engines/_mock/sep.js: girdi × 0.5). Sahte YouTube MediaSource ile oynatır
// (ayrı görüntü/ses SourceBuffer'ları); MAIN dünyası kancası ses eklemelerini yakalar.
//   1. başta video ön tampon (prebufferSec) dolana dek bekletilir, sonra kendiliğinden sürer
//   2. oynarken orijinal ses grafikte susturulur, ayrılmış ses çalar ve videoyla eşittir (orijinal ile ayrılmış çıkışın
//      çapraz ilintisi: duyulan kayma ≤ 40 ms)
//   3. ayırma yavaşlayınca (< 2 sn kaldı) video bekletilir ('waiting'), hızlanınca ≥ 8 sn hazır olunca sürer
//   4. işlenmemiş bir yere atlayınca bekletilir, sonra orada da eşit çalar
//   5. akış kipi + hıza uyan bekletme (150 sn'lik video): rtf 0.7 → başladıktan sonra hiç durmaz; rtf 1.3 → bekletmeler
//      seyrek (≥ 20 sn arayla), bekletirken etaSec / needSec bildirilir
//   xvfb-run -a node tests/extension/e2e/separation.e2e.cjs   (SEP_E2E_QUICK=1: 5. adım atlanır)
const assert = require('assert/strict');
const { launch, mseFiles } = require('./common.cjs');

const VID = 'separation1';
const videos = { [VID]: [
  { t: 1500, d: 2000, text: 'Hello and welcome.' },
  { t: 20000, d: 2000, text: 'This is the middle.' },
  { t: 46000, d: 2000, text: 'Almost the end.' },
] };

const state = (page) => page.evaluate(() => {
  const v = document.querySelector('video');
  const s = JSON.parse(document.documentElement.dataset.locadubSep || 'null');
  return { s, t: v.currentTime, paused: v.paused };
});

async function until(page, pred, what, timeout = 30000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await state(page);
    if (last.s && pred(last)) return last;
    await page.waitForTimeout(100);
  }
  throw new Error(`zaman aşımı: ${what}\nson durum: ${JSON.stringify(last)}`);
}

const setRtf = (page, r) => page.evaluate((x) => { document.documentElement.dataset.locadubMockSepRtf = String(x); }, r);

async function probeOk(page, after, what) {
  const st = await until(page, (x) => x.s.probe && x.s.probe.t > after && x.s.status === 'playing', 'senkron ölçümü ' + what, 15000);
  const p = st.s.probe;
  assert.ok(p.score > 0.5, `${what}: ilinti zayıf ${JSON.stringify(p)}`);
  assert.ok(Math.abs(p.lagMs) <= 40, `${what}: duyulan kayma ${p.lagMs} ms`);
  return p;
}

(async () => {
  const { ctx } = await launch({ videos, mse: true, settings: { prebufferSec: 5, holdStart: false } });
  try {
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', (m) => { if (/yt-tr-dub/.test(m.text())) logs.push(m.text()); });
    await page.addInitScript(() => {
      window.__ev = [];
      const snap = () => JSON.parse(document.documentElement?.dataset.locadubSep || 'null');
      for (const k of ['pause', 'play']) {
        document.addEventListener(k, (e) => window.__ev.push({ k, t: Math.round(e.target.currentTime * 100) / 100, s: snap() }), true);
      }
      const set = () => document.documentElement && (document.documentElement.dataset.locadubMockSepRtf = '0.3');
      if (!set()) document.addEventListener('readystatechange', set, { once: true });
    });
    await page.goto(`https://www.youtube.com/watch?v=${VID}`);
    await page.evaluate(() => { document.querySelector('video').play().catch(() => {}); }); // bekletme play()'i kesebilir

    // 1. ön tampon
    const p1 = await until(page, (x) => x.s.status === 'playing' && !x.paused && x.t > 0.5, 'ilk oynatma');
    let ev = await page.evaluate(() => window.__ev);
    const firstPause = ev.find((e) => e.k === 'pause');
    assert.ok(firstPause && firstPause.t < 0.5, 'başta bekletilmedi: ' + JSON.stringify(ev));
    const resume = ev.find((e) => e.k === 'play' && e.t >= firstPause.t && ev.indexOf(e) > ev.indexOf(firstPause));
    assert.ok(resume, 'kendiliğinden sürmedi: ' + JSON.stringify(ev));
    assert.ok(resume.s && resume.s.aheadSec >= 5, 'ön tampon dolmadan sürdü: ' + JSON.stringify(resume));
    assert.equal(p1.s.backend, 'mock');

    // 2. orijinal susturuldu, ayrılmış ses çalıyor ve eşit
    const p2 = await probeOk(page, 1, 'ilk bölüm');
    const s2 = (await state(page)).s;
    assert.ok(s2.origGain !== null && s2.origGain < 0.02, 'orijinal ses susturulmadı: ' + JSON.stringify(s2));
    assert.ok(s2.scheduled > 0, 'ayrılmış ses kurulmamış');
    assert.ok(s2.cachedRanges.length >= 1 && s2.cachedRanges[0][0] <= 1, JSON.stringify(s2.cachedRanges));
    console.log('senkron (ilk):', JSON.stringify(p2), 'kayma', s2.drift, 'ms');

    // 3. yavaşlat → bekletme ('waiting'), hızlandır → ≥ 8 sn hazır olunca sür
    await setRtf(page, 50);
    const w = await until(page, (x) => x.s.status === 'waiting' && x.paused, 'ayırma geride: bekletme', 45000);
    assert.ok(w.s.aheadSec <= 2, 'erken bekletildi: ' + JSON.stringify(w.s));
    await page.waitForTimeout(1000);
    assert.equal((await state(page)).paused, true, 'bekletme sürmeli');
    const nEv = (await page.evaluate(() => window.__ev)).length;
    await setRtf(page, 0.05);
    const r = await until(page, (x) => x.s.status === 'playing' && !x.paused, 'yeniden sürme', 20000);
    ev = (await page.evaluate(() => window.__ev)).slice(nEv);
    const play2 = ev.find((e) => e.k === 'play');
    assert.ok(play2 && play2.s.aheadSec >= 8, 'sürme 8 sn hazır olmadan: ' + JSON.stringify(ev));
    console.log('bekletme', w.t.toFixed(1), 'sn → sürdü', r.t.toFixed(1), 'sn');

    // 4. işlenmemiş yere atlama
    await page.evaluate(() => { document.querySelector('video').currentTime = 45; });
    const sk = await until(page, (x) => x.s.status === 'playing' && !x.paused && x.t > 45.3, 'atlama sonrası oynatma', 20000);
    assert.ok(sk.s.cachedRanges.some(([a, b]) => a <= 45.1 && b > 50), JSON.stringify(sk.s.cachedRanges));
    const p4 = await probeOk(page, 45.3, 'atlama sonrası');
    const s4 = (await state(page)).s;
    assert.ok(s4.origGain < 0.02, 'atlama sonrası orijinal açık: ' + JSON.stringify(s4));
    assert.ok(s4.resyncs <= 3, 'çok sık yeniden eşitleme: ' + s4.resyncs);
    assert.ok(logs.some((l) => /ayırma: playing/.test(l)), 'durum günlüğü yok:\n' + logs.join('\n'));
    if (process.env.VERBOSE) console.log(logs.join('\n'));
    assert.equal(s4.streaming, true, 'akış kipi değil');
    for (const k of ['etaSec', 'needSec', 'holds', 'holdMs', 'batch', 'chunkSec', 'streaming']) assert.ok(k in s4, 'durum alanı yok: ' + k);
    console.log('ok — separation', JSON.stringify(p4), 'yeniden eşitleme', s4.resyncs, 'rtf', s4.rtf);
  } finally {
    await ctx.close();
  }
  if (!process.env.SEP_E2E_QUICK) {
    await paced(0.7, 20, 35000);
    await paced(1.3, 5, 75000);
  }
})().catch((e) => { console.error(e); process.exit(1); });

// Sabit hızlı ayırmayla uzun oynatma: bekletmeleri (video 'pause' olayları) duvar saatiyle kaydeder.
async function paced(rtf, prebufferSec, playMs) {
  const vid = 'sepLongVid1';
  const { ctx } = await launch({ videos: { [vid]: [{ t: 1500, d: 2000, text: 'Hello.' }, { t: 140000, d: 2000, text: 'Bye.' }] },
    mse: mseFiles(150), settings: { prebufferSec, holdStart: false } });
  try {
    const page = await ctx.newPage();
    await page.addInitScript((r) => {
      window.__ev = [];
      const snap = () => JSON.parse(document.documentElement?.dataset.locadubSep || 'null');
      for (const k of ['pause', 'play']) {
        document.addEventListener(k, (e) => window.__ev.push({ k, w: Date.now(), t: Math.round(e.target.currentTime * 10) / 10, s: snap() }), true);
      }
      const set = () => document.documentElement && (document.documentElement.dataset.locadubMockSepRtf = String(r));
      if (!set()) document.addEventListener('readystatechange', set, { once: true });
    }, rtf);
    await page.goto(`https://www.youtube.com/watch?v=${vid}`);
    await page.evaluate(() => { document.querySelector('video').play().catch(() => {}); });
    const etas = [];
    const first = await until(page, (x) => {
      if (x.s.status === 'waiting' && x.s.etaSec != null) etas.push({ eta: x.s.etaSec, need: x.s.needSec, ahead: x.s.aheadSec });
      return x.s.status === 'playing' && !x.paused && x.t > 0.3;
    }, `ilk oynatma (rtf ${rtf})`, 90000);
    const t0 = Date.now();
    while (Date.now() - t0 < playMs) {
      const x = await state(page);
      if (x.s?.status === 'waiting' && x.s.etaSec != null) etas.push({ eta: x.s.etaSec, need: x.s.needSec, ahead: x.s.aheadSec });
      await page.waitForTimeout(500);
    }
    const ev = await page.evaluate(() => window.__ev);
    const fin = (await state(page)).s;
    const firstPlay = ev.findIndex((e) => e.k === 'play' && e.w >= t0 - 3000);
    const stalls = ev.filter((e, i) => e.k === 'pause' && e.s && e.s.status !== 'off' && e.t > first.t && i > firstPlay);
    console.log(`rtf ${rtf}: ilk oynatma ${first.t.toFixed(1)} sn (hazır ${first.s.aheadSec}), ${playMs / 1000} sn içinde bekletme ${stalls.length}`,
      `holds ${fin.holds}, holdMs ${fin.holdMs}, ölçülen rtf ${fin.rtf}, parça ${fin.chunkSec} sn, eta örnekleri ${JSON.stringify(etas.slice(0, 3))}`);
    assert.equal(fin.streaming, true);
    if (rtf < 1) {
      assert.equal(stalls.length, 0, 'rtf < 1 iken başladıktan sonra durdu: ' + JSON.stringify(stalls.map((e) => [e.t, e.s.aheadSec])));
      assert.equal(fin.holds, 0);
    } else {
      for (let i = 1; i < stalls.length; i++) {
        assert.ok(stalls[i].w - stalls[i - 1].w >= 20000, 'bekletmeler sık: ' + JSON.stringify(stalls.map((e) => [e.w - t0, e.t])));
      }
      assert.ok(etas.length > 0, 'bekletirken etaSec bildirilmedi');
      assert.ok(etas.every((e) => e.need >= 20 && e.eta >= 0) && etas.some((e) => e.eta > 5), 'eta/need: ' + JSON.stringify(etas));
    }
  } finally {
    await ctx.close();
  }
}
