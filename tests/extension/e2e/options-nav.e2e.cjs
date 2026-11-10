// Ayarlar sayfası: tek sayfa, yedi bölüm, sol gezinme (tıklama, klavye, kaydırma izleyici), eski adresler,
// yatay taşma yok, konsol hatası yok, test motoru satırı ve bölümlerdeki işlevsel denetimler.
//   xvfb-run -a node tests/extension/e2e/options-nav.e2e.cjs
// Ekran görüntüsü için: SHOT_DIR=/dizin ile çalıştırın (3 genişlik × açık/koyu, tam sayfa).
const assert = require('assert/strict');
const fs = require('fs');
const { launch } = require('./common.cjs');

const WIDTHS = [1280, 768, 390];
const SECTIONS = ['genel', 'sesler', 'modeller', 'ayirma', 'sozluk', 'guncelleme', 'tanilama'];
// eski menü adları → yeni bölüm
const OLD = { indirme: 'modeller', seslendirme: 'sesler', 'ai-model': 'modeller', diger: 'genel', gelistirici: 'tanilama' };

const current = (page) => page.evaluate(() => [...document.querySelectorAll('#nav a[aria-current="true"]')].map((a) => a.dataset.sec));
// bölüm başlığı görünür alanın üstüne gelmiş mi (sayfa sonundaysa görünür olması yeter)
const waitInView = (page, sec) => page.waitForFunction((s) => {
  const top = document.getElementById(s).getBoundingClientRect().top;
  const d = document.documentElement;
  const atEnd = innerHeight + d.scrollTop >= d.scrollHeight - 2;
  return (top > -4 && top < 140) || (atEnd && top >= 0 && top < innerHeight);
}, sec, { timeout: 5000 });
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

