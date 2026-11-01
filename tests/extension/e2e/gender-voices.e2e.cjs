// Konuşanın cinsiyetine göre ses: videonun sesi önce erkek, sonra kadın konuşma (tests/extension/fixtures, eklentinin
// kendi sesleriyle üretilmiş), MSE ile oynatılır, ses ayırma (sahte) açık. Konuşmacılar ayrılmış temiz konuşmadan tanınır
// (engines/spk, sahte gömme); kadın konuşmaya geçince cümleler favori kadın sesiyle hazırlanır. Ses ayırma kapalıyken
// otomatik kadın/erkek devre dışıdır: bütün cümleler birinci sesle çalar. Test motoru: favori erkek = mock-beep, kadın = mock-silent.
//   xvfb-run -a node tests/extension/e2e/gender-voices.e2e.cjs
const assert = require('assert/strict');
const { launch, clipsMse } = require('./common.cjs');

const VID = 'gendertest1';
const CLIPS = ['male-antalia', 'male-antalia', 'male-antalia', 'female-ahenk', 'female-ema', 'female-supertonic', 'female-ahenk'];
const videos = { [VID]: CLIPS.map((c, i) => ({ t: i * 3000 + 200, d: 2600, text: `This is sentence number ${i + 1}.` })) };


// ses ayırma kapalı: tek ses
async function separationOff() {
  const { ctx } = await launch({
    videos, mse: clipsMse(CLIPS),
    settings: { voice: 'mock-beep', holdStart: false, separation: 'off', genderVoices: true, favMale: { voice: 'mock-beep' }, favFemale: { voice: 'mock-silent' } },
  });
  try {
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', (m) => { if (/yt-tr-dub/.test(m.text())) logs.push(m.text()); });
    await page.goto(`https://www.youtube.com/watch?v=${VID}`);
    await page.evaluate(() => document.querySelector('video').play().catch(() => {}));
    await page.waitForFunction(() => document.querySelector('video').currentTime > 20.5, null, { timeout: 60000 });
    const voices = logs.map((l) => /ses (\d+): (\S+)/.exec(l)).filter(Boolean).map((m) => m[2]);
    assert.ok(voices.length >= 5, 'ses üretilmedi: ' + logs.join('\n'));
    assert.ok(voices.every((v) => v === 'mock-beep'), 'ayırma kapalıyken tek ses beklenir: ' + voices.join(','));
    assert.ok(!logs.some((l) => /konuşan:/.test(l)), 'ayırma kapalıyken cinsiyet ölçülmemeli: ' + logs.join('\n'));
  } finally {
    await ctx.close();
  }
}

(async () => {
  await separationOff();
  const { ctx } = await launch({
    videos, mse: clipsMse(CLIPS),
    settings: { voice: 'mock-beep', holdStart: false, prebufferSec: 5, genderVoices: true, favMale: { voice: 'mock-beep' }, favFemale: { voice: 'mock-silent' } },
  });
  try {
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', (m) => { if (/yt-tr-dub/.test(m.text())) logs.push(m.text()); });
    await page.goto(`https://www.youtube.com/watch?v=${VID}`);
    await page.evaluate(() => document.querySelector('video').play().catch(() => {}));
    await page.waitForFunction(() => document.querySelector('video').currentTime > 20.5, null, { timeout: 60000 });
    const said = logs.filter((l) => /konuşan:/.test(l));
    const voice = Object.fromEntries(logs.map((l) => /ses (\d+): (\S+)/.exec(l)).filter(Boolean).map((m) => [Number(m[1]), m[2]]));
    assert.ok(said.some((l) => /erkek/.test(l)), 'erkek duyulmadı: ' + logs.join('\n'));
    assert.ok(said.some((l) => /kadın/.test(l)), 'kadın duyulmadı: ' + logs.join('\n'));
    assert.ok(said.findIndex((l) => /erkek/.test(l)) < said.findIndex((l) => /kadın/.test(l)), said.join(' | '));
    // erken karar: kadın konuşmanın ilk cümlesi (9.2–11.8 sn) bitmeden fark edilir
    const fem = /kadın \(\d+ Hz, ([\d.]+) sn/.exec(said.find((l) => /kadın/.test(l)));
    assert.ok(fem && Number(fem[1]) < 11.8, 'kadın konuşma cümle bitmeden fark edilmedi: ' + said.join(' | '));
    // erkek cümleler erkek sesiyle; kadın konuşmanın duyulduğu cümleden sonrakiler kadın sesiyle (son sentez)
    for (const i of [0, 1, 2]) assert.equal(voice[i], 'mock-beep', `cümle ${i}: ${voice[i]}\n${logs.join('\n')}`);
    for (const i of [4, 5, 6]) assert.equal(voice[i], 'mock-silent', `cümle ${i}: ${voice[i]}\n${logs.join('\n')}`);
    console.log('ok — gender-voices', said.join(' | '));
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
