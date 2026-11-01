// "Tümünü indir": eksik tüm modeller (çeviri, sesler, konuşmacı, noktalama, ses ayırma) sırayla indirilir; biri başarısız olsa da
// diğerleri sürer ve sonda özet gösterilir. Ağ: HuggingFace istekleri yakalanır, küçük sahte gövdeyle yanıtlanır (gerçek indirme yok).
//   xvfb-run -a node tests/extension/e2e/download-all.e2e.cjs
const assert = require('assert/strict');
const { launch } = require('./common.cjs');

(async () => {
  const { ctx, id, opt } = await launch({ videos: {} });
  try {
    const hits = [];
    await ctx.route(/^https:\/\/([\w-]+\.)*(huggingface\.co|hf\.co)\//, (r) => {
      const u = r.request().url();
      hits.push(u);
      if (/ahenk/i.test(u)) return r.abort('failed'); // bir model başarısız olsa da diğerleri sürmeli
      r.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.alloc(64, 1) });
    });
    // gerçek motor kipi, hiçbir model indirilmemiş
    await opt.evaluate(() => chrome.storage.local.set({ engineMode: 'real', modelsApproved: false, voice: null, mtBackend: null }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`chrome-extension://${id}/options/options.html#indirme`);
    await page.waitForFunction(() => document.querySelectorAll('#modelRows .model').length >= 6);
    // ses ayırma modelleri listede (GPU + işlemci), her biri indir düğmeli
    const rows = await page.$$eval('#modelRows .model .name', (els) => els.map((e) => e.textContent));
    assert.ok(rows.some((t) => /Ses ayırma — Kim Vocal 2/.test(t) && /GPU/.test(t)), 'GPU ayırma modeli listede yok: ' + rows.join(' | '));
    assert.ok(rows.some((t) => /Ses ayırma/.test(t) && /işlemci/.test(t)), 'işlemci ayırma modeli listede yok: ' + rows.join(' | '));
    // "Tümünü indir" görünür; etiketinde toplam boyut, notta model adları
    assert.equal(await page.isVisible('#downloadAll'), true);
    assert.match(await page.textContent('#downloadAll'), /^Tümünü indir \(≈ [\d.,]+ (MB|GB)\)$/);
    assert.match(await page.textContent('#prepareNote'), /^\d+ model indirilmedi$/);
    const tip = await page.getAttribute('#prepareNote', 'title');
    for (const w of ['Konuşmacı tanıma', 'Noktalama', 'Ses ayırma']) assert.ok(tip.includes(w), `ipucunda ${w} yok: ${tip}`);
    // seçili modeller tümü değilse ikinci düğme ("Yalnız seçili olanları indir") de görünür
    assert.match(await page.textContent('#prepareSelected'), /^Yalnız seçili olanları indir/);

    await page.click('#downloadAll');
    await page.waitForSelector('#confirm[open]');
    assert.match(await page.textContent('#confirmText'), /model, yaklaşık .* bir kez indirilecek/);
    await page.click('#confirmYes');
    // sırayla indirir; bitince özet (bazı modeller sahte gövdeyle başarısız olabilir: devam eder)
    await page.waitForFunction(() => /model indirildi|modelin hepsi indirildi/.test(document.getElementById('prepareNote').textContent), null, { timeout: 120000 });
    const summary = await page.textContent('#prepareNote');
    assert.match(summary, /^\d+\/\d+ model indirildi\. Hata: .*Ahenk/, 'başarısız model özette olmalı: ' + summary);
    // başarısız modelin satırında hata görünür, diğer modeller indirildi
    assert.ok((await page.$$eval('#modelRows .model .meta.err', (els) => els.length)) >= 1, 'hata satırı yok');
    // her kategoriden en az bir istek gitti ve sıra: sesler → konuşmacı → noktalama → ses ayırma
    const first = (re) => hits.findIndex((u) => re.test(u));
    const idx = {
      antalia: first(/antalia/i), ahenk: first(/ahenk/i), ema: first(/ema/i), super: first(/supertonic/i),
      spk: first(/speaker-embedding|wespeaker/i), punct: first(/punct/i), sep: first(/Kim_Vocal_2|UVR/i),
    };
    for (const [k, v] of Object.entries(idx)) assert.ok(v >= 0, `${k} için istek yok; özet: ${summary}\n${hits.slice(0, 12).join('\n')}`);
    assert.ok(Math.max(idx.antalia, idx.ahenk, idx.ema, idx.super) < idx.spk, 'sesler konuşmacıdan önce: ' + JSON.stringify(idx));
    assert.ok(idx.spk < idx.punct, 'konuşmacı noktalamadan önce: ' + JSON.stringify(idx));
    assert.ok(idx.punct < idx.sep, 'noktalama ses ayırmadan önce: ' + JSON.stringify(idx));
    // indirme sürerken düğme kilitliydi, bitince yeniden etkin
    assert.equal(await page.isDisabled('#downloadAll').catch(() => false), false);
    assert.deepEqual(errors, []);
    console.log('ok — download-all —', summary.slice(0, 140));
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
