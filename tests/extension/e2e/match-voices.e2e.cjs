// Konuşmacıya benzeyen ses (common/voice-match.js): video önce erkek (Antalia, ≈ 132 Hz), sonra kadın (Ahenk/Ema,
// ≈ 220–250 Hz) konuşur; ses ayırma (sahte) açık. Her konuşmacı kümesine, yeterli perde kanıtından sonra perdesine en
// yakın aday ses atanır: test motorunun adayları mock-m-low 100 Hz, mock-m-high 135 Hz, mock-f-low 180 Hz,
// mock-f-high 240 Hz. Erkek → mock-m-high; kadın → mock-f-high (perde ayarıyla). Atama sonrası cümleler o sesle
// ve ayarlı perdeyle (ton) hazırlanır.
//   xvfb-run -a node tests/extension/e2e/match-voices.e2e.cjs
const assert = require('assert/strict');
const { launch, clipsMse } = require('./common.cjs');

const VID = 'matchtest01';
const CLIPS = ['male-antalia', 'male-antalia', 'male-antalia', 'female-ahenk', 'female-ema', 'female-ahenk', 'female-ema'];
const videos = { [VID]: CLIPS.map((c, i) => ({ t: i * 3000 + 200, d: 2600, text: `This is sentence number ${i + 1}.` })) };

(async () => {
  const { ctx } = await launch({
    videos, mse: clipsMse(CLIPS),
    settings: { voice: 'mock-beep', holdStart: false, prebufferSec: 5, genderVoices: true, matchVoices: true },
  });
  try {
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', (m) => { if (/yt-tr-dub/.test(m.text())) logs.push(m.text()); });
    await page.goto(`https://www.youtube.com/watch?v=${VID}`);
    await page.evaluate(() => document.querySelector('video').play().catch(() => {}));
    await page.waitForFunction(() => document.querySelector('video').currentTime > 20.5, null, { timeout: 60000 });
    const all = logs.join('\n');
    const assigned = logs.filter((l) => /konuşmacı \d+ \((kadın|erkek)/.test(l));
    assert.ok(assigned.some((l) => /erkek.*→ mock-m-high/.test(l)), 'erkeğe benzeyen ses atanmadı:\n' + all);
    assert.ok(assigned.some((l) => /kadın.*→ mock-f-high/.test(l)), 'kadına benzeyen ses atanmadı:\n' + all);
    const voice = Object.fromEntries(logs.map((l) => /ses (\d+): (\S+)/.exec(l)).filter(Boolean).map((m) => [Number(m[1]), m[2]]));
    assert.equal(voice[6], 'mock-f-high', `son cümle: ${voice[6]}\n${all}`);
    assert.ok(Object.values(voice).includes('mock-m-high'), `erkek cümlesi atanan sesle çalmadı\n${all}`);
    console.log('ok — match-voices', assigned.join(' | '));
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
