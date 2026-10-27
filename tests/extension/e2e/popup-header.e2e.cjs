// Açılır pencere başlığı: ses seçici anahtarın solunda, taşma yok, ses yazılır, açılışta dublaj kapanır.
//   xvfb-run -a node tests/extension/e2e/popup-header.e2e.cjs      (SHOT_DIR=... ile ekran görüntüsü de alır)
const assert = require('assert/strict');
const { launch } = require('./common.cjs');

(async () => {
  const { ctx, id, opt } = await launch({ videos: {} });
  try {
    await opt.evaluate(() => chrome.storage.local.set({ update: { latest: { version: '9.9.9', bytes: 8262988 }, checkedAt: Date.now() } }));
    const popup = await ctx.newPage();
    await popup.setViewportSize({ width: 320, height: 600 });
    await popup.goto(`chrome-extension://${id}/popup/popup.html`);
    await popup.waitForTimeout(800);

    // Düzen: seçici anahtarın solunda, çakışma ve yatay taşma yok
    const v = await popup.locator('#voice').boundingBox();
    const e = await popup.locator('#enabled').evaluate((el) => el.parentElement.getBoundingClientRect().toJSON());
    assert.ok(v.x < e.x, `seçici anahtarın soluna gelmeli (${v.x} < ${e.x})`);
    assert.ok(v.x + v.width <= e.x, 'seçici anahtarla çakışmamalı');
    assert.equal(await popup.getAttribute('#voice', 'aria-label'), 'Seslendirme');
    assert.ok(await popup.evaluate(() => document.documentElement.scrollWidth) <= 320, 'yatay taşma var');

    if (process.env.SHOT_DIR) {
      for (const scheme of ['light', 'dark']) {
        await popup.emulateMedia({ colorScheme: scheme });
        await popup.screenshot({ path: `${process.env.SHOT_DIR}/popup-${scheme}.png` });
      }
    }

    // Bir ses seçilince voice yazılır
    const values = await popup.$$eval('#voice option:not([disabled])', (os) => os.map((o) => o.value));
    const pick = values.find((x) => !x.startsWith('__more__') && !x.startsWith('system:'));
    if (pick) {
      await popup.selectOption('#voice', pick);
      await popup.waitForTimeout(200);
      const { voice } = await opt.evaluate(() => chrome.storage.local.get('voice'));
      assert.equal(voice, pick);
    } else console.log('seçilebilir ses yok: seçim denetimi atlandı');

    // Tarayıcı açılışı: enabled kapatılır
    await opt.evaluate(() => chrome.storage.local.set({ enabled: true }));
    await ctx.serviceWorkers()[0].evaluate(() => globalThis.resetEnabledOnStartup());
    const { enabled } = await opt.evaluate(() => chrome.storage.local.get('enabled'));
    assert.equal(enabled, false);
    console.log('ok — popup-header');
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
