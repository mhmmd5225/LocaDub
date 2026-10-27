// Sahte YouTube: eklentiyi gerçek Chromium'da, YouTube'a gitmeden uçtan uca sınamak için.
// www.youtube.com ve www.youtube-nocookie.com istekleri Playwright route ile yerel içeriğe yönlendirilir:
//   /watch?v=ID    → #movie_player (+ kontrol çubuğu) + <video> + ytInitialPlayerResponse
//   /shorts/ID     → ytd-reel-video-renderer[is-active] #shorts-player (kontrol çubuğu yok)
//   /embed/ID      → gömülü oynatıcı: #movie_player, yanıt yalnızca player.getPlayerResponse() ile
//   /api/timedtext → json3 (videos[ID]); hangi kökenden istendiği onTimedtext(id, origin) ile bildirilir
//   /__test/video  → test videosu (dosya yolu: opts.videoFile)
//   https://example.test/?v=ID → içinde youtube.com/embed/ID çerçevesi olan üçüncü taraf sayfa
// Kullanım: tests/extension/e2e/*.e2e.cjs (xvfb-run -a node …); Playwright ve Chromium gerekir.

const fs = require('fs');

function playerResponse(videoId, origin) {
  return {
    videoDetails: { videoId, title: 'Test ' + videoId, lengthSeconds: '16', isLiveContent: false },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
      baseUrl: `${origin}/api/timedtext?v=${videoId}&lang=en`, languageCode: 'en', kind: '', isTranslatable: true,
      name: { simpleText: 'English' },
    }] } },
  };
}

const VIDEO = '<video class="html5-main-video" src="/__test/video" style="width:100%;height:100%" playsinline></video>';
const CONTROLS = '<div class="ytp-chrome-bottom" style="position:absolute;bottom:0;right:0"><div class="ytp-right-controls"></div></div>';

function page(kind, videoId) {
  const pr = JSON.stringify(playerResponse(videoId, 'https://www.youtube.com'));
  let body, script;
  if (kind === 'shorts') {
    body = `<ytd-reel-video-renderer is-active><div id="shorts-player" class="html5-video-player" style="position:relative;width:360px;height:640px">${VIDEO}</div></ytd-reel-video-renderer>`;
    script = `document.getElementById('shorts-player').getPlayerResponse = () => (${pr});`;
  } else {
    body = `<div id="movie_player" class="html5-video-player" style="position:relative;width:854px;height:480px">${VIDEO}${CONTROLS}</div>`;
    script = kind === 'embed'
      ? `document.getElementById('movie_player').getPlayerResponse = () => (${pr});`
      : `window.ytInitialPlayerResponse = ${pr};`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${kind} ${videoId}</title></head>` +
    `<body style="margin:0;background:#000">${body}<script>${script}</script></body></html>`;
}

/** videos: { [id]: [{ t: ms, d: ms, text }] } */
async function installFakeYouTube(ctx, { videos, videoFile, onTimedtext } = {}) {
  const handler = async (route) => {
    const u = new URL(route.request().url());
    let m;
    if (u.pathname === '/watch') return route.fulfill({ contentType: 'text/html', body: page('watch', u.searchParams.get('v')) });
    if ((m = /^\/shorts\/([\w-]{11})/.exec(u.pathname))) return route.fulfill({ contentType: 'text/html', body: page('shorts', m[1]) });
    if ((m = /^\/embed\/([\w-]{11})/.exec(u.pathname))) return route.fulfill({ contentType: 'text/html', body: page('embed', m[1]) });
    if (u.pathname === '/api/timedtext') {
      const id = u.searchParams.get('v');
      onTimedtext?.(id, u.origin);
      const events = (videos[id] || []).map((c) => ({ tStartMs: c.t, dDurationMs: c.d, segs: [{ utf8: c.text }] }));
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events }) });
    }
    if (u.pathname === '/__test/video') return route.fulfill({ contentType: 'video/webm', body: fs.readFileSync(videoFile) });
    return route.abort();
  };
  await ctx.route('https://www.youtube.com/**', handler);
  await ctx.route('https://www.youtube-nocookie.com/**', handler);
  await ctx.route('https://example.test/**', (route) => {
    const u = new URL(route.request().url());
    const host = u.searchParams.get('host') || 'www.youtube.com';
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Blog</title><h1>Blog yazısı</h1>
<iframe src="https://${host}/embed/${u.searchParams.get('v')}" width="854" height="480" allow="autoplay"></iframe>` });
  });
}

module.exports = { installFakeYouTube };
