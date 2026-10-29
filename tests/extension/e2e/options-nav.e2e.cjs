// Ayarlar sayfası: 4 menü, kaydırmasız yerleşim, derin bağlantılar, klavye, konsol hatası, test motoru satırı.
//   xvfb-run -a node tests/extension/e2e/options-nav.e2e.cjs
// Ekran görüntüsü için: SHOT_DIR=/dizin ile çalıştırın (4 menü × açık/koyu × 2 boyut).
const assert = require('assert/strict');
const fs = require('fs');
const { launch } = require('./common.cjs');

const SIZES = [[1280, 720], [1366, 768]];
const MENUS = ['indirme', 'seslendirme', 'ai-model', 'diger'];
const HASHES = {
  indirme: 'indirme', seslendirme: 'seslendirme', 'ai-model': 'ai-model', diger: 'diger',
  modeller: 'indirme', depolama: 'indirme', ses: 'seslendirme', genel: 'diger', sozluk: 'diger', durum: 'diger',
};

const active = (page) => page.evaluate(() => {
  const t = document.querySelector('[role="tab"][aria-selected="true"]');
  const visible = [...document.querySelectorAll('[role="tabpanel"]')].filter((p) => !p.hidden).map((p) => p.id);
  return { tab: t?.dataset.tab, visible, tabbable: [...document.querySelectorAll('[role="tab"]')].filter((x) => x.tabIndex === 0).map((x) => x.dataset.tab) };
});

const overflow = (page) => page.evaluate(() => {
  const d = document.documentElement, m = document.querySelector('main');
  return {
    v: d.scrollHeight - window.innerHeight, h: d.scrollWidth - window.innerWidth,
    mainV: m.scrollHeight - m.clientHeight, mainH: m.scrollWidth - m.clientWidth,
  };
});

