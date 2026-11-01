// Oynatıcı çubuğunda dublaj işaretleri: seslendirilen bölüm çubukta yeşil şerit olarak görünür, henüz seslendirilmeyen bölüm işaretlenmez,
// ileri sarınca yeni bölüm eklenir; şerit tıklamaları engellemez. (Soluk "yalnız çevrilmiş" işaret: progressmarks.test.mjs.)
//   xvfb-run -a node tests/extension/e2e/progress-marks.e2e.cjs
const assert = require('assert/strict');
const { launch } = require('./common.cjs');

const VID = 'marks000001';
const videos = { [VID]: [
  { t: 300, d: 2500, text: 'Hello and welcome to the show.' },
  { t: 3500, d: 3000, text: 'Today we are talking about cats.' },
  { t: 12000, d: 2000, text: 'Thank you for watching.' },
] };

(async () => {
  const { ctx } = await launch({ videos, settings: { holdStart: false, lookaheadSec: 10 } });
  try {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`https://www.youtube.com/watch?v=${VID}`);
    // video oynatılmaz (0. sn): 10 sn ileri hazırlıkla ilk iki cümle seslendirilir (≈ 0.3–6.5 sn, bitişik → tek aralık)
    await page.waitForFunction(() => document.querySelectorAll('.ld-marks-dubbed i').length >= 1, null, { timeout: 30000 });
    const info = await page.evaluate(() => {
      const bar = document.querySelector('.ytp-progress-bar');
      const root = document.querySelector('.ld-marks');
      const v = document.querySelector('video');
      const bi = (el) => [...el.querySelectorAll('i')].map((i) => [parseFloat(i.style.left), parseFloat(i.style.width)]);
      return {
        inBar: root?.parentNode === bar, duration: v.duration, pe: getComputedStyle(root).pointerEvents,
        dubbed: bi(document.querySelector('.ld-marks-dubbed')), translated: bi(document.querySelector('.ld-marks-translated')),
        top: root.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top + 1,
      };
    });
    assert.equal(info.inBar, true, 'şerit ilerleme çubuğunun içinde olmalı');
    assert.equal(info.pe, 'none', 'şerit tıklamaları engellememeli');
    assert.equal(info.top, true, 'şerit çubuğun üstünde olmalı');
    assert.ok(info.duration > 10, 'video süresi: ' + info.duration);
    // 0.3 sn ≈ video süresinin yüzdesi; ilk işaret oradan başlar ve en az ilk cümleyi kapsar (2.5 sn)
    const first = info.dubbed[0];
    assert.ok(Math.abs(first[0] - (0.3 / info.duration) * 100) < 1.5, JSON.stringify(info));
    assert.ok(first[1] >= (2.4 / info.duration) * 100 - 1, JSON.stringify(info));
    // 12. sn'deki cümle henüz seslendirilmedi (10 sn pencerenin dışında): yeşil değil
    const lastLeft = (12 / info.duration) * 100;
    assert.ok(!info.dubbed.some(([l]) => Math.abs(l - lastLeft) < 1), 'henüz seslendirilmeyen bölüm yeşil: ' + JSON.stringify(info.dubbed));
    // ileri sarınca 3. cümle de seslendirilir ve çubukta yeşil görünür
    await page.evaluate(() => { document.querySelector('video').currentTime = 10; document.querySelector('video').play().catch(() => {}); });
    await page.waitForFunction((l) => [...document.querySelectorAll('.ld-marks-dubbed i')].some((i) => Math.abs(parseFloat(i.style.left) - l) < 1.5), lastLeft, { timeout: 30000 });
    assert.deepEqual(errors, []);
    console.log('ok — progress-marks', JSON.stringify(info.dubbed), JSON.stringify(info.translated));
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
