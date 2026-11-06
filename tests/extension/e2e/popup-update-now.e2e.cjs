// Açılır penceredeki "Şimdi güncelle": otomatik güncelleme klasörü seçiliyse görünür ve arka plandaki uygulamayı başlatır.
// Klasör yerine OPFS dizini kullanılır (seçim penceresi otomatik açılamaz). Sitedeki gerçek paket indirilir; sahte sürüm
// (9.9.9) pakettekiyle uyuşmadığı için güncelleme yazmadan durmalı ve nedeni göstermeli (ağ yoksa indirme hatası).
//   xvfb-run -a node tests/extension/e2e/popup-update-now.e2e.cjs
const assert = require('assert/strict');
const { launch } = require('./common.cjs');

(async () => {
  const { ctx, id, opt } = await launch({ videos: {} });
  try {
    await opt.evaluate(() => chrome.storage.local.set({ update: { latest: { version: '9.9.9', bytes: 1, downloadUrl: 'https://localdub.mhmmd.app/LocaDub.zip' }, checkedAt: Date.now() } }));
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${id}/popup/popup.html`);
    await popup.waitForTimeout(800);
    assert.equal(await popup.isVisible('#update'), true);
    assert.equal(await popup.isVisible('#updateNow'), false, 'klasör seçilmeden düğme görünmemeli');

    // klasör: OPFS dizini + LocaDub manifest'i, IndexedDB'ye common/self-update.js ile aynı anahtarla
    await opt.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('ext', { create: true });
      const w = await (await dir.getFileHandle('manifest.json', { create: true })).createWritable();
      await w.write(JSON.stringify({ name: 'LocaDub — test', version: '0.0.1' })); await w.close();
      await new Promise((res, rej) => {
        const r = indexedDB.open('locadub-update', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put(dir, 'extension-dir'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); };
        r.onerror = () => rej(r.error);
      });
    });
    await popup.reload(); await popup.waitForTimeout(800);
    assert.equal(await popup.isVisible('#updateNow'), true, 'klasör seçiliyken "Şimdi güncelle" görünmeli');
    assert.match(await popup.textContent('#updateHint'), /eklenti klasörüne yazılır/);

    await popup.click('#updateNow');
    await popup.waitForFunction(() => /Güncellenemedi/.test(document.getElementById('updateHint').textContent), null, { timeout: 90000 });
    const hint = await popup.textContent('#updateHint');
    assert.match(hint, /Paket sürümü beklenenden farklı|İndirme başarısız|fetch/i, hint);
    assert.equal(await popup.isEnabled('#updateNow'), true);
    // hiçbir dosya yazılmadı: yalnız test manifest'i
    const names = await opt.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('ext');
      const out = []; for await (const k of dir.keys()) out.push(k); return out;
    });
    assert.deepEqual(names, ['manifest.json']);
    console.log('ok — popup-update-now:', hint);
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
