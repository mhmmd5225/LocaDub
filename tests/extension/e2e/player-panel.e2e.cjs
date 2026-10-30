// Oynatıcı paneli (content/panel.js): hap ve cam panel açılır/kapanır (Esc, dışarı tıklama), YouTube kısayolları panel
// içinde yutulur; "şu an konuşan" sesi `ses N: <ses>` kaydıyla aynıdır; paneldeki kadın favorisi değişince ayar yazılır
// ve sonraki cümleler o sesle hazırlanır; ses ayırma durumu (sözleşme: EventTarget 'state') gösterilir; 1280×720,
// 1920×1080, küçük oynatıcı ve tam ekranda panel oynatıcının içinde kalır, taşma yok. Hap TR düğmesinin yanında, kontrol
// çubuğunun hemen üstünde, Türkçe altyazıyla çakışmaz; panel hapın üstünde açılır; dublaj kapalıyken hap yok.
// Ekran görüntüleri: tests/extension/e2e/out/.
// Video: önce erkek, sonra kadın konuşma (gender-voices ile aynı fikstür). Favori erkek = mock-silent, kadın = mock-beep;
// erkek bölümde panelden kadın favorisi mock-silent yapılır → kadın cümleleri de mock-silent.
//   xvfb-run -a node tests/extension/e2e/player-panel.e2e.cjs
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch } = require('./common.cjs');

const VID = 'panelvideo1';
const FIX = path.resolve(__dirname, '../fixtures');
const OUT = path.resolve(__dirname, 'out');
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

// Hap: sağ kenarı TR düğmesininkiyle hizalı, kontrol çubuğunun hemen üstünde, oynatıcının içinde, altyazıyla kesişmez.
async function checkPill(page, label) {
  const r = await page.evaluate(() => {
    const box = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
    const sub = document.querySelector('.yt-tr-dub-sub');
    return {
      player: box(document.getElementById('movie_player')), pill: box(document.querySelector('.ld-pill')),
      btn: box(document.querySelector('.yt-tr-dub-btn')), bar: box(document.querySelector('.ytp-chrome-bottom')),
      sub: sub.classList.contains('visible') ? box(sub.querySelector('span')) : null,
    };
  });
  const { pill, btn, bar, player, sub } = r;
  assert.ok(Math.abs(pill.r - btn.r) <= 1, `${label}: hap TR düğmesiyle hizalı değil ${JSON.stringify(r)}`);
  assert.ok(pill.b <= bar.t + 0.5 && pill.b >= bar.t - 16, `${label}: hap kontrol çubuğunun hemen üstünde değil ${JSON.stringify(r)}`);
  assert.ok(pill.l >= player.l && pill.t >= player.t, `${label}: hap oynatıcının dışında`);
  if (sub) {
    const hit = pill.l < sub.r && sub.l < pill.r && pill.t < sub.b && sub.t < pill.b;
    assert.ok(!hit, `${label}: hap altyazıyla çakışıyor ${JSON.stringify(r)}`);
  }
  return r;
}

