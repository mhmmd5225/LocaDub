// C2: tanılama raporu. Motor hatası kaydedilir ve rapora girer; sözlük metni girmez.
//   xvfb-run -a node tests/extension/e2e/diagnostics.e2e.cjs
const assert = require('assert/strict');
const { launch } = require('./common.cjs');

(async () => {
  const { ctx, opt } = await launch({ videos: {}, settings: { glossaryMt: 'gizli kural => metin' } });
  try {
    const r = await opt.evaluate(() => chrome.runtime.sendMessage({ type: 'engine.init', engine: 'yok' }));
    assert.equal(r.ok, false);
    await opt.reload();
    await opt.waitForTimeout(1500);
    await opt.click('#copyDiag');
    await opt.waitForFunction(() => document.getElementById('diagNote').textContent);
    const text = await opt.textContent('#diagText');
    assert.match(text, /^LocaDub \d/);
    assert.match(text, /engine\.init: Bilinmeyen motor: yok/);
    assert.match(text, /engineMode: "mock"/);
    assert.match(text, /sözlük: 1 çeviri düzeltmesi/);
    assert.doesNotMatch(text, /gizli kural/);
    console.log(text.split('\n').slice(0, 3).join('\n'));
    console.log('not:', await opt.textContent('#diagNote'));
    console.log('ok — diagnostics');
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
