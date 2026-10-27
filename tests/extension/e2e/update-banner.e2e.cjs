// C1: güncelleme bildirimi. Gerçek version.json denetimi (ağ varsa) ve açılır penceredeki şerit.
//   xvfb-run -a node tests/extension/e2e/update-banner.e2e.cjs
const assert = require('assert/strict');
const { launch } = require('./common.cjs');

(async () => {
  const { ctx, id, opt } = await launch({ videos: {} });
  try {
    // 1) Arka plan sitedeki sürümü okur (ağ yoksa atlanır).
    const res = await opt.evaluate(() => chrome.runtime.sendMessage({ type: 'update.check' }));
    if (res.result) {
      const { update } = await opt.evaluate(() => chrome.storage.local.get('update'));
      assert.match(update.latest.version, /^\d+\.\d+/);
      console.log('site sürümü:', update.latest.version);
    } else console.log('ağ yok: gerçek denetim atlandı');

    // 2) Daha yeni sürüm → şerit görünür
    await opt.evaluate(() => chrome.storage.local.set({ update: { latest: { version: '9.9.9', bytes: 8262988 }, checkedAt: Date.now() } }));
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${id}/popup/popup.html`);
    await popup.waitForTimeout(800);
    assert.equal(await popup.isVisible('#update'), true);
    assert.equal(await popup.textContent('#updateTitle'), 'Yeni sürüm: LocaDub 9.9.9 (7.9 MB)');
    await popup.screenshot({ path: process.env.SHOT || '/dev/null' }).catch(() => {});

    // 3) "Sonra" → bu sürüm için gizli kalır
    await popup.click('#updateLater');
    await popup.reload(); await popup.waitForTimeout(800);
    assert.equal(await popup.isVisible('#update'), false);

    // 4) Daha da yeni sürüm yeniden gösterilir; denetim kapatılınca gizlenir
    await opt.evaluate(() => chrome.storage.local.set({ update: { latest: { version: '10.0.0' }, checkedAt: Date.now() } }));
    await popup.reload(); await popup.waitForTimeout(800);
    assert.equal(await popup.isVisible('#update'), true);
    await opt.evaluate(() => chrome.storage.local.set({ checkUpdates: false }));
    await popup.reload(); await popup.waitForTimeout(800);
    assert.equal(await popup.isVisible('#update'), false);
    console.log('ok — update-banner');
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
