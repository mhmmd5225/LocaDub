// Konuşanın cinsiyetine göre ses: videonun sesi önce erkek, sonra kadın konuşma (tests/extension/fixtures, eklentinin
// kendi sesleriyle üretilmiş). Eklenti perdeyi videonun sesinden ölçer; kadın konuşmaya geçince sonraki cümleleri
// favori kadın sesiyle hazırlar. Test motoru: favori erkek = mock-beep, favori kadın = mock-silent.
//   xvfb-run -a node tests/extension/e2e/gender-voices.e2e.cjs
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch } = require('./common.cjs');

const VID = 'gendertest1';
const FIX = path.resolve(__dirname, '../fixtures');
const CLIPS = ['male-antalia', 'male-supertonic', 'male-antalia', 'female-ahenk', 'female-ema', 'female-supertonic', 'female-ahenk'];
const videos = { [VID]: CLIPS.map((c, i) => ({ t: i * 3000 + 200, d: 2600, text: `This is sentence number ${i + 1}.` })) };

function genderVideo() {
  const f = path.join(os.tmpdir(), 'locadub-gender-e2e.webm');
  if (!fs.existsSync(f)) {
    const list = path.join(os.tmpdir(), 'locadub-gender-e2e.txt');
    fs.writeFileSync(list, CLIPS.map((c) => `file '${path.join(FIX, c + '.wav')}'`).join('\n'));
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=10:duration=${CLIPS.length * 3}`,
      '-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libvpx', '-b:v', '60k', '-c:a', 'libopus', '-shortest', f]);
  }
  return f;
}

(async () => {
  const { ctx } = await launch({
    videos, videoFile: genderVideo(),
    settings: { voice: 'mock-beep', holdStart: false, favMale: { voice: 'mock-beep' }, favFemale: { voice: 'mock-silent' } },
  });
  try {
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', (m) => { if (/yt-tr-dub/.test(m.text())) logs.push(m.text()); });
    await page.goto(`https://www.youtube.com/watch?v=${VID}`);
    await page.evaluate(() => document.querySelector('video').play());
    await page.waitForFunction(() => document.querySelector('video').currentTime > 20.5, null, { timeout: 60000 });
    const said = logs.filter((l) => /konuşan:/.test(l));
    const voice = Object.fromEntries(logs.map((l) => /ses (\d+): (\S+)/.exec(l)).filter(Boolean).map((m) => [Number(m[1]), m[2]]));
    assert.ok(said.some((l) => /erkek/.test(l)), 'erkek duyulmadı: ' + logs.join('\n'));
    assert.ok(said.some((l) => /kadın/.test(l)), 'kadın duyulmadı: ' + logs.join('\n'));
    assert.ok(said.findIndex((l) => /erkek/.test(l)) < said.findIndex((l) => /kadın/.test(l)), said.join(' | '));
    // erkek cümleler erkek sesiyle; kadın konuşmanın duyulduğu cümleden sonrakiler kadın sesiyle (son sentez)
    for (const i of [0, 1, 2]) assert.equal(voice[i], 'mock-beep', `cümle ${i}: ${voice[i]}`);
    for (const i of [4, 5, 6]) assert.equal(voice[i], 'mock-silent', `cümle ${i}: ${voice[i]}\n${logs.join('\n')}`);
    console.log('ok — gender-voices', said.join(' | '));
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