(async () => {
  const { ctx, id, opt } = await launch({ videos: {}, settings: { glossaryMt: 'a => b\nc => d\ne => f' } });
  const problems = [];
  try {
    const url = (q = '', h = '') => `chrome-extension://${id}/options/options.html${q}${h}`;
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });

    // (1) açılışta hata yok, (4) hiçbir genişlikte yatay taşma yok: gerçek ve test motoru, açık ve koyu
    for (const mode of ['real', 'mock']) {
      await opt.evaluate((m) => chrome.storage.local.set({ engineMode: m, mtBackend: null, voice: null }), mode);
      for (const w of WIDTHS) {
        for (const scheme of ['light', 'dark']) {
          await page.setViewportSize({ width: w, height: 800 });
          await page.emulateMedia({ colorScheme: scheme });
          await page.goto(url());
          await page.waitForFunction(() => document.querySelectorAll('#modelRows .model').length > 0);
          await page.waitForTimeout(300);
          const tag = `${mode} ${w} ${scheme}`;
          assert.ok(await overflowX(page) <= 0, `yatay taşma (${tag}): ${await overflowX(page)}`);
          // hata şeridi görünürken de taşmaz
          await page.evaluate(() => { document.getElementById('statusBar').hidden = false; document.getElementById('status').textContent = 'Çeviri: hata — çok uzun bir deneme iletisi '.repeat(4); });
          assert.ok(await overflowX(page) <= 0, `şeritle yatay taşma (${tag})`);
          await page.evaluate(() => { document.getElementById('statusBar').hidden = true; });
          assert.equal(await page.evaluate(() => document.querySelectorAll('h1').length), 1, 'tek h1');
          assert.equal(await page.evaluate(() => document.querySelectorAll('main section.sec > h2').length), 7, 'yedi bölüm başlığı');
          assert.ok(await page.isVisible('#nav-tanilama') || w <= 860, 'gezinme görünür');
          if (process.env.SHOT_DIR && mode === 'real') {
            fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
            await page.screenshot({ path: `${process.env.SHOT_DIR}/options-${scheme}-${w}.png`, fullPage: true });
          }
        }
      }
    }
    await page.emulateMedia({ colorScheme: null });

    // (2) gezinme: tıklama hash'i günceller (geçmiş şişmez), etkin öğe işaretlenir, bölüm görünür alana gelir
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: 720 });
      await page.goto(url());
      await page.waitForFunction(() => document.querySelectorAll('#modelRows .model').length > 0);
      assert.deepEqual(await current(page), ['genel'], 'açılışta Genel etkin');
      const hist = await page.evaluate(() => history.length);
      for (const s of [...SECTIONS.slice(1), 'genel']) {
        await page.click(`#nav-${s}`);
        assert.equal(await page.evaluate(() => location.hash), '#' + s, `${w}: hash #${s}`);
        assert.deepEqual(await current(page), [s], `${w}: etkin öğe ${s}`);
        await waitInView(page, s);
        assert.ok(await overflowX(page) <= 0, `${w}: #${s} sonrası yatay taşma`);
      }
      assert.equal(await page.evaluate(() => history.length), hist, 'geçmiş şişmez');
    }
    await page.setViewportSize({ width: 1280, height: 720 });

    // klavye: ok tuşları ve Home/End odağı taşır, Enter bölümü açar ve odağı bölüm başlığına verir
    await page.goto(url());
    await page.focus('#nav-genel');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'nav-sesler');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => location.hash), '#sesler');
    assert.deepEqual(await current(page), ['sesler']);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'h-sesler', 'odak bölüm başlığında');
    await waitInView(page, 'sesler');
    await page.focus('#nav-sesler');
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'nav-tanilama');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'nav-genel', 'sona gelince başa döner');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'nav-tanilama');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => location.hash), '#tanilama');
    assert.deepEqual(await current(page), ['tanilama']);
    await page.keyboard.press('Home');
    await page.focus('#nav-tanilama');
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'nav-genel');

    // kaydırma izleyici: elle kaydırınca etkin öğe değişir
    await page.goto(url());
    await page.waitForFunction(() => document.querySelectorAll('#modelRows .model').length > 0);
    await page.waitForTimeout(1700);
    await page.evaluate(() => window.scrollTo({ top: document.getElementById('ayirma').offsetTop + 20, behavior: 'instant' }));
    await page.waitForFunction(() => document.querySelector('#nav a[aria-current="true"]')?.dataset.sec === 'ayirma');
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
    await page.waitForFunction(() => document.querySelector('#nav a[aria-current="true"]')?.dataset.sec === 'tanilama');

    // (3) yeni ve eski adresler doğru bölümü açar: açılışta ve hashchange'de
    for (const [hash, sec] of [...SECTIONS.map((s) => [s, s]), ...Object.entries(OLD)]) {
      await page.goto(url('', '#' + hash));
      assert.deepEqual(await current(page), [sec], `açılış #${hash}`);
      await waitInView(page, sec);
      await page.waitForFunction(() => document.querySelectorAll('#modelRows .model').length > 0);
      await waitInView(page, sec); // modeller yüklenip sayfa uzadıktan sonra da yerinde
    }
    await page.goto(url('', '#sozluk'));
    for (const [hash, sec] of Object.entries(OLD)) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForFunction((s) => document.querySelector('#nav a[aria-current="true"]')?.dataset.sec === s, sec);
      await waitInView(page, sec);
      await page.evaluate(() => { location.hash = 'sozluk'; });
      await page.waitForFunction(() => document.querySelector('#nav a[aria-current="true"]')?.dataset.sec === 'sozluk');
    }
    // sayfa içi bağlantılar (indirme ipucu, şerit) bölüme götürür
    assert.equal(await page.getAttribute('#goDiag', 'href'), '#tanilama');

    // (5) test motoru satırı: motor test modundayken her zaman; gerçek modda yalnızca #gelistirici / ?dev=1
    // (yalnız hash değişen goto sayfayı yeniden yüklemez; geliştirici kipi sayfa açık kaldıkça sürer)
    await page.goto('about:blank');
    await opt.evaluate(() => chrome.storage.local.set({ engineMode: 'mock' }));
    await page.goto(url('', '#diger'));
    assert.ok(await page.isVisible('#mockRow'), 'test modunda satır görünür');
    await page.click('#mock');
    await page.waitForFunction(() => chrome.storage.local.get('engineMode').then((s) => s.engineMode === 'real'));
    await opt.evaluate(() => chrome.storage.local.set({ engineMode: 'real' }));
    await page.goto(url('', '#diger'));
    assert.ok(!(await page.isVisible('#mockRow')), 'gerçek modda satır gizli');
    await page.goto(url('', '#gelistirici'));
    assert.deepEqual(await current(page), ['tanilama']);
    assert.ok(await page.isVisible('#mockRow'), '#gelistirici ile görünür');
    assert.equal(await page.evaluate(() => location.hash), '#gelistirici', 'geliştirici adresi korunur');
    await page.click('#nav-sesler');
    assert.ok(await page.isVisible('#mockRow'), 'başka bölüme gidince de görünür kalır');
    await page.goto(url('?dev=1', '#diger'));
    assert.ok(await page.isVisible('#mockRow'), '?dev=1 ile görünür');

    // Gerçek modda ses ve çeviri seçimleri ayarı yazar
    await page.goto(url('', '#sesler'));
    await page.waitForSelector('#voiceChoice input[value="ahenk-cep"]', { state: 'attached' });
    await page.check('#voiceChoice input[value="ahenk-cep"]', { force: true });
    await page.waitForFunction(() => chrome.storage.local.get('voice').then((s) => s.voice === 'ahenk-cep'));
    // Supertonic: tek radyo + hazır ses seçici; modeller listesinde tek satır
    await page.check('#voiceChoice input[value="supertonic-3"]', { force: true });
    await page.waitForFunction(() => chrome.storage.local.get('voice').then((s) => s.voice === 'supertonic-3:F1'));
    await page.waitForSelector('#presetRow:not([hidden])');
    await page.selectOption('#preset', 'supertonic-3:M2');
    await page.waitForFunction(() => chrome.storage.local.get('voice').then((s) => s.voice === 'supertonic-3:M2'));
    assert.ok(await page.isChecked('#voiceChoice input[value="supertonic-3"]'));
    assert.ok(await page.isVisible('#blendRow'), 'Supertonic seçiliyken ses karıştırma görünür');
    await page.waitForFunction(() => document.querySelectorAll('#modelRows .model').length > 0);
    const names = await page.$$eval('#modelRows .model .name', (els) => els.map((e) => e.textContent));
    assert.equal(names.filter((n) => n.startsWith('Supertonic')).length, 1, 'paket tek satır: ' + names.join(' | '));
    await page.check('#voiceChoice input[value="ahenk-cep"]', { force: true });
    await page.waitForFunction(() => chrome.storage.local.get('voice').then((s) => s.voice === 'ahenk-cep'));
    assert.ok(await page.isHidden('#blendRow'), 'Supertonic dışında ses karıştırma gizli');
    await page.goto(url('', '#genel'));
    await page.waitForSelector('#mtChoice input[value="opus-mt"]', { state: 'attached' });
    await page.check('#mtChoice input[value="opus-mt"]');
    await page.waitForFunction(() => chrome.storage.local.get('mtBackend').then((s) => s.mtBackend === 'opus-mt'));
    await page.check('#mtChoice input[value=""]');
    await page.waitForFunction(() => chrome.storage.local.get('mtBackend').then((s) => s.mtBackend == null));
    // Genel bölümündeki ana anahtar etiketi ayara göre değişir
    await opt.evaluate(() => chrome.storage.local.set({ enabled: false }));
    await page.waitForFunction(() => document.getElementById('enabledLabel').textContent === 'Yeni sekmede kapalı');
    await page.click('#enabled');
    await page.waitForFunction(() => chrome.storage.local.get('enabled').then((s) => s.enabled === true));
    assert.equal(await page.textContent('#enabledLabel'), 'Yeni sekmede açık');

    // ★ Favori: kartta favori kadın/erkek sesi; aynı cinsiyetin eskisinin yerine geçer, ikinci basış kaldırır;
    // favori ses seçiliyken üslup değişikliği favorinin tonuna da yazılır
    await opt.evaluate(() => chrome.storage.local.set({ engineMode: 'real', voice: 'ahenk-cep', style: 'lively', pitch: 1, favFemale: null, favMale: null, genderVoices: true }));
    await page.goto(url('', '#sesler'));
    await page.waitForSelector('[data-fk="fav:ahenk-cep"]');
    await page.click('[data-fk="fav:ahenk-cep"]');
    await page.waitForFunction(() => chrome.storage.local.get('favFemale').then((s) => s.favFemale?.voice === 'ahenk-cep' && s.favFemale.style === 'lively' && s.favFemale.pitch === 1));
    await page.waitForSelector('[data-fk="fav:ahenk-cep"].on');
    await page.check('#styleChoice input[value="calm"]');
    await page.waitForFunction(() => chrome.storage.local.get('favFemale').then((s) => s.favFemale?.style === 'calm'));
    await page.click('[data-fk="fav:ema-lightning"]');
    await page.waitForFunction(() => chrome.storage.local.get('favFemale').then((s) => s.favFemale?.voice === 'ema-lightning'));
    assert.equal(await page.isChecked('#voiceChoice input[value="ahenk-cep"]'), true, 'yıldız sesi seçmez');
    await page.click('[data-fk="fav:antalia-mini"]');
    await page.waitForFunction(() => chrome.storage.local.get('favMale').then((s) => s.favMale?.voice === 'antalia-mini'));
    assert.match(await page.textContent('#genderNote'), /Kadın: EMA Lightning ★.*Erkek: Antalia Mini ★/);
    await page.click('[data-fk="fav:ema-lightning"]');
    await page.waitForFunction(() => chrome.storage.local.get('favFemale').then((s) => s.favFemale == null));
    await opt.evaluate(() => chrome.storage.local.set({ favFemale: null, favMale: null, style: 'natural', pitch: 0 }));

    // Konuşmacı sesleri: 4 ses açıkken 2.–4. ses satırları görünür (otomatik cinsiyet kapalı); dar ekranda taşmaz
    for (const voice of ['supertonic-3:F2', 'antalia-mini']) {
      await opt.evaluate((v) => chrome.storage.local.set({ engineMode: 'real', voice: v, speakerVoices: true, speakerCount: 4, genderVoices: false }), voice);
      for (const w of [1280, 390]) {
        await page.setViewportSize({ width: w, height: 720 });
        await page.goto(url('', '#sesler'));
        await page.waitForSelector('#voice4Row:not([hidden])');
        assert.ok(await page.isVisible('#speakerCountRow'), 'ses sayısı seçici görünür');
        assert.ok(await overflowX(page) <= 0, `4 konuşmacı sesiyle yatay taşma (${voice} ${w})`);
      }
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    // otomatik cinsiyet açıkken: sırayla seçeneği "aynı cinsiyetten" anlamına gelir, ses seçicileri gizli
    await opt.evaluate(() => chrome.storage.local.set({ genderVoices: true }));
    await page.waitForSelector('#voice2Row[hidden]', { state: 'attached' });
    assert.match(await page.textContent('#speakerVoicesLabel'), /Aynı cinsiyetten/);
    assert.ok(await page.isVisible('#matchVoices'), 'benzeyen ses satırı cinsiyet moduyla görünür');
    await opt.evaluate(() => chrome.storage.local.set({ genderVoices: false }));
    await page.waitForFunction(() => document.getElementById('matchVoices').closest('label').hidden);
    await opt.evaluate(() => chrome.storage.local.set({ speakerVoices: false, speakerCount: 2 }));

    // Ses ayırma + başta ön tampon: ayarı yazar, ayırma kapalıyken süre devre dışıdır
    await opt.evaluate(() => chrome.storage.local.set({ engineMode: 'real', separation: 'auto', prebufferSec: 20 }));
    await page.goto(url('', '#ai-model'));
    await page.waitForSelector('#separation');
    assert.equal(await page.isChecked('#separation'), true);
    assert.equal(await page.isDisabled('#prebufferSec'), false);
    assert.equal(await page.textContent('#prebufferSecOut'), '20 sn');
    await page.click('#separation', { force: true });
    await page.waitForFunction(() => chrome.storage.local.get('separation').then((s) => s.separation === 'off'));
    await page.waitForFunction(() => document.getElementById('prebufferSec').disabled === true);
    await page.click('#separation', { force: true });
    await page.waitForFunction(() => chrome.storage.local.get('separation').then((s) => s.separation === 'auto'));
    await page.fill('#prebufferSec', '35');
    await page.dispatchEvent('#prebufferSec', 'change');
    await page.waitForFunction(() => chrome.storage.local.get('prebufferSec').then((s) => s.prebufferSec === 35));
    assert.equal(await page.textContent('#prebufferSecOut'), '35 sn');
    // kart tercihi ve ayırma kalitesi aynı bölümde, ayarı yazar
    await page.selectOption('#sepQuality', 'fast');
    await page.waitForFunction(() => chrome.storage.local.get('sepQuality').then((s) => s.sepQuality === 'fast'));
    await page.selectOption('#gpuPreference', 'low-power');
    await page.waitForFunction(() => chrome.storage.local.get('gpuPreference').then((s) => s.gpuPreference === 'low-power'));
    await opt.evaluate(() => chrome.storage.local.set({ separation: 'off' }));
    await page.waitForFunction(() => document.getElementById('separation').checked === false);
    await opt.evaluate(() => chrome.storage.local.set({ separation: 'auto', prebufferSec: 20, sepQuality: 'high', gpuPreference: 'high-performance' }));
    // otomatik güncelleme Güncelleme bölümünde, durum metni dolu
    assert.ok(await page.evaluate(() => document.getElementById('guncelleme').contains(document.getElementById('autoUpdatePick'))));
    await page.waitForFunction(() => document.getElementById('autoUpdateStatus').textContent.length > 0);

    // Dinle: test motorunda örnek sesi çalar (hata iletisi yok)
    await opt.evaluate(() => chrome.storage.local.set({ engineMode: 'mock', modelsApproved: true, voice: null }));
    await page.goto(url('', '#seslendirme'));
    await page.waitForSelector('#preview:not([disabled])');
    await page.click('#preview');
    await page.waitForFunction(() => !/hazırlanıyor/i.test(document.getElementById('styleNote').textContent), null, { timeout: 15000 });
    assert.ok(!/çalınamadı/.test(await page.textContent('#styleNote')), await page.textContent('#styleNote'));

    // Hız testi: test motorunda üç aşama da çalışır, sonuç görünür, kopyalama düğmesi açılır, rapora yazılır
    await opt.evaluate(() => chrome.storage.local.set({ engineMode: 'mock', modelsApproved: true, voice: null, benchLast: null }));
    await page.goto(url('', '#ayirma'));
    await page.waitForSelector('#benchBlock');
    assert.equal(await page.isVisible('#benchRun'), true, 'hız testi ayırma bölümünde açık');
    assert.equal(await page.isHidden('#benchOut'), true);
    await page.click('#benchRun');
    await page.waitForSelector('#benchOut:not([hidden])', { timeout: 60000 });
    const bench = await page.textContent('#benchOut');
    assert.match(bench, /ses ayırma:/, bench);
    assert.match(bench, /seslendirme:/, bench);
    assert.match(bench, /çeviri: 8 cümle/, bench);
    assert.equal(await page.isHidden('#benchCopy'), false);
    assert.equal(await page.isDisabled('#benchRun'), false);
    await page.waitForFunction(() => chrome.storage.local.get('benchLast').then((s) => s.benchLast?.lines?.length >= 3));
    await page.click('#nav-tanilama');
    await page.click('.diag:not(#benchBlock) summary');
    await page.waitForFunction(() => /\[Hız testi \(/.test(document.getElementById('diagText').textContent), null, { timeout: 15000 });

    // cihaz profili: seçici var, seçim ilgili ayarları depoya yazar ve sayfada yansır
    await page.goto(url('', '#ayirma'));
    await page.waitForSelector('#deviceProfile input[name="deviceProfile"]', { state: 'attached' });
    assert.equal(await page.locator('#deviceProfile input').count(), 5, 'beş profil seçeneği');
    await page.locator('#deviceProfile label:has(input[value="cpu"])').click();
    await page.waitForFunction(() => chrome.storage.local.get(null).then((s) => s.deviceProfile === 'cpu' && s.sepQuality === 'fast' && s.prebufferSec === 45 && s.lookaheadSec === 60));
    await page.waitForFunction(() => document.getElementById('sepQuality').value === 'fast' && document.getElementById('profPrebuffer').textContent === '45 sn');
    assert.equal(await page.isChecked('#deviceProfile input[value="cpu"]'), true);
    assert.ok(await overflowX(page) <= 0, 'profil seçicisiyle yatay taşma yok');

    // (1) konsolda hata yok
    assert.deepEqual(problems, [], 'konsol/pageerror: ' + problems.join(' | '));
    console.log('ok — options-nav');
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
