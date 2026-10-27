// B3: kişisel sözlük. Çeviri düzeltmesi altyazıya uygulanır; kural değişince yeniden çeviri yapılmadan güncellenir.
//   xvfb-run -a node tests/extension/e2e/glossary.e2e.cjs
const assert = require('assert/strict');
const { launch } = require('./common.cjs');

const VID = 'glossary001';
const videos = { [VID]: [{ t: 300, d: 12000, text: 'Hello and welcome to the show about cats.' }] };
const sub = (page) => page.evaluate(() => document.querySelector('.yt-tr-dub-sub')?.textContent || '');

(async () => {
  const { ctx, opt } = await launch({ videos, settings: { glossaryMt: 'hello => Merhaba\ncat* => kedi*' } });
  try {
    const page = await ctx.newPage();
    await page.goto(`https://www.youtube.com/watch?v=${VID}`);
    await page.evaluate(() => document.querySelector('video').play());
    await page.waitForFunction(() => /Merhaba/.test(document.querySelector('.yt-tr-dub-sub')?.textContent || ''), null, { timeout: 30000 });
    assert.equal(await sub(page), '[TR] Merhaba and welcome to the show about kedis.');
    await opt.evaluate(() => chrome.storage.local.set({ glossaryMt: 'hello => Selam' }));
    await page.waitForFunction(() => /Selam/.test(document.querySelector('.yt-tr-dub-sub')?.textContent || ''), null, { timeout: 5000 });
    assert.equal(await sub(page), '[TR] Selam and welcome to the show about cats.');
    console.log('ok — glossary');
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
