// Sayfa türü ve oynatıcı: izleme sayfası, Shorts ve gömülü oynatıcı (saf; node testleriyle sınanır).
// main-world.js (klasik betik, MAIN dünyası) aynı kuralları kendi içinde tekrarlar: playerFor().

const ID = /^[\w-]{11}$/;

/** location benzeri nesne → { kind:'watch'|'shorts'|'embed', videoId } | null */
export function pageVideo(loc) {
  const host = String(loc.hostname || '');
  const path = String(loc.pathname || '');
  if (host === 'www.youtube.com' && path === '/watch') {
    const v = new URLSearchParams(loc.search || '').get('v');
    return v && ID.test(v) ? { kind: 'watch', videoId: v } : null;
  }
  let m;
  if (host === 'www.youtube.com' && (m = /^\/shorts\/([\w-]{11})(?:[/?#]|$)/.exec(path))) return { kind: 'shorts', videoId: m[1] };
  if ((host === 'www.youtube.com' || host === 'www.youtube-nocookie.com') && (m = /^\/embed\/([\w-]{11})(?:[/?#]|$)/.exec(path))) {
    return { kind: 'embed', videoId: m[1] };
  }
  return null;
}

/** Sayfa türüne göre oynatıcı elemanı (Shorts'ta etkin kısa videonunki). */
export function findPlayer(doc, kind) {
  if (kind === 'shorts') {
    return doc.querySelector('ytd-reel-video-renderer[is-active] #shorts-player') || doc.getElementById('shorts-player');
  }
  return doc.getElementById('movie_player');
}

export function findVideo(player) {
  return player?.querySelector('video.html5-main-video') || player?.querySelector('video') || null;
}
