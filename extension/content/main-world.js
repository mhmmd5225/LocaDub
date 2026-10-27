// Sayfa bağlamında (world: MAIN) çalışır. İçerik betiğiyle window.postMessage köprüsü.
// - player response / captionTracks okuma
// - oynatıcının timedtext isteklerini (pot belirteci içeren) yakalama
// - gerekirse altyazı modülünü kısa süre açıp belirteçli URL ürettirme
(() => {
  'use strict';
  if (window.__ytTrDubMain) return;
  window.__ytTrDubMain = true;

  const FROM_CONTENT = 'yt-tr-dub:content';
  const FROM_MAIN = 'yt-tr-dub:main';
  const captured = new Map(); // videoId → son timedtext URL'si

  function noteUrl(url) {
    try {
      const s = String(url && url.url ? url.url : url);
      if (!s.includes('/api/timedtext')) return;
      const u = new URL(s, location.origin);
      const v = u.searchParams.get('v');
      if (!v) return;
      captured.set(v, u.toString());
      window.postMessage({ source: FROM_MAIN, type: 'timedtext-url', videoId: v, url: u.toString(), hasPot: u.searchParams.has('pot') }, location.origin);
    } catch { /* yoksay */ }
  }

  // fetch ve XHR kancaları (yalnızca URL okunur, istek değiştirilmez)
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      noteUrl(input);
      return origFetch.apply(this, arguments);
    };
  }
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    noteUrl(url);
    return origOpen.apply(this, arguments);
  };

  // common/page.js → findPlayer ile aynı kural (bu betik modül değil).
  function player() {
    if (location.pathname.startsWith('/shorts/')) {
      return document.querySelector('ytd-reel-video-renderer[is-active] #shorts-player') || document.getElementById('shorts-player');
    }
    return document.getElementById('movie_player');
  }

  function playerResponse() {
    const p = player();
    let pr = null;
    try { pr = p && typeof p.getPlayerResponse === 'function' ? p.getPlayerResponse() : null; } catch { /* yoksay */ }
    if (!pr) pr = window.ytInitialPlayerResponse || null;
    return pr;
  }

  function summarize(pr) {
    if (!pr) return null;
    const tracks = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    return {
      videoId: pr.videoDetails?.videoId || null,
      title: pr.videoDetails?.title || '',
      lengthSeconds: Number(pr.videoDetails?.lengthSeconds) || 0,
      isLive: !!pr.videoDetails?.isLiveContent && !!pr.videoDetails?.isLive,
      captionTracks: tracks.map((t) => ({
        baseUrl: t.baseUrl,
        languageCode: t.languageCode,
        kind: t.kind || '',
        isTranslatable: !!t.isTranslatable,
        isDefault: !!t.isDefault,
        name: t.name?.simpleText || (t.name?.runs || []).map((r) => r.text).join('') || '',
        vssId: t.vssId || '',
      })),
    };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Altyazıyı geçici açarak oynatıcının belirteçli isteğini tetikler.
  async function triggerCaptions(videoId, languageCode, kind) {
    const prev = captured.get(videoId);
    if (prev && prev.includes('pot=')) return prev;
    // Sayfa yeni açıldığında oynatıcı API'si henüz bağlanmamış olabilir: hazır olmasını bekle.
    let p = player();
    for (let i = 0; i < 50 && !(p && typeof p.setOption === 'function' && typeof p.getOption === 'function'); i++) {
      await sleep(200);
      p = player();
    }
    if (!p || typeof p.setOption !== 'function') return prev || null;
    let before = null;
    try { before = p.getOption('captions', 'track'); } catch { /* yoksay */ }
    const wasOn = !!(before && before.languageCode);
    const track = { languageCode };
    if (kind === 'asr') track.kind = 'asr';
    let url = null;
    // Altyazı modülü ilk denemede yüklenmemiş olabilir: birkaç kez yeniden iste.
    for (let attempt = 0; attempt < 3 && !url; attempt++) {
      try {
        p.loadModule?.('captions');
        p.setOption('captions', 'track', track);
      } catch { /* yoksay */ }
      for (let i = 0; i < 25; i++) {
        const u = captured.get(videoId);
        if (u && u !== prev) { url = u; break; }
        await sleep(100);
      }
    }
    try {
      if (wasOn) p.setOption('captions', 'track', before);
      else p.unloadModule?.('captions');
    } catch { /* yoksay */ }
    return url || captured.get(videoId) || null;
  }

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== FROM_CONTENT) return;
    const { type, reqId } = ev.data;
    const reply = (payload) => window.postMessage({ source: FROM_MAIN, type: type + ':reply', reqId, ...payload }, location.origin);
    try {
      if (type === 'get-player-response') {
        reply({ result: summarize(playerResponse()) });
      } else if (type === 'get-timedtext-url') {
        reply({ result: captured.get(ev.data.videoId) || null });
      } else if (type === 'trigger-captions') {
        reply({ result: await triggerCaptions(ev.data.videoId, ev.data.languageCode, ev.data.kind) });
      } else if (type === 'get-ad-state') {
        const p = player();
        reply({ result: !!(p && p.classList.contains('ad-showing')) });
      }
    } catch (e) {
      reply({ error: String(e && e.message || e) });
    }
  });
})();
