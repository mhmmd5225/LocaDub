// "Tüm videoyu hazırla" (tam kip): ≈ 3 dk'lık sahte videoda (62 cümle, ileri bakış 10 sn) panel düğmesine basılınca video
// başındayken TÜM cümlelerin çevirisi ve sesi hazırlanır ("Video hazır"); bellekte yalnız pencere kadar ses (blob) kalır,
// depoda (eklenti kökeni, Cache API) cümle sayısı kadar kayıt olur; sona yakın bir yere sarınca cümle depodan, yeni
// sentez olmadan ve beklemeden çalar; "Durdur" tam kipi kapatır; sayfa yeniden yüklenince sesler depodan gelir (sentez
// isteği sayısı artmaz). Ekran görüntüleri: tests/extension/e2e/out/full-*.png.
//   xvfb-run -a node tests/extension/e2e/full-video.e2e.cjs
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch } = require('./common.cjs');

const VID = 'fullvideo01';
const OUT = path.resolve(__dirname, 'out');
const N = 62;
const STEP = 2900; // ms
const cues = Array.from({ length: N }, (_, k) => ({ t: 500 + k * STEP, d: 2200, text: `Sentence number ${k + 1} is here.` }));
const videos = { [VID]: cues };

function longVideo(sec = 185) {
  const f = path.join(os.tmpdir(), `locadub-e2e-${sec}.webm`);
  if (!fs.existsSync(f)) {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=5:duration=${sec}`,
      '-f', 'lavfi', '-i', `sine=frequency=300:duration=${sec}`, '-c:v', 'libvpx', '-b:v', '40k', '-c:a', 'libopus', '-shortest', f]);
  }
  return f;
}

const memory = async (opt) => (await opt.evaluate(() => chrome.runtime.sendMessage({ type: 'diag.separation' })))?.result?.memory;
const storeCount = (opt) => opt.evaluate(async () => (await (await caches.open('locadub-audio-v1')).keys()).filter((r) => !r.url.endsWith('/__index')).length);
const synthCount = (opt) => opt.evaluate(() => window.__synth);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { ctx, opt } = await launch({
    videos, videoFile: longVideo(),
    settings: { holdStart: false, lookaheadSec: 10, voice: 'mock-beep', separation: 'off', genderVoices: false },
  });
  // uzun video için aralık (Range) yanıtı: sahte sunucu dosyanın tamamını verir, Chrome o zaman sarılamaz sayar
  const file = fs.readFileSync(longVideo());
  await ctx.route('https://www.youtube.com/__test/video', (route) => {
    const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
    if (!m) return route.fulfill({ status: 200, contentType: 'video/webm', headers: { 'accept-ranges': 'bytes' }, body: file });
    const a = Number(m[1]), b = m[2] ? Math.min(Number(m[2]), file.length - 1) : file.length - 1;
    return route.fulfill({
      status: 206, contentType: 'video/webm', body: file.subarray(a, b + 1),
      headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${file.length}` },
    });
  });
  // seslendirme isteklerini say (test motoru her sentezde bir ileti yayımlar)
  await opt.evaluate(() => {
    window.__synth = 0;
    chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'mock.tts.tone' && m.text !== 'Merhaba.') window.__synth++; });
  });
  const errors = [];
  try {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    page.on('pageerror', (e) => errors.push(e.message));
    const logs = [];
    page.on('console', (m) => { if (/yt-tr-dub/.test(m.text())) logs.push(m.text()); });
    await page.goto(`https://www.youtube.com/watch?v=${VID}`);
    await page.waitForFunction(() => document.querySelector('.ld-pill')?.dataset.state === 'active', null, { timeout: 30000 });
    await page.evaluate(() => { const p = document.getElementById('movie_player'); p.style.width = '1100px'; p.style.height = '720px'; });
    assert.equal(await page.evaluate(() => document.querySelector('video').duration > 170), true, 'video süresi');
    await page.click('.ld-pill');
    await page.waitForSelector('.ld-panel:not([hidden])');
    // tam kip kapalı: pencere kadar hazırlık (10 sn ≈ 4 cümle), depo boş
    const before = await memory(opt);
    assert.ok(before.blobs <= 6 && before.stored === 0 && before.fullMode === false, JSON.stringify(before));
    const btn = page.locator('.ld-full-btn');
    assert.equal((await btn.textContent()).trim(), 'Tüm videoyu hazırla');
    assert.equal(await btn.isDisabled(), false);
    const t0 = Date.now();
    await btn.click();
    await page.waitForFunction(() => document.querySelector('.ld-full-btn').textContent === 'Durdur', null, { timeout: 5000 });
    await page.waitForFunction(() => /^Çeviri \d+\/62 · Ses \d+:\d\d \/ 2:\d\d/.test(document.querySelector('.ld-full-sum')?.textContent || ''), null, { timeout: 10000 });
    await page.waitForTimeout(1500);
    const mid = await page.evaluate(() => document.querySelector('.ld-full-sum').textContent);
    await page.locator('.ld-panel').screenshot({ path: path.join(OUT, 'full-running.png') });
    await page.waitForFunction(() => document.querySelector('.ld-full-sum')?.textContent === 'Video hazır: çeviri ve sesler tamam', null, { timeout: 120000 });
    const prepMs = Date.now() - t0;
    await page.locator('.ld-panel').screenshot({ path: path.join(OUT, 'full-done.png') });
    assert.equal(await page.evaluate(() => document.querySelector('video').currentTime < 1), true, 'video başta kalmalı');
    const done = await memory(opt);
    const stored = await storeCount(opt);
    assert.equal(done.stored, N, 'diskte hazır cümle: ' + JSON.stringify(done));
    assert.equal(stored, N, 'depodaki kayıt: ' + stored);
    // bellekte yalnız pencere (10 sn ileri ≈ 4 cümle; ilk tam kipten önceki pencere de sayılır)
    assert.ok(done.blobs <= 6, 'bellekte fazla blob: ' + JSON.stringify(done));
    const synthDone = await synthCount(opt);
    assert.ok(synthDone >= N, 'sentez sayısı: ' + synthDone);
    // hap tam kipte kendi durumlarını korur
    assert.equal(await page.evaluate(() => document.querySelector('.ld-pill').dataset.state), 'active');

    // sona yakın sar: cümle depodan yüklenip beklemeden çalar, yeni sentez yok
    const k = N - 4;
    const at = (500 + k * STEP) / 1000 - 0.6;
    const tSeek = Date.now();
    await page.evaluate((at) => { const v = document.querySelector('video'); v.currentTime = at; v.play().catch(() => {}); }, at);
    await page.waitForFunction((k) => Number(document.querySelector('.ld-now')?.dataset.idx) === k, k, { timeout: 8000 }).catch(async (e) => {
      console.error('DEBUG', await page.evaluate(() => ({ t: document.querySelector('video').currentTime, p: document.querySelector('video').paused, idx: document.querySelector('.ld-now')?.dataset.idx })), JSON.stringify(await memory(opt)), logs.slice(-15).join('\n'));
      throw e;
    });
    const seekMs = Date.now() - tSeek;
    const late = await page.evaluate((s) => document.querySelector('video').currentTime - s, (500 + k * STEP) / 1000);
    assert.ok(late < 0.8, `cümle geç başladı: ${late.toFixed(2)} sn`);
    assert.equal(await synthCount(opt), synthDone, 'sarınca yeniden sentez yapıldı');
    const afterSeek = await memory(opt);
    assert.ok(afterSeek.blobs <= 8, 'sarma sonrası blob: ' + JSON.stringify(afterSeek));

    // Durdur: tam kip kapanır, hazırlananlar kalır
    await btn.click();
    await page.waitForFunction(() => document.querySelector('.ld-full-btn').textContent === 'Tüm videoyu hazırla', null, { timeout: 5000 });
    const stopped = await memory(opt);
    assert.equal(stopped.fullMode, false);
    assert.equal(stopped.stored, N);

    // yeniden yükle: tam kip kapalı ama sesler depodan gelir (sentez sayısı artmaz)
    await page.evaluate(() => document.querySelector('video').pause());
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.ld-pill')?.dataset.state === 'active', null, { timeout: 30000 });
    await page.evaluate(() => document.querySelector('video').play().catch(() => {}));
    await page.waitForFunction(() => Number(document.querySelector('.ld-now')?.dataset.idx) >= 1, null, { timeout: 15000 });
    await page.waitForTimeout(2000);
    const reload = await memory(opt);
    assert.equal(await synthCount(opt), synthDone, 'yeniden yüklemede sentez yapıldı');
    assert.ok(reload.stored >= 3 && reload.storeItems === N && reload.fullMode === false, JSON.stringify(reload));
    assert.deepEqual(errors, []);
    console.log(`ok — full-video (${N} cümle, hazırlık ${(prepMs / 1000).toFixed(1)} sn, ara: "${mid}", bellek ${done.blobs} blob, ` +
      `depo ${stored} kayıt, sentez ${synthDone}, sarma → çalma ${seekMs} ms, gecikme ${late.toFixed(2)} sn, yeniden yüklemede ${reload.blobs} blob / 0 sentez)`);
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
