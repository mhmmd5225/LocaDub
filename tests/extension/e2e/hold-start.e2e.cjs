// İlk cümleye kadar bekletme (holdStart): dublaj açılınca video, ilk cümle hazır olana kadar duraklatılır ve sonra
// kendiliğinden sürer; ayar kapalıyken video hiç durdurulmaz. Test motoru (çeviri motoru ≈ 0.6 sn'de yüklenir).
//   xvfb-run -a node tests/extension/e2e/hold-start.e2e.cjs
const assert = require('assert/strict');
const { launch } = require('./common.cjs');

const VID = 'holdstart01';
const videos = { [VID]: [
  { t: 300, d: 2500, text: 'Hello and welcome to the show.' },
  { t: 3500, d: 3000, text: 'Today we are talking about cats.' },
] };

async function watch(ctx, { stalePlay = false } = {}) {
  const page = await ctx.newPage();
  await page.addInitScript((stale) => {
    window.__ev = [];
    document.addEventListener('pause', (e) => window.__ev.push(['pause', Math.round(e.target.currentTime * 100) / 100]), true);
    document.addEventListener('play', (e) => window.__ev.push(['play', Math.round(e.target.currentTime * 100) / 100]), true);
    // gecikmeli 'play' olayı: eklenti videoyu bekletme için durdurduktan sonra, başlangıca ait bir play olayı gelir
    // (yük altında görülür). Bekletme bu olayı kullanıcı sanıp bitirmemeli; video sonunda kendiliğinden sürmeli.
    if (stale) {
      let done = false;
      document.addEventListener('pause', (e) => {
        if (done) return;
        done = true;
        const v = e.target;
        setTimeout(() => { if (v.paused) v.dispatchEvent(new Event('play')); }, 0);
      }, true);
    }
  }, stalePlay);
  await page.goto(`https://www.youtube.com/watch?v=${VID}`);
  await page.evaluate(() => document.querySelector('video').play().catch(() => {})); // bekletme play()'i kesebilir
  await page.waitForFunction(() => /\[TR\] Hello/.test(document.querySelector('.yt-tr-dub-sub')?.textContent || ''), null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => ({ ev: window.__ev, paused: document.querySelector('video').paused, t: document.querySelector('video').currentTime }));
  await page.close();
  return r;
}

(async () => {
  const { ctx, opt } = await launch({ videos });
  try {
    const on = await watch(ctx);
    const pause = on.ev.find(([k]) => k === 'pause');
    assert.ok(pause, 'video bekletilmedi: ' + JSON.stringify(on.ev));
    assert.ok(pause[1] < 0.3, 'ilk cümleden önce durdurulmalı: ' + JSON.stringify(on.ev));
    assert.ok(on.ev.filter(([k]) => k === 'play').length >= 2, 'kendiliğinden sürmedi: ' + JSON.stringify(on.ev));
    assert.equal(on.paused, false, 'video oynamıyor');

    // bekletme sırasında gecikmeli gelen 'play' olayı bekletmeyi bitirmemeli; video kendiliğinden sürmeli
    const stale = await watch(ctx, { stalePlay: true });
    assert.ok(stale.ev.filter(([k]) => k === 'play').length >= 2, 'gecikmeli play bekletmeyi bitirdi: ' + JSON.stringify(stale.ev));
    assert.equal(stale.paused, false, 'gecikmeli play sonrası video duraklatılmış kaldı: ' + JSON.stringify(stale.ev));

    await opt.evaluate(() => chrome.storage.local.set({ holdStart: false }));
    await opt.evaluate(() => chrome.storage.local.get(null).then((all) => chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('tr:')))));
    const off = await watch(ctx);
    assert.ok(!off.ev.some(([k]) => k === 'pause'), 'ayar kapalıyken durduruldu: ' + JSON.stringify(off.ev));
    console.log('ok — hold-start');
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
