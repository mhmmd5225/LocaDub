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

async function launch({ videos, settings = {}, onTimedtext } = {}) {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'locadub-prof-')), {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'],
    // Vekil sunucu gerektiren ortamlarda gerçek ağ istekleri (ör. sitedeki version.json) için
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost' } : undefined,
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  await installFakeYouTube(ctx, { videos, videoFile: testVideo(), onTimedtext });
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${id}/options/options.html`);
  await opt.evaluate((s) => chrome.storage.local.set({ enabled: true, engineMode: 'mock', ...s }), settings);
  return { ctx, id, opt };
}

module.exports = { launch };
