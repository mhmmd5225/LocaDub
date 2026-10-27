// Paket C1: üslup / perde / kalite. Test motoru (mock) son aldığı `tone`u globalThis.__lastTtsTone'da tutar.
//   xvfb-run -a node tests/extension/e2e/style-tone.e2e.cjs
// Doğrulananlar: (1) ayar → içerik betiği → arka plan → offscreen → motor zincirinde ton doğru taşınır,
// (2) üslup değişince üretilmiş sesler atılır ve yeniden sentezlenir, (3) Seslendirme menüsünde seçim
// chrome.storage.local'a yazılır, (4) sistem sesinde kontroller devre dışı.
const assert = require('assert/strict');
const { launch } = require('./common.cjs');

const VID = 'styletone01';
const videos = { [VID]: [
  { t: 500, d: 2000, text: 'Are you ready?' },
  { t: 3000, d: 2000, text: 'Yes, I am ready.' },
  { t: 5500, d: 2000, text: 'Then let us begin.' },
] };

(async () => {
  const { ctx, id, opt } = await launch({ videos, settings: { voice: 'mock-beep', style: 'lively', pitch: 1, quality: 'high' } });
  const problems = [];
  try {
    // Mock motor, aldığı tonu runtime iletisiyle yayımlar (offscreen belgesine Playwright'tan erişilemez)
    await opt.evaluate(() => {
      window.__tones = [];
      chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'mock.tts.tone') window.__tones.push(m.tone); });
    });
    const tones = () => opt.evaluate(() => window.__tones);
    const lastTone = async () => (await tones()).at(-1) ?? null;
    const calls = async () => (await tones()).length;
    const waitTone = async (want, label) => {
      for (let i = 0; i < 160; i++) {
        const t = await lastTone();
        if (t && t.style === want.style && t.pitch === want.pitch && t.quality === want.quality) return;
        await opt.waitForTimeout(250);
      }
      assert.fail(`${label}: beklenen ton gelmedi; son: ${JSON.stringify(await lastTone())}`);
    };

    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (/hatası|error/i.test(m.text())) problems.push(m.text()); });
    await page.goto(`https://www.youtube.com/watch?v=${VID}`);
    await page.evaluate(() => document.querySelector('video').play());

    await page.waitForFunction(() => /\[TR\] Then/.test(document.querySelector('.yt-tr-dub-sub')?.textContent || ''), null, { timeout: 40000 });
    // (1) Canlı + perde +1 + yüksek kalite motora aynen ulaşır
    await waitTone({ style: 'lively', pitch: 1, quality: 'high' }, 'ilk sentez');

    // (2) Üslup değişince üretilmiş sesler atılır, yeniden sentezlenir
    const before = await calls();
    await opt.evaluate(() => chrome.storage.local.set({ style: 'calm' }));
    await waitTone({ style: 'calm', pitch: 1, quality: 'high' }, 'üslup değişimi');
    assert.ok((await calls()) > before, 'yeniden sentezlenmedi');
    // perde ve kalite de aynı yoldan
    await opt.evaluate(() => chrome.storage.local.set({ pitch: -2, quality: 'fast' }));
    await waitTone({ style: 'calm', pitch: -2, quality: 'fast' }, 'perde/kalite değişimi');
    // geçersiz değer ayar normalleştirmesiyle varsayılana düşer ve motora temiz gider
    await opt.evaluate(() => chrome.storage.local.set({ style: 'robot', pitch: 99, quality: 'x' }));
    await waitTone({ style: 'natural', pitch: 3, quality: 'fast' }, 'geçersiz değer');
    await page.close();

    // (3) Seslendirme menüsü: Üslup seçimi ayara yazılır
    const o = await ctx.newPage();
    o.on('pageerror', (e) => problems.push('options pageerror: ' + e.message));
    await o.setViewportSize({ width: 1280, height: 720 });
    await o.goto(`chrome-extension://${id}/options/options.html#seslendirme`);
    await o.evaluate(() => chrome.storage.local.set({ style: 'natural', pitch: 0, quality: 'fast' }));
    await o.waitForFunction(() => document.querySelector('input[name="style"][value="natural"]').checked);
    await o.check('input[name="style"][value="lively"]');
    await o.waitForFunction(() => chrome.storage.local.get('style').then((s) => s.style === 'lively'));
    assert.ok(await o.isChecked('input[name="style"][value="lively"]'));
    await o.check('input[name="style"][value="calm"]');
    await o.waitForFunction(() => chrome.storage.local.get('style').then((s) => s.style === 'calm'));
    // Gelişmiş: perde kaydırıcısı ve kalite
    await o.click('#toneBlock > summary');
    await o.fill('#pitch', '1.5');
    await o.dispatchEvent('#pitch', 'change');
    await o.waitForFunction(() => chrome.storage.local.get('pitch').then((s) => s.pitch === 1.5));
    assert.equal(await o.textContent('#pitchOut'), '+1,5');
    await o.check('input[name="quality"][value="high"]');
    await o.waitForFunction(() => chrome.storage.local.get('quality').then((s) => s.quality === 'high'));
    const ov = await o.evaluate(() => { const m = document.querySelector('main'); return m.scrollHeight - m.clientHeight; });
    assert.ok(ov <= 0, `Gelişmiş açıkken panel taşıyor: ${ov}`);

    // (4) Sistem sesinde üslup/perde/kalite devre dışı + not
    await o.evaluate(() => chrome.storage.local.set({ voice: 'system' }));
    await o.waitForFunction(() => document.querySelector('input[name="style"][value="lively"]').disabled);
    for (const sel of ['input[name="style"]', 'input[name="quality"]', '#pitch']) {
      assert.ok(await o.evaluate((s) => [...document.querySelectorAll(s)].every((x) => x.disabled), sel), `${sel} devre dışı olmalı`);
    }
    assert.match(await o.textContent('#styleNote'), /Sistem sesinde kullanılamaz/);
    await o.evaluate(() => chrome.storage.local.set({ voice: 'mock-beep' }));
    await o.waitForFunction(() => !document.querySelector('input[name="style"][value="lively"]').disabled);

    assert.deepEqual(problems, [], 'konsol: ' + problems.join(' | '));
    console.log('ok — style-tone');
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
