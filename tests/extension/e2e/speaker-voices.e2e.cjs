// B2: konuşmacılara farklı ses. >> işaretli cümleler ikinci konuşmacıya düşer ve ikinci sesle sentezlenir.
// Test motorunda ikinci ses "mock-silent": sessiz PCM kırpılınca boş kalır, yani o cümlelerin sesi çalınmaz.
//   xvfb-run -a node tests/extension/e2e/speaker-voices.e2e.cjs
const assert = require('assert/strict');
const { launch } = require('./common.cjs');

const VID = 'speakers001';
const videos = { [VID]: [
  { t: 500, d: 2000, text: 'Are you ready?' },
  { t: 3000, d: 2000, text: '>> Yes, I am ready.' },
  { t: 5500, d: 2000, text: '>> Then let us begin.' },
] };

(async () => {
  const { ctx, opt } = await launch({
    videos, settings: { voice: 'mock-beep', voice2: 'mock-silent', speakerVoices: true },
  });
  try {
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (/hatası|error/i.test(m.text())) errors.push(m.text()); });
    await page.goto(`https://www.youtube.com/watch?v=${VID}`);
    await page.evaluate(() => document.querySelector('video').play());
    await page.waitForFunction(() => /\[TR\] Then/.test(document.querySelector('.yt-tr-dub-sub')?.textContent || ''), null, { timeout: 40000 });
    await page.close();
    await opt.waitForTimeout(500);
    const saved = await opt.evaluate((v) => chrome.storage.local.get(null)
      .then((all) => Object.entries(all).find(([k]) => k.startsWith('tr:' + v))?.[1]?.sentences), VID);
    assert.deepEqual(saved.map((s) => s.speaker ?? 0), [0, 1, 0]);
    // Ses motoru iki sesi de kullandı mı: offscreen durumu birinci sesi göstermeli (ikinci ses motoru yeniden başlatmaz)
    const st = await opt.evaluate(() => chrome.runtime.sendMessage({ type: 'engine.status' }));
    assert.equal(st.result.tts.voice, 'mock-beep');
    assert.deepEqual(errors, []);
    console.log('ok — speaker-voices');
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
