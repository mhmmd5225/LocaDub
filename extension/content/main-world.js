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

  // ---- gerçek dublaj: MSE ses eklemelerinin kopyası (content/separation.js) ----
  // YouTube'un eklediği veriye dokunulmaz; ses SourceBuffer'larına başarıyla eklenen baytların kopyası tutulur (içerik
  // betiği sayfadan sonra yüklenir: abone olunca baştan gönderilir) ve abone varsa hemen iletilir (aktarılabilir
  // ArrayBuffer). Opus ≈ 16 KB/sn: kaynak başına 32 MB sınırı ≈ yarım saat.
  const SEP_CAP = 32 << 20;
  const sepMs = new Map(); // msId → { url, sbs: [rec] }
  const msOf = new WeakMap(); // MediaSource → msId
  const sbOf = new WeakMap(); // SourceBuffer → rec
  let sepSeq = 0;
  let sepSub = false;

  const sepPost = (msg, transfer) => window.postMessage({ source: FROM_MAIN, ...msg }, location.origin, transfer || []);

  function isInit(u8) {
    if (u8.length >= 4 && u8[0] === 0x1A && u8[1] === 0x45 && u8[2] === 0xDF && u8[3] === 0xA3) return true;
    if (u8.length < 8) return false;
    const t = String.fromCharCode(u8[4], u8[5], u8[6], u8[7]);
    return t === 'ftyp' || t === 'moov';
  }

  function msId(ms) {
    let id = msOf.get(ms);
    if (!id) {
      id = 'm' + (++sepSeq);
      msOf.set(ms, id);
      sepMs.set(id, { url: null, sbs: [] });
      ms.addEventListener('sourceclose', () => { sepMs.delete(id); if (sepSub) sepPost({ type: 'sep-close', msId: id }); });
      while (sepMs.size > 3) sepMs.delete(sepMs.keys().next().value);
    }
    return id;
  }

  function sepSend(rec, e, replay) {
    const m = sepMs.get(rec.msId);
    const data = e.data.slice(0);
    sepPost({ type: 'sep-append', msId: rec.msId, sbId: rec.sbId, url: m?.url || null, mime: e.mime, tso: e.tso, init: e.init, replay, data }, [data]);
  }

  function sepNote(rec, data, tso) {
    const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const e = { data: u8.slice().buffer, tso: Number(tso) || 0, init: isInit(u8), mime: rec.mime };
    rec.entries.push(e);
    rec.bytes += e.data.byteLength;
    while (rec.bytes > SEP_CAP && rec.entries.length > 1) {
      const old = rec.entries.shift();
      rec.bytes -= old.data.byteLength;
      if (old.init) rec.lastInit = old;
    }
    if (sepSub) sepSend(rec, e, false);
  }

  function sepReplay() {
    for (const [id, m] of sepMs) {
      if (m.url) sepPost({ type: 'sep-url', msId: id, url: m.url });
      for (const rec of m.sbs) {
        if (rec.lastInit && !rec.entries[0]?.init) sepSend(rec, rec.lastInit, true);
        for (const e of rec.entries) sepSend(rec, e, true);
      }
    }
  }

  const MS = window.MediaSource;
  const SBp = window.SourceBuffer && window.SourceBuffer.prototype;
  if (MS && SBp && typeof MS.prototype.addSourceBuffer === 'function') {
    const origAdd = MS.prototype.addSourceBuffer;
    MS.prototype.addSourceBuffer = function (mime) {
      const sb = origAdd.apply(this, arguments);
      try {
        if (/^audio\//i.test(String(mime))) {
          const id = msId(this);
          const rec = { msId: id, sbId: 's' + (++sepSeq), mime: String(mime), entries: [], bytes: 0, lastInit: null };
          sbOf.set(sb, rec);
          sepMs.get(id)?.sbs.push(rec);
        }
      } catch { /* yoksay */ }
      return sb;
    };
    const origAppend = SBp.appendBuffer;
    SBp.appendBuffer = function (data) {
      const r = origAppend.apply(this, arguments); // hata verirse (kota vb.) kopya alınmaz; YouTube yeniden dener
      const rec = sbOf.get(this);
      if (rec) { try { sepNote(rec, data, this.timestampOffset); } catch { /* yoksay */ } }
      return r;
    };
    const origAbort = SBp.abort;
    SBp.abort = function () {
      const rec = sbOf.get(this);
      if (rec && sepSub) sepPost({ type: 'sep-abort', msId: rec.msId, sbId: rec.sbId });
      return origAbort.apply(this, arguments);
    };
    if (typeof SBp.changeType === 'function') {
      const origChange = SBp.changeType;
      SBp.changeType = function (mime) {
        const r = origChange.apply(this, arguments);
        const rec = sbOf.get(this);
        if (rec) rec.mime = String(mime);
        return r;
      };
    }
    const origUrl = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      const url = origUrl.apply(this, arguments);
      try {
        if (obj instanceof MS) {
          const id = msId(obj);
          sepMs.get(id).url = url;
          if (sepSub) sepPost({ type: 'sep-url', msId: id, url });
        }
      } catch { /* yoksay */ }
      return url;
    };
  }

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
      } else if (type === 'sep-subscribe') {
        sepSub = true;
        sepReplay();
        reply({ result: true });
      } else if (type === 'sep-unsubscribe') {
        sepSub = false;
        reply({ result: true });
      } else if (type === 'get-ad-state') {
        const p = player();
        reply({ result: !!(p && p.classList.contains('ad-showing')) });
      }
    } catch (e) {
      reply({ error: String(e && e.message || e) });
    }
  });
})();