// Panel ve hap oynatıcının içinde mi, yatay taşma var mı, panel hapın üstünde mi?
async function checkLayout(page, label) {
  await checkPill(page, label);
  // sayfanın kendi kaydırması (sahte sayfa) değil, panelin eklediği taşma sayılır
  const pageW = () => page.evaluate(() => document.documentElement.scrollWidth);
  await page.evaluate(() => document.querySelector('.ld-panel').hidden = true);
  const closedW = await pageW();
  await page.evaluate(() => document.querySelector('.ld-panel').hidden = false);
  const openW = await pageW();
  assert.ok(openW <= closedW, `${label}: panel sayfayı yatay taşırıyor ${openW} > ${closedW}`);
  const r = await page.evaluate(() => {
    const box = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
    const player = document.getElementById('movie_player');
    const panel = document.querySelector('.ld-panel');
    const body = panel.querySelector('.ld-body');
    const over = [...panel.querySelectorAll('*')].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'hidden' && e.tagName !== 'SELECT' && e.tagName !== 'INPUT').map((e) => e.className);
    return {
      player: box(player), panel: box(panel), pill: box(document.querySelector('.ld-pill')),
      bodyOverflowX: body.scrollWidth - body.clientWidth, over,
    };
  });
  for (const k of ['panel', 'pill']) {
    const b = r[k];
    assert.ok(b.l >= r.player.l - 0.5 && b.t >= r.player.t - 0.5 && b.r <= r.player.r + 0.5 && b.b <= r.player.b + 0.5,
      `${label}: ${k} oynatıcının dışında ${JSON.stringify(r)}`);
  }
  assert.ok(r.bodyOverflowX <= 0, `${label}: panel gövdesi yatay taşıyor ${r.bodyOverflowX}`);
  assert.deepEqual(r.over, [], `${label}: taşan öğeler`);
  if (!(await page.evaluate(() => document.querySelector('.ld-root').classList.contains('ld-tiny')))) {
    assert.ok(r.panel.b <= r.pill.t, `${label}: panel hapın üstünde açılmadı ${JSON.stringify(r)}`);
    assert.ok(Math.abs(r.panel.l - r.pill.l) <= 1 || r.panel.r <= r.player.r - 11.5, `${label}: panel hapa bağlı değil`);
  }
  await page.waitForTimeout(300); // açılış animasyonu (ekran görüntüsü için)
  return r;
}

