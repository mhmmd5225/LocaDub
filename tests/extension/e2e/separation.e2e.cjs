// Gerçek dublaj (ses ayırma), test motoru (engines/_mock/sep.js: girdi × 0.5). Sahte YouTube MediaSource ile oynatır
// (ayrı görüntü/ses SourceBuffer'ları); MAIN dünyası kancası ses eklemelerini yakalar.
//   1. başta video ön tampon (prebufferSec) dolana dek bekletilir, sonra kendiliğinden sürer
//   2. oynarken orijinal ses grafikte susturulur, ayrılmış ses çalar ve videoyla eşittir (orijinal ile ayrılmış çıkışın
//      çapraz ilintisi: duyulan kayma ≤ 40 ms)
//   3. ayırma yavaşlayınca (< 2 sn kaldı) video bekletilir ('waiting'), hızlanınca ≥ 8 sn hazır olunca sürer
//   4. işlenmemiş bir yere atlayınca bekletilir, sonra orada da eşit çalar
//   xvfb-run -a node tests/extension/e2e/separation.e2e.cjs
const assert = require('assert/strict');
const { launch } = require('./common.cjs');

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
    console.log('ok — separation', JSON.stringify(p4), 'yeniden eşitleme', s4.resyncs, 'rtf', s4.rtf);
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
