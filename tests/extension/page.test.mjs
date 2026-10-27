// common/page.js: sayfa türü ve oynatıcı bulma.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageVideo, findPlayer } from '../../extension/common/page.js';

const loc = (href) => new URL(href);
const ID = 'dQw4w9WgXcQ';

test('pageVideo: izleme, Shorts, gömülü', () => {
  assert.deepEqual(pageVideo(loc(`https://www.youtube.com/watch?v=${ID}&t=5`)), { kind: 'watch', videoId: ID });
  assert.deepEqual(pageVideo(loc(`https://www.youtube.com/shorts/${ID}`)), { kind: 'shorts', videoId: ID });
  assert.deepEqual(pageVideo(loc(`https://www.youtube.com/shorts/${ID}?feature=share`)), { kind: 'shorts', videoId: ID });
  assert.deepEqual(pageVideo(loc(`https://www.youtube.com/embed/${ID}?autoplay=1`)), { kind: 'embed', videoId: ID });
  assert.deepEqual(pageVideo(loc(`https://www.youtube-nocookie.com/embed/${ID}`)), { kind: 'embed', videoId: ID });
});

test('pageVideo: desteklenmeyen sayfalar', () => {
  for (const href of ['https://www.youtube.com/', 'https://www.youtube.com/watch', 'https://www.youtube.com/watch?v=kısa',
    `https://www.youtube.com/shorts/${ID}x`, `https://www.youtube-nocookie.com/watch?v=${ID}`, `https://m.youtube.com/watch?v=${ID}`,
    'https://www.youtube.com/feed/subscriptions']) {
    assert.equal(pageVideo(loc(href)), null, href);
  }
});

test('findPlayer: Shorts\'ta etkin kısa video, diğerlerinde movie_player', () => {
  const doc = {
    querySelector: (sel) => (sel === 'ytd-reel-video-renderer[is-active] #shorts-player' ? 'aktif' : null),
    getElementById: (id) => id,
  };
  assert.equal(findPlayer(doc, 'shorts'), 'aktif');
  assert.equal(findPlayer({ ...doc, querySelector: () => null }, 'shorts'), 'shorts-player');
  assert.equal(findPlayer(doc, 'watch'), 'movie_player');
  assert.equal(findPlayer(doc, 'embed'), 'movie_player');
});