const sizePlayer = (page, w, h) => page.evaluate(([w, h]) => {
  const p = document.getElementById('movie_player');
  p.style.width = `${w}px`;
  p.style.height = `${h}px`;
}, [w, h]);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { ctx, opt } = await launch({
    videos, videoFile: genderVideo(),
    settings: { voice: 'mock-beep', holdStart: false, favMale: { voice: 'mock-silent' }, favFemale: { voice: 'mock-beep' } },
  });
  const problems = [];
  try {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });
    const logs = [];
    page.on('console', (m) => { if (/yt-tr-dub/.test(m.text())) logs.push(m.text()); });
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    await page.goto(`https://www.youtube.com/watch?v=${VID}`);
    await page.waitForSelector('#movie_player .ld-pill', { timeout: 15000 });
    await sizePlayer(page, 1280, 720);
    await page.evaluate(() => {
      window.__keys = [];
      document.addEventListener('keydown', (e) => window.__keys.push(e.key));
    });
    await page.waitForFunction(() => document.querySelector('.ld-pill')?.dataset.state === 'active', null, { timeout: 30000 });
    await page.screenshot({ path: path.join(OUT, 'panel-closed.png') });

    // açılır, Esc ile kapanır, odak hapa döner; içerideki tuşlar YouTube'a ulaşmaz
    await page.click('.ld-pill');
    await page.waitForSelector('.ld-panel:not([hidden])');
    assert.equal(await page.getAttribute('.ld-pill', 'aria-expanded'), 'true');
    await page.focus('.ld-panel .ld-close');
    await page.keyboard.press('k');
    assert.deepEqual(await page.evaluate(() => window.__keys), [], 'panel içindeki tuş YouTube\'a ulaştı');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ld-panel', { state: 'hidden' });
    assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('ld-pill')), 'odak hapa dönmedi');
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('k');
    assert.deepEqual(await page.evaluate(() => window.__keys), ['k'], 'panel kapalıyken kısayol engellendi');
    // dışarı tıklayınca kapanır
    await page.click('.ld-pill');
    await page.waitForSelector('.ld-panel:not([hidden])');
    await page.mouse.click(200, 200);
    await page.waitForSelector('.ld-panel', { state: 'hidden' });

    // oynatma: şu an konuşan ses = `ses N` kaydı
    await page.evaluate(() => document.querySelector('video').play());
    const samples = [];
    let changed = false;
    let subChecks = 0; // altyazı görünürken hap denetimi
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const s = await page.evaluate(() => {
        const n = document.querySelector('.ld-now');
        return { t: document.querySelector('video').currentTime, hidden: n.hidden, idx: n.dataset.idx, voice: n.dataset.voice, name: n.querySelector('.ld-now-name').textContent };
      });
      if (!(await page.locator('.ld-panel').isVisible()) && (await checkPill(page, `oynatma ${s.t.toFixed(1)} sn`)).sub) subChecks++;
      if (!s.hidden && s.idx) {
        const last = logs.map((l) => /ses (\d+): (\S+)/.exec(l)).filter((m) => m && m[1] === s.idx).at(-1);
        assert.ok(last, `ses ${s.idx} kaydı yok`);
        assert.equal(s.voice, last[2], `konuşan ses ${s.idx}: panel ${s.voice}, kayıt ${last[2]}`);
        samples.push(s);
        if (samples.length === 1) {
          await page.screenshot({ path: path.join(OUT, 'pill-playing.png') });
          await page.click('.ld-pill');
          await page.waitForSelector('.ld-panel:not([hidden])');
          await page.screenshot({ path: path.join(OUT, 'panel-playing.png') });
          await page.mouse.click(200, 200);
        }
      }
      // erkek bölümde (≈ 3.5 sn) panelden kadın favorisini değiştir
      if (!changed && s.t > 3.5) {
        changed = true;
        if (await page.locator('.ld-panel').isHidden()) await page.click('.ld-pill');
        await page.selectOption('.ld-vrow[data-kind="female"] select', 'mock-silent');
        await page.mouse.click(200, 200);
      }
      if (s.t > 20.5) break;
      await page.waitForTimeout(150);
    }
    assert.ok(samples.length >= 3, 'konuşan ses hiç görünmedi: ' + JSON.stringify(samples));
    assert.ok(subChecks >= 5, `altyazıyla çakışma yeterince denetlenmedi (${subChecks})`);
    const fem = await opt.evaluate(() => chrome.storage.local.get('favFemale'));
    assert.deepEqual(fem.favFemale, { voice: 'mock-silent', style: 'natural', pitch: 0 }, 'favori yazılmadı');
    const voice = Object.fromEntries(logs.map((l) => /ses (\d+): (\S+)/.exec(l)).filter(Boolean).map((m) => [Number(m[1]), m[2]]));
    assert.ok(logs.some((l) => /konuşan: kadın/.test(l)), 'kadın duyulmadı: ' + logs.join('\n'));
    for (const i of [4, 5, 6]) assert.equal(voice[i], 'mock-silent', `cümle ${i}: ${voice[i]}\n${logs.join('\n')}`);
    // ölçülen konuşan: ♀ ve Hz araç ipucunda
    const spk = await page.evaluate(() => ({ g: document.querySelector('.ld-speaker').dataset.gender, title: document.querySelector('.ld-speaker').title }));
    assert.equal(spk.g, 'female');
    assert.match(spk.title, /Konuşan: kadın \(\d+ Hz\)/);

    // panel: üslup ve perde favoriye yazılır
    if (await page.locator('.ld-panel').isHidden()) await page.click('.ld-pill');
    await page.click('.ld-vrow[data-kind="female"] .ld-seg-opt:has(input[value="lively"])');
    await page.waitForTimeout(300);
    assert.equal((await opt.evaluate(() => chrome.storage.local.get('favFemale'))).favFemale.style, 'lively');

    // ses ayırma sözleşmesi (henüz yoksa sahte): durum panelde görünür
    await page.evaluate(() => document.querySelector('video').pause());
    const steps = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.ld-step')].map((l) => [l.dataset.step, [l.dataset.status, l.querySelector('.ld-step-meta').textContent]])));
    assert.equal(steps.captions[0], 'done', JSON.stringify(steps));
    assert.equal(steps.mt[0], 'done');
    assert.equal(steps.sep[1], 'Kapalı');

    // layout: 1280×720
    await checkLayout(page, '1280×720');
    await page.screenshot({ path: path.join(OUT, 'panel-open-1280.png') });
    // 1920×1080
    await page.setViewportSize({ width: 1920, height: 1080 });
    await sizePlayer(page, 1920, 1080);
    await page.waitForTimeout(300);
    await checkLayout(page, '1920×1080');
    await page.screenshot({ path: path.join(OUT, 'panel-open-1920.png') });
    // küçük oynatıcı
    await page.setViewportSize({ width: 1280, height: 720 });
    await sizePlayer(page, 400, 225);
    await page.waitForTimeout(300);
    await checkLayout(page, '400×225');
    await page.screenshot({ path: path.join(OUT, 'panel-small.png'), clip: { x: 0, y: 0, width: 420, height: 240 } });
    // tam ekran
    await sizePlayer(page, 1280, 720);
    await page.evaluate(() => document.getElementById('movie_player').requestFullscreen());
    await page.waitForFunction(() => document.fullscreenElement?.id === 'movie_player', null, { timeout: 5000 });
    await page.evaluate(() => { const p = document.getElementById('movie_player'); p.style.width = '100%'; p.style.height = '100%'; p.classList.add('ytp-fullscreen'); });
    await page.waitForTimeout(400);
    if (await page.locator('.ld-panel').isHidden()) await page.click('.ld-pill');
    await checkLayout(page, 'tam ekran');
    await page.screenshot({ path: path.join(OUT, 'panel-fullscreen.png') });
    await page.evaluate(() => { document.exitFullscreen(); document.getElementById('movie_player').classList.remove('ytp-fullscreen'); });
    await sizePlayer(page, 1280, 720);

    // dublaj kapalı: hap yok, TR düğmesi duruyor; altyazı itmesi kalkar
    await page.keyboard.press('Escape');
    await opt.evaluate(() => chrome.storage.local.set({ enabled: false }));
    await page.waitForSelector('.ld-pill', { state: 'hidden', timeout: 5000 });
    assert.equal(await page.locator('#movie_player .yt-tr-dub-btn').count(), 1);
    assert.equal(await page.evaluate(() => document.getElementById('movie_player').classList.contains('ld-pill-on')), false);
    await page.screenshot({ path: path.join(OUT, 'panel-disabled.png') });
    await opt.evaluate(() => chrome.storage.local.set({ enabled: true }));
    await page.waitForSelector('.ld-pill', { state: 'visible', timeout: 5000 });
    if (await page.locator('.ld-panel').isHidden()) await page.click('.ld-pill');
    await page.waitForSelector('.ld-panel:not([hidden])');

    // ses ayırma sözleşmesi: EventTarget 'state' (test motorunda sayfadan taklit edilir)
    const sep = async (state) => {
      await page.evaluate((st) => window.postMessage({ source: 'ld-test-sep', state: st }, '*'), state);
      await page.waitForTimeout(350);
      return page.evaluate(() => {
        const l = document.querySelector('.ld-step[data-step="sep"]');
        const bar = l.querySelector('.ld-bar');
        return { status: l.dataset.status, text: l.querySelector('.ld-step-meta').textContent, bar: bar.hidden ? null : bar.firstChild.style.width };
      });
    };
    assert.deepEqual(await sep({ status: 'loading-model', backend: 'webgpu', progress: 0.42 }), { status: 'active', text: 'Model yükleniyor %42 · WebGPU', bar: '42%' });
    assert.deepEqual(await sep({ status: 'buffering', backend: 'wasm', aheadSec: 8.6 }), { status: 'active', text: 'Arabellek · WASM · 8 sn ileri', bar: '43%' });
    await page.screenshot({ path: path.join(OUT, 'panel-separation.png') });
    assert.deepEqual(await sep({ status: 'playing', backend: 'webgpu', aheadSec: 31 }), { status: 'done', text: 'Çalışıyor · WebGPU · 31 sn ileri', bar: null });
    assert.deepEqual(await sep({ status: 'error', message: 'Model yüklenemedi' }), { status: 'error', text: 'Model yüklenemedi', bar: null });
    await opt.evaluate(() => chrome.storage.local.set({ separation: 'off' }));
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => document.querySelector('.ld-step[data-step="sep"] .ld-step-meta').textContent), 'Kapalı');
    assert.equal(await page.isChecked('.ld-panel .ld-switch:has-text("Gerçek dublaj") input'), false);
    assert.deepEqual(problems, []);
    console.log(`ok — player-panel (${samples.length} örnek, son: ${samples.at(-1).name})`);
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
