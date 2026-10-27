// Sahte YouTube: eklentiyi gerçek Chromium'da, YouTube'a gitmeden uçtan uca sınamak için.
// www.youtube.com istekleri Playwright route ile yerel içeriğe yönlendirilir:
//   /watch?v=ID  → #movie_player + <video> + ytInitialPlayerResponse (İngilizce altyazı parçası)
//   /api/timedtext → json3 (videos[ID].events)
//   /__test/video → test videosu (dosya yolu: opts.videoFile)
// Kullanım: tests/extension/e2e/*.e2e.cjs (xvfb-run -a node …); Playwright ve Chromium gerekir.

const fs = require('fs');

function watchHtml(videoId) {
  const pr = {
    videoDetails: { videoId, title: 'Test ' + videoId, lengthSeconds: '16', isLiveContent: false },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
      baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`, languageCode: 'en', kind: '', isTranslatable: true,
      name: { simpleText: 'English' },
    }] } },
  };
  return `<!doctype html><html><head><meta charset="utf-8"><title>${videoId}</title></head><body style="margin:0;background:#000">
<div id="movie_player" class="html5-video-player" style="position:relative;width:854px;height:480px">
  <video class="html5-main-video" src="/__test/video" style="width:100%;height:100%" playsinline></video>
  <div class="ytp-chrome-bottom" style="position:absolute;bottom:0;right:0"><div class="ytp-right-controls"></div></div>
</div>
<script>window.ytInitialPlayerResponse = ${JSON.stringify(pr)};</script></body></html>`;
}

/** videos: { [id]: [{ t: ms, d: ms, text }] } */
async function installFakeYouTube(ctx, { videos, videoFile, onTimedtext } = {}) {
  await ctx.route('https://www.youtube.com/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/watch') {
      return route.fulfill({ contentType: 'text/html', body: watchHtml(u.searchParams.get('v')) });
    }
    if (u.pathname === '/api/timedtext') {
      const id = u.searchParams.get('v');
      onTimedtext?.(id);
      const events = (videos[id] || []).map((c) => ({ tStartMs: c.t, dDurationMs: c.d, segs: [{ utf8: c.text }] }));
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events }) });
    }
    if (u.pathname === '/__test/video') {
      return route.fulfill({ contentType: 'video/webm', body: fs.readFileSync(videoFile) });
    }
    return route.abort();
  });
}

module.exports = { installFakeYouTube };
