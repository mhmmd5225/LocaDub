// C2: tanılama raporu. Motor hatası kaydedilir ve rapora girer; sözlük metni girmez.
//   xvfb-run -a node tests/extension/e2e/diagnostics.e2e.cjs
const assert = require('assert/strict');
const { launch } = require('./common.cjs');

(async () => {
  const { ctx, opt } = await launch({ videos: {}, settings: { glossaryMt: 'gizli kural => metin' } });
  try {
    const r = await opt.evaluate(() => chrome.runtime.sendMessage({ type: 'engine.init', engine: 'yok' }));
    assert.equal(r.ok, false);
    // hata günlüğü (common/errlog.js): sayfa bağlamından gönderilen hata arka plana düşer, tekrar tek satırda sayılır
    await opt.evaluate(async () => {
      const { logError } = await import(chrome.runtime.getURL('common/errlog.js'));
      logError('ses yakalama', new Error('sahte köprü hatası'));
      logError('ses yakalama', new Error('sahte köprü hatası')); // 10 sn içinde: bastırılır
      logError('altyazı indirme', 'sahte ağ hatası');
    });
    await opt.waitForFunction(() => chrome.runtime.sendMessage({ type: 'diag.errors' }).then((r) => r.result.some((e) => e.source === 'altyazı indirme')));
    await opt.reload();
    await opt.waitForTimeout(1500);
    await opt.click('#tab-diger');
    await opt.click('#copyDiag');
    await opt.waitForFunction(() => document.getElementById('diagNote').textContent);
    const text = await opt.textContent('#diagText');
    assert.match(text, /^LocaDub \d/);
    assert.match(text, /engine\.init: Bilinmeyen motor: yok/);
    assert.match(text, /ses yakalama: sahte köprü hatası\n/, 'bastırılan tekrar sayılmamalı: ' + text.split('[Son hatalar')[1]);
    assert.match(text, /altyazı indirme: sahte ağ hatası/);
    assert.match(text, /engineMode: "mock"/);
    assert.match(text, /sözlük: 1 çeviri düzeltmesi/);
    assert.doesNotMatch(text, /gizli kural/);
    // açık YouTube sekmesi yok → ses ayırma bölümü yine de var
    assert.match(text, /\[Motorlar\][^]*\[Ses ayırma\]\nyok \(açık YouTube sekmesi yok\)\n\n\[Bellek\]\nyok \(açık YouTube sekmesi yok\)\n\n\[İndirilen modeller\]/);
    console.log(text.split('\n').slice(0, 3).join('\n'));
    console.log('not:', await opt.textContent('#diagNote'));
    console.log('ok — diagnostics');
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
