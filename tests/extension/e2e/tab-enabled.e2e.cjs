// Dublaj durumu sekmeye özel: bir sekmede kapatmak ötekini kapatmaz (content/app.js setEnabled).
//   xvfb-run -a node tests/extension/e2e/tab-enabled.e2e.cjs
const assert = require('assert/strict');
const { launch } = require('./common.cjs');

const videos = { tabtest0001: [{ t: 200, d: 2000, text: 'Hello there.' }], tabtest0002: [{ t: 200, d: 2000, text: 'Second.' }] };
const set = (page, on) => page.evaluate((v) => window.dispatchEvent(new CustomEvent('locadub-set-enabled', { detail: v })), on);
const pill = (page) => page.locator('.ld-pill').isVisible();

(async () => {
  const { ctx } = await launch({ videos, settings: { voice: 'mock-beep' } });
  try {
    const a = await ctx.newPage();
    await a.goto('https://www.youtube.com/watch?v=tabtest0001');
    await a.waitForSelector('.ld-pill', { state: 'visible', timeout: 15000 });
    const b = await ctx.newPage();
    await b.goto('https://www.youtube.com/watch?v=tabtest0002');
    await b.waitForSelector('.ld-pill', { state: 'visible', timeout: 15000 });

    await set(a, false);
    await a.waitForSelector('.ld-pill', { state: 'hidden', timeout: 5000 });
    await b.waitForTimeout(1500);
    assert.equal(await pill(b), true, 'A kapatılınca B de kapandı');

    await set(b, false);
    await set(a, true);
    await a.waitForSelector('.ld-pill', { state: 'visible', timeout: 5000 });
    await b.waitForTimeout(1500);
    assert.equal(await pill(b), false, 'A açılınca B açıldı');
    console.log('ok — tab-enabled');
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
