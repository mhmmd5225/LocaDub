// E2E ortak: eklentiyi yükler, test motorunu açar, sahte YouTube'u kurar.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { installFakeYouTube } = require('./fake-youtube.cjs');

const EXT = path.resolve(__dirname, '../../../extension');

function testVideo() {
  const f = path.join(os.tmpdir(), 'locadub-e2e.webm');
  if (!fs.existsSync(f)) {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '16', '-c:v', 'libvpx', '-b:v', '100k', '-c:a', 'libopus', '-shortest', f]);
  }
  return f;
}

// MSE oynatıcı için ayrı görüntü (vp8) ve ses (opus) dosyaları; ses beyaz gürültü (senkron ölçümü için ilintisi keskin).
function mseFiles(sec = 60) {
  const v = path.join(os.tmpdir(), `locadub-mse-v-${sec}.webm`), a = path.join(os.tmpdir(), `locadub-mse-a-${sec}.webm`);
  if (!fs.existsSync(v)) {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=10:duration=${sec}`,
      '-c:v', 'libvpx', '-b:v', '80k', '-an', v]);
  }
  if (!fs.existsSync(a)) {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `anoisesrc=d=${sec}:c=white:a=0.2:r=48000`,
      '-ac', '2', '-c:a', 'libopus', '-b:a', '96k', '-vn', a]);
  }
  return { video: v, audio: a };
}

async function launch({ videos, settings = {}, onTimedtext, asr, videoFile, mse } = {}) {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'locadub-prof-')), {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'],
    // Vekil sunucu gerektiren ortamlarda gerçek ağ istekleri (ör. sitedeki version.json) için
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost' } : undefined,
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  await installFakeYouTube(ctx, { videos, videoFile: videoFile || testVideo(), onTimedtext, asr, mse: mse === true ? mseFiles() : mse || null });
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${id}/options/options.html`);
  await opt.evaluate((s) => chrome.storage.local.set({ enabled: true, engineMode: 'mock', ...s }), settings);
  return { ctx, id, opt };
}

module.exports = { launch, mseFiles };
