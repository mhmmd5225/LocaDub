// B1: kalıcı çeviri önbelleği. İkinci açılışta altyazı YouTube'dan istenmez, çeviri hemen hazırdır.
//   xvfb-run -a node tests/extension/e2e/transcript-cache.e2e.cjs
const assert = require('assert/strict');
const { launch } = require('./common.cjs');

const VID = 'cachetest01';
const videos = { [VID]: [
  { t: 500, d: 2500, text: 'Hello and welcome to the show.' },
  { t: 4000, d: 3000, text: 'Today we are talking about cats.' },
] };

(async () => {
  const fetched = [];
  const { ctx, opt } = await launch({ videos, onTimedtext: (v) => fetched.push(v) });
  try {
    let page = await ctx.newPage();
    await page.goto(`https://www.youtube.com/watch?v=${VID}`);
    await page.evaluate(() => document.querySelector('video').play());
    await page.waitForFunction(() => /\[TR\] Hello/.test(document.querySelector('.yt-tr-dub-sub')?.textContent || ''), null, { timeout: 30000 });
    await page.waitForTimeout(6000); // ikinci cümle de çevrilsin
    await page.close(); // pagehide → kaydet
    await opt.waitForTimeout(500);
    const stored = await opt.evaluate((v) => chrome.storage.local.get(null).then((all) => Object.keys(all).filter((k) => k.startsWith('tr:' + v))), VID);
    assert.equal(stored.length, 1, 'çeviri saklanmadı');
    assert.equal(fetched.length, 1);

    page = await ctx.newPage();
    const logs = [];
    page.on('console', (m) => logs.push(m.text()));
    await page.goto(`https://www.youtube.com/watch?v=${VID}`);
    await page.evaluate(() => document.querySelector('video').play());
    await page.waitForFunction(() => /\[TR\] Hello/.test(document.querySelector('.yt-tr-dub-sub')?.textContent || ''), null, { timeout: 30000 });
    assert.equal(fetched.length, 1, 'ikinci açılışta altyazı yeniden istendi');
    assert.ok(logs.some((l) => /önbellekten \(2 çevrili\)/.test(l)), logs.join('\n'));
    console.log('ok — transcript-cache');
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