(async () => {
  const { ctx, id, opt } = await launch({ videos: {}, settings: { glossaryMt: 'a => b\nc => d\ne => f' } });
  const problems = [];
  try {
    const url = (q = '', h = '') => `chrome-extension://${id}/options/options.html${q}${h}`;
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });

    // (1) kaydırma çubuğu yok: hem gerçek hem test motoru, iki boyut, açık/koyu
    for (const mode of ['real', 'mock']) {
      await opt.evaluate((m) => chrome.storage.local.set({ engineMode: m, mtBackend: null, voice: null }), mode);
      for (const [w, h] of SIZES) {
        for (const scheme of ['light', 'dark']) {
          await page.setViewportSize({ width: w, height: h });
          await page.emulateMedia({ colorScheme: scheme });
          for (const menu of MENUS) {
            await page.goto(url('', '#' + menu));
            await page.waitForFunction(() => document.querySelectorAll('#modelRows .model').length > 0);
            await page.waitForTimeout(300);
            // şerit görünürken de sığmalı
            await page.evaluate(() => { document.getElementById('statusBar').hidden = false; document.getElementById('status').textContent = 'Çeviri: hata — deneme'; });
            const o = await overflow(page);
            const tag = `${mode} ${w}x${h} ${scheme} #${menu}`;
            assert.ok(o.v <= 0 && o.h <= 0, `sayfa kayıyor (${tag}): ${JSON.stringify(o)}`);
            assert.ok(o.mainV <= 0 && o.mainH <= 0, `panel taşıyor (${tag}): ${JSON.stringify(o)}`);
            await page.evaluate(() => { document.getElementById('statusBar').hidden = true; });
            if (process.env.SHOT_DIR && mode === 'real') {
              fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
              await page.screenshot({ path: `${process.env.SHOT_DIR}/${menu}-${scheme}-${w}x${h}.png` });
            }
          }
        }
      }
    }
    await page.emulateMedia({ colorScheme: null });
    await page.setViewportSize({ width: 1280, height: 720 });

    // (2) eski ve yeni hash'ler doğru menüyü açar; açılışta ve hashchange'de
    for (const [hash, menu] of Object.entries(HASHES)) {
      await page.goto(url('', '#' + hash));
      assert.deepEqual((await active(page)).visible, [menu], `açılış #${hash}`);
      const other = MENUS.find((m) => m !== menu);
      await page.evaluate((h) => { location.hash = h; }, other);
      assert.equal((await active(page)).tab, other);
      await page.evaluate((h) => { location.hash = h; }, hash);
      const a = await active(page);
      assert.deepEqual(a.visible, [menu], `hashchange #${hash}`);
      assert.deepEqual(a.tabbable, [menu]);
    }
    // menü tıklayınca hash güncellenir, geçmiş şişmez
    await page.goto(url('', '#indirme'));
    const hist = await page.evaluate(() => history.length);
    await page.click('#tab-ai-model');
    assert.equal(await page.evaluate(() => location.hash), '#ai-model');
    assert.equal(await page.evaluate(() => history.length), hist);
    assert.equal(await page.getAttribute('#tab-ai-model', 'aria-controls'), 'ai-model');
    assert.equal(await page.getAttribute('#ai-model', 'aria-labelledby'), 'tab-ai-model');

    // (3) klavye: ok tuşları, Home/End
    await page.goto(url('', '#indirme'));
    await page.focus('#tab-indirme');
    await page.keyboard.press('ArrowRight');
    assert.equal((await active(page)).tab, 'seslendirme');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-seslendirme');
    await page.keyboard.press('End');
    assert.equal((await active(page)).tab, 'diger');
    await page.keyboard.press('ArrowRight');
    assert.equal((await active(page)).tab, 'indirme');
    await page.keyboard.press('ArrowLeft');
    assert.equal((await active(page)).tab, 'diger');
    await page.keyboard.press('Home');
    assert.equal((await active(page)).tab, 'indirme');

    // (5) test motoru satırı: motor test modundayken her zaman; gerçek modda yalnızca #gelistirici / ?dev=1
    await opt.evaluate(() => chrome.storage.local.set({ engineMode: 'mock' }));
    await page.goto(url('', '#diger'));
    assert.ok(await page.isVisible('#mockRow'), 'test modunda satır görünür');
    await page.click('#mock');
    await page.waitForFunction(() => chrome.storage.local.get('engineMode').then((s) => s.engineMode === 'real'));
    await opt.evaluate(() => chrome.storage.local.set({ engineMode: 'real' }));
    await page.goto(url('', '#diger'));
    assert.ok(!(await page.isVisible('#mockRow')), 'gerçek modda satır gizli');
    await page.goto(url('', '#gelistirici'));
    assert.deepEqual((await active(page)).visible, ['diger']);
    assert.ok(await page.isVisible('#mockRow'), '#gelistirici ile görünür');
    await page.goto(url('?dev=1', '#diger'));
    assert.ok(await page.isVisible('#mockRow'), '?dev=1 ile görünür');
    const o = await overflow(page);
    assert.ok(o.v <= 0 && o.mainV <= 0, 'test motoru satırıyla da sığar: ' + JSON.stringify(o));

    // Gerçek modda Seslendirme/AI Model seçimleri ayarı yazar
    await page.goto(url('', '#seslendirme'));
    await page.waitForSelector('#voiceChoice input[value="ahenk-cep"]');
    await page.check('#voiceChoice input[value="ahenk-cep"]');
    await page.waitForFunction(() => chrome.storage.local.get('voice').then((s) => s.voice === 'ahenk-cep'));
    // Supertonic: tek radyo + hazır ses seçici; İndirme'de tek satır; seçiliyken de sığar
    await page.check('#voiceChoice input[value="supertonic-3"]');
    await page.waitForFunction(() => chrome.storage.local.get('voice').then((s) => s.voice === 'supertonic-3:F1'));
    await page.waitForSelector('#presetRow:not([hidden])');
    await page.selectOption('#preset', 'supertonic-3:M2');
    await page.waitForFunction(() => chrome.storage.local.get('voice').then((s) => s.voice === 'supertonic-3:M2'));
    assert.ok(await page.isChecked('#voiceChoice input[value="supertonic-3"]'));
    const os = await overflow(page);
    assert.ok(os.v <= 0 && os.mainV <= 0, 'Supertonic seçiliyken sığar: ' + JSON.stringify(os));
    await page.goto(url('', '#indirme'));
    await page.waitForFunction(() => document.querySelectorAll('#modelRows .model').length > 0);
    const names = await page.$$eval('#modelRows .model .name', (els) => els.map((e) => e.textContent));
    assert.equal(names.filter((n) => n.startsWith('Supertonic')).length, 1, 'paket tek satır: ' + names.join(' | '));
    await page.goto(url('', '#seslendirme'));
    await page.waitForSelector('#voiceChoice input[value="ahenk-cep"]');
    await page.check('#voiceChoice input[value="ahenk-cep"]');
    await page.waitForFunction(() => chrome.storage.local.get('voice').then((s) => s.voice === 'ahenk-cep'));
    await page.goto(url('', '#ai-model'));
    await page.waitForSelector('#mtChoice input[value="opus-mt"]');
    await page.check('#mtChoice input[value="opus-mt"]');
    await page.waitForFunction(() => chrome.storage.local.get('mtBackend').then((s) => s.mtBackend === 'opus-mt'));
    await page.check('#mtChoice input[value=""]');
    await page.waitForFunction(() => chrome.storage.local.get('mtBackend').then((s) => s.mtBackend == null));

    // Konuşmacılara 4 ses açıkken de (bölüm açık, modeller indirilmemiş) Seslendirme sığar
    for (const voice of ['supertonic-3:F2', 'antalia-mini']) {
      await opt.evaluate((v) => chrome.storage.local.set({ engineMode: 'real', voice: v, speakerVoices: true, speakerCount: 4 }), voice);
      for (const [w, h] of SIZES) {
        await page.setViewportSize({ width: w, height: h });
        await page.goto(url('', '#seslendirme'));
        await page.waitForSelector('#voice4Row:not([hidden])');
        await page.waitForTimeout(300);
        const ov = await overflow(page);
        assert.ok(ov.v <= 0 && ov.mainV <= 0, `4 konuşmacı sesiyle sığar (${voice} ${w}x${h}): ` + JSON.stringify(ov));
      }
    }
    await opt.evaluate(() => chrome.storage.local.set({ speakerVoices: false, speakerCount: 2 }));

    // Dinle: test motorunda örnek sesi çalar (hata iletisi yok)
    await opt.evaluate(() => chrome.storage.local.set({ engineMode: 'mock', modelsApproved: true, voice: null }));
    await page.goto(url('', '#seslendirme'));
    await page.waitForSelector('#preview:not([disabled])');
    await page.click('#preview');
    await page.waitForFunction(() => !/hazırlanıyor/i.test(document.getElementById('styleNote').textContent), null, { timeout: 15000 });
    assert.ok(!/çalınamadı/.test(await page.textContent('#styleNote')), await page.textContent('#styleNote'));

    // (4) konsolda hata yok
    assert.deepEqual(problems, [], 'konsol/pageerror: ' + problems.join(' | '));
    console.log('ok — options-nav');
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
