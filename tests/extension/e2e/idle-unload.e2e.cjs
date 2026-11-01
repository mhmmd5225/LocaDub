// Boşta kaynak bırakma: son motor isteğinden sonra çeviri / seslendirme motorları boşaltılır; keepalive boşaltmayı erteler; sonraki istek
// motoru yeniden yükler. Test motorunda boşta süresi `engine.idle` ile kısaltılır (common/idle.js, offscreen.js).
//   xvfb-run -a node tests/extension/e2e/idle-unload.e2e.cjs
const assert = require('assert/strict');
const { launch } = require('./common.cjs');

(async () => {
  const { ctx, opt } = await launch({ videos: {} });
  try {
    const send = (msg) => opt.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    const ready = async () => {
      const st = (await send({ type: 'engine.status' })).result;
      return { mt: !!st.mt?.ready, tts: !!st.tts?.ready };
    };
    const until = async (fn, what, ms = 12000) => {
      const t0 = Date.now();
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error('zaman aşımı: ' + what + ' ' + JSON.stringify(await ready()));
        await opt.waitForTimeout(150);
      }
    };

    assert.equal((await send({ type: 'engine.init', engine: 'mt' })).ok, true);
    assert.equal((await send({ type: 'engine.init', engine: 'tts' })).ok, true);
    assert.deepEqual(await ready(), { mt: true, tts: true });

    // keepalive boşaltmayı erteler: 1.5 sn boşta süresi, 3.2 sn boyunca 0.4 sn'de bir canlı tutma
    assert.equal((await send({ type: 'engine.idle', ms: 1500 })).result.idleMs, 1500);
    for (let i = 0; i < 8; i++) { await send({ type: 'engine.keepalive' }); await opt.waitForTimeout(400); }
    assert.deepEqual(await ready(), { mt: true, tts: true }, 'keepalive varken boşaltıldı');

    // durunca boşaltılır (durum sorguları etkinlik sayılmaz)
    await until(async () => { const r = await ready(); return !r.mt && !r.tts; }, 'boşta boşaltma');

    // sonraki istek motoru yeniden yükler
    const tr = await send({ type: 'mt.translate', sentences: ['Hello and welcome.'] });
    assert.equal(tr.ok, true, JSON.stringify(tr));
    assert.equal(tr.result.length, 1);
    assert.equal((await ready()).mt, true, 'istekle yeniden yüklenmedi');
    console.log('ok — idle-unload');
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
