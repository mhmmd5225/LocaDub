// C3: Shorts ve gömülü oynatıcı. Her durumda TR düğmesi görünür ve dublaj altyazısı gelir.
//   xvfb-run -a node tests/extension/e2e/shorts-embed.e2e.cjs
const assert = require('assert/strict');
const { launch } = require('./common.cjs');

const cues = (n) => [{ t: 300, d: 5000, text: `Clip number ${n} starts now.` }];
const videos = { shortsvid01: cues(1), shortsvid02: cues(2), embedvid001: cues(3), nocookie001: cues(4) };

async function expectDub(frame, n) {
  await frame.evaluate(() => document.querySelector('video').play());
  await frame.waitForFunction((n) => (document.querySelector('.yt-tr-dub-sub')?.textContent || '').includes(`[TR] Clip number ${n}`),
    n, { timeout: 30000 });
}

(async () => {
  const origins = [];
  const { ctx } = await launch({ videos, onTimedtext: (id, origin) => origins.push([id, origin]) });
  try {
    // Shorts: yüzen düğme, kaydırınca (yeni adres) yeni video
    const page = await ctx.newPage();
    await page.goto('https://www.youtube.com/shorts/shortsvid01');
    await expectDub(page, 1);
    assert.equal(await page.locator('#shorts-player > .yt-tr-dub-float .yt-tr-dub-btn').count(), 1);
    await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/shorts.png' : '/dev/null' }).catch(() => {});
    await page.goto('https://www.youtube.com/shorts/shortsvid02');
    await expectDub(page, 2);
    console.log('ok — shorts');

    // Başka sitede gömülü youtube.com oynatıcısı
    const blog = await ctx.newPage();
    await blog.goto('https://example.test/?v=embedvid001');
    const f1 = await (await blog.waitForSelector('iframe')).contentFrame();
    await f1.waitForSelector('#movie_player .ytp-right-controls .yt-tr-dub-btn', { timeout: 15000 });
    await expectDub(f1, 3);
    console.log('ok — embed');

    // youtube-nocookie gömülüsü: altyazı aynı kökenden istenir
    const blog2 = await ctx.newPage();
    await blog2.goto('https://example.test/?v=nocookie001&host=www.youtube-nocookie.com');
    const f2 = await (await blog2.waitForSelector('iframe')).contentFrame();
    await expectDub(f2, 4);
    assert.deepEqual(origins.find(([id]) => id === 'nocookie001'), ['nocookie001', 'https://www.youtube-nocookie.com']);
    console.log('ok — nocookie');
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
