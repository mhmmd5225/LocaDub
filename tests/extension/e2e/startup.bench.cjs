// Başlangıç süresi ölçümü (test değil, ölçüm): gerçek motorlarla, sahte YouTube'da 60 sn'lik İngilizce altyazılı bir video
// açılır ve TR düğmesinin "Hazırlanıyor" durumundan "Dublaj aktif"e geçmesi ölçülür. Tarayıcı her turda yeniden
// başlatılır (offscreen soğuk: modeller önbellekte ama yüklü değil), profil kalıcıdır (modeller bir kez iner).
//
//   xvfb-run -a node tests/extension/e2e/startup.bench.cjs [--runs 3] [--voice antalia-mini] [--profile DIR] [--watch 30]
//   taskset -c 0,1 xvfb-run -a node tests/extension/e2e/startup.bench.cjs     # 2 çekirdekli düşük sistem benzetimi
//
// İlk çalıştırma OPUS-MT (≈ 300 MB) ve sesi HuggingFace'ten indirir. Çıktı: tur başına düğme durum değişimleri (ms,
// sayfa açılışından) ve içerik betiğinin hazırlık dökümü ([yt-tr-dub] hazırlık …) varsa o.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { installFakeYouTube } = require('./fake-youtube.cjs');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const RUNS = Number(arg('--runs', 3));
const VOICE = arg('--voice', 'antalia-mini');
const WATCH = Number(arg('--watch', 0)); // aktif olduktan sonra kaç sn izlensin (takılma sayısı)
const PROFILE = path.resolve(arg('--profile', path.join(os.tmpdir(), 'locadub-bench-profile')));
const EXT = path.resolve(__dirname, '../../../extension');
const VID = 'startupbnch';

const LINES = [
  'Hello everyone and welcome back to the channel.', 'Today we are going to talk about something really interesting.',
  'Many people ask me how I learned to code so quickly.', 'The honest answer is that I practiced every single day.',
  'First, you need to pick a language that you enjoy.', 'Second, build small projects that solve real problems.',
  'Do not worry about making mistakes at the beginning.', 'Every expert was once a beginner who refused to give up.',
  'Let me show you the tools that I use every day.', 'This editor is free and works on every operating system.',
  'If you like this video, please subscribe to the channel.', 'In the next part, we will write our very first program.',
  'It only takes a few minutes, so stay with me.', 'Open the terminal and type the following command.',
  'Now press enter and wait for the installation to finish.', 'Great, everything is ready and we can start coding.',
  'See you in the next video, and thanks for watching.',
];
const videos = { [VID]: LINES.map((text, i) => ({ t: 500 + i * 3500, d: 3200, text })) };

function video() {
  const f = path.join(os.tmpdir(), 'locadub-bench-60s.webm');
  if (!fs.existsSync(f)) {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '62', '-c:v', 'libvpx', '-b:v', '60k', '-c:a', 'libopus', '-shortest', f]);
  }
  return f;
}

async function open() {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'],
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost' } : undefined,
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  await installFakeYouTube(ctx, { videos, videoFile: video() });
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${id}/options/options.html`);
  return { ctx, opt };
}

async function run(n) {
  const { ctx, opt } = await open();
  try {
    await opt.evaluate((voice) => chrome.storage.local.set({ enabled: true, engineMode: 'real', modelsApproved: true, voice, mtBackend: 'opus-mt' }), VOICE);
    // her tur çeviri önbelleği olmadan (ilk kez açılan video)
    await opt.evaluate(() => chrome.storage.local.get(null).then((all) => chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('tr:')))));
    if (n === 0) {
      // modeller önbellekte olsun (ilk tur indirir); ölçüm sonraki tarayıcı oturumlarında
      const t0 = Date.now();
      const r = await opt.evaluate(() => Promise.all([
        chrome.runtime.sendMessage({ type: 'engine.init', engine: 'mt', userInitiated: true }),
        chrome.runtime.sendMessage({ type: 'engine.init', engine: 'tts', userInitiated: true }),
      ]));
      console.log(`hazırlık (indirme + yükleme): ${((Date.now() - t0) / 1000).toFixed(1)} s`, r.map((x) => x.ok));
      return null;
    }
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', (m) => { if (/yt-tr-dub/.test(m.text())) logs.push(m.text()); });
    await page.addInitScript(() => {
      window.__steps = [];
      const t0 = performance.now();
      let last = '';
      setInterval(() => {
        const b = document.querySelector('[data-state]');
        const s = b ? `${b.dataset.state} ${b.title.split(' — ')[1] || ''}`.trim() : '';
        if (s && s !== last) { last = s; window.__steps.push([Math.round(performance.now() - t0), s, Math.round(document.querySelector('video')?.currentTime * 10) / 10]); }
      }, 20);
    });
    await page.goto(`https://www.youtube.com/watch?v=${VID}`);
    await page.evaluate(() => document.querySelector('video').play());
    await page.waitForFunction(() => window.__steps.some(([, s]) => s.startsWith('active') || s.startsWith('error')), null, { timeout: 300000 });
    await page.waitForTimeout(500 + WATCH * 1000);
    const steps = await page.evaluate(() => window.__steps);
    const active = steps.find(([, s]) => s.startsWith('active'));
    const stalls = active ? steps.filter(([t, st]) => t > active[0] && st.startsWith('preparing')).length : 0;
    console.log(`tur ${n}: aktif ${active ? active[0] : '—'} ms (video ${active ? active[2] : '—'} sn)${WATCH ? `, sonraki ${WATCH} sn'de ${stalls} takılma` : ''}`);
    for (const [t, s, vt] of steps) console.log(`   ${String(t).padStart(6)} ms  video ${String(vt).padStart(4)} s  ${s}`);
    for (const l of logs.filter((l) => /hazırlık/.test(l))) console.log('   ' + l);
    return active ? active[0] : null;
  } finally {
    await ctx.close();
  }
}

(async () => {
  console.log(`profil ${PROFILE}, ses ${VOICE}, çekirdek ${os.cpus().length} (taskset ile sınırlıysa daha az)`);
  if (!fs.existsSync(path.join(PROFILE, 'Default'))) await run(0);
  const times = [];
  for (let n = 1; n <= RUNS; n++) times.push(await run(n));
  const ok = times.filter((x) => x != null).sort((a, b) => a - b);
  console.log(`ortanca aktif: ${ok.length ? ok[Math.floor(ok.length / 2)] : '—'} ms (${times.join(', ')})`);
})().catch((e) => { console.error(e); process.exit(1); });
