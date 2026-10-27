// Otomatik altyazıda noktalama geri kazanımı (isteğe bağlı model). Gerçek noktalama modeli kullanılır; huggingface.co
// adresleri tests/mt/.models/punct-en/ dosyalarından sunulur (HF'ten bir kez indirilir: bkz. tests/mt/compare.mjs).
//   xvfb-run -a node tests/extension/e2e/asr-punct.e2e.cjs
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { launch } = require('./common.cjs');

const DIR = path.resolve(__dirname, '../../mt/.models/punct-en');
const FILES = { 'punct_cap_seg_en.onnx': 'application/octet-stream', 'spe_32k_lc_en.model': 'application/octet-stream' };
if (!Object.keys(FILES).every((f) => fs.existsSync(path.join(DIR, f)))) {
  console.log('atlandı — noktalama modeli yok:', DIR);
  process.exit(0);
}

// 210 MB'lık gövdeyi Playwright route.fulfill ile (CDP üzerinden) taşımak takılıyor: dosyalar yerel sunucudan sunulur,
// huggingface.co istekleri oraya yönlendirilir.
function serveModel() {
  const CORS = { 'Access-Control-Allow-Origin': '*' };
  const server = http.createServer((req, res) => {
    const f = path.join(DIR, path.basename(req.url));
    if (!FILES[path.basename(req.url)] || !fs.existsSync(f)) { res.writeHead(404, CORS).end(); return; }
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(f).size });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, 'localhost', () => resolve({ server, port: server.address().port })));
}

const TEXT = 'hello and welcome to the show today we are talking about cats';
const cues = (t) => [{ t: 300, d: 9000, text: t }];
const videos = {
  asrbefore01: cues(TEXT), asrafter001: cues(TEXT), manualvid01: cues(TEXT), mixedcase01: cues('Already Proper Case here'),
};
const sub = (page) => page.evaluate(() => document.querySelector('.yt-tr-dub-sub')?.textContent || '');

async function watch(ctx, id) {
  const page = await ctx.newPage();
  await page.goto(`https://www.youtube.com/watch?v=${id}`);
  await page.evaluate(() => document.querySelector('video').play());
  await page.waitForFunction(() => /\[TR\]/.test(document.querySelector('.yt-tr-dub-sub')?.textContent || ''), null, { timeout: 40000 });
  const text = await sub(page);
  await page.close();
  return text;
}

(async () => {
  const { ctx, id, opt } = await launch({ videos, asr: ['asrbefore01', 'asrafter001', 'mixedcase01'] });
  let server;
  try {
    const served = await serveModel();
    server = served.server;
    const port = served.port;
    await ctx.route('https://huggingface.co/1-800-BAD-CODE/**', (route) => {
      const name = new URL(route.request().url()).pathname.split('/').pop();
      return route.fulfill({ status: 302, headers: { Location: `http://localhost:${port}/${name}`, 'Access-Control-Allow-Origin': '*' } });
    });

    // 1) Ayar açık ama model indirilmemiş: metin özgün kalır
    await opt.evaluate(() => chrome.storage.local.set({ fixAsrPunct: true }));
    assert.equal(await watch(ctx, 'asrbefore01'), `[TR] ${TEXT}`);

    // 2) Ayarlar sayfasındaki karttan indir: ayar kendiliğinden açılır
    await opt.goto(`chrome-extension://${id}/options/options.html#modeller`);
    await opt.evaluate(() => chrome.storage.local.set({ fixAsrPunct: false }));
    await opt.waitForSelector('#punctModels .model');
    assert.match(await opt.textContent('#punctModels .model .name'), /İndirilmedi/);
    await opt.click('#punctModels .model button:has-text("İndir")');
    await opt.click('#confirmYes');
    await opt.waitForFunction(() => /Hazır|İndirildi/.test(document.querySelector('#punctModels .model .name')?.textContent || ''), null, { timeout: 60000 });
    await opt.waitForFunction(() => /Kullanılıyor/.test(document.querySelector('#punctModels .model .name')?.textContent || ''));
    assert.equal((await opt.evaluate(() => chrome.storage.local.get('fixAsrPunct'))).fixAsrPunct, true);
    await opt.locator('#punctModels').screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/punct-card.png' : '/dev/null' }).catch(() => {});

    // 3) Otomatik altyazı: noktalama ve büyük harf eklenir; çeviri (test motoru) düzeltilmiş metni alır
    const fixed = await watch(ctx, 'asrafter001');
    assert.equal(fixed, '[TR] Hello and welcome to the show. Today we are talking about cats.');

    // 4) Elle yazılmış altyazıya dokunulmaz; büyük harfli otomatik metin de değişmez
    assert.equal(await watch(ctx, 'manualvid01'), `[TR] ${TEXT}`);
    assert.equal(await watch(ctx, 'mixedcase01'), '[TR] Already Proper Case here');

    // 5) Modeli sil: ayar kapanır
    await opt.reload();
    await opt.waitForSelector('#punctModels .model button:has-text("Sil")');
    await opt.click('#punctModels .model button:has-text("Sil")');
    await opt.click('#confirmYes');
    await opt.waitForFunction(() => /İndirilmedi/.test(document.querySelector('#punctModels .model .name')?.textContent || ''));
    assert.equal((await opt.evaluate(() => chrome.storage.local.get('fixAsrPunct'))).fixAsrPunct, false);
    console.log('ok — asr-punct');
  } finally {
    await ctx.close().catch(() => {});
    server?.close?.();
  }
})().catch((e) => { console.error(e); process.exit(1); });
