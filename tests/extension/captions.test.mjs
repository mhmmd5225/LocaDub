import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickTrack, buildJson3Url, mergeTimedTextParams, parseJson3, mergeSentences, splitCue, cleanText,
} from '../../extension/content/captions.js';

const T = (languageCode, kind = '', extra = {}) => ({
  baseUrl: `https://www.youtube.com/api/timedtext?v=abc&lang=${languageCode}${kind ? '&kind=' + kind : ''}`,
  languageCode, kind, ...extra,
});

test('pickTrack: manuel İngilizce otomatikten önce gelir', () => {
  const r = pickTrack([T('en', 'asr'), T('de'), T('en-GB')]);
  assert.equal(r.kind, 'manual');
  assert.equal(r.track.languageCode, 'en-GB');
});

test('pickTrack: tam "en" tercih edilir', () => {
  const r = pickTrack([T('en-GB'), T('en'), T('en-US')]);
  assert.equal(r.track.languageCode, 'en');
});

test('pickTrack: yalnızca otomatik varsa asr', () => {
  const r = pickTrack([T('fr'), T('en', 'asr')]);
  assert.equal(r.kind, 'asr');
});

test('pickTrack: İngilizce yoksa çevrilebilir parça (tlang=en), yoksa null', () => {
  const r = pickTrack([T('fr', '', { isTranslatable: true })]);
  assert.equal(r.kind, 'translated');
  assert.equal(r.tlang, 'en');
  assert.equal(pickTrack([T('fr')]), null);
  assert.equal(pickTrack([T('fr', '', { isTranslatable: true })], { allowTranslated: false }), null);
  assert.equal(pickTrack([]), null);
  assert.equal(pickTrack(undefined), null);
  assert.equal(pickTrack([T('eng-x')])?.kind, undefined); // "eng" İngilizce sayılmaz
});

test('buildJson3Url ve mergeTimedTextParams', () => {
  const u = new URL(buildJson3Url('/api/timedtext?v=abc&lang=en&fmt=srv3'));
  assert.equal(u.searchParams.get('fmt'), 'json3');
  assert.equal(u.origin, 'https://www.youtube.com');
  const t = new URL(buildJson3Url('/api/timedtext?v=abc&lang=fr', { tlang: 'en' }));
  assert.equal(t.searchParams.get('tlang'), 'en');

  const merged = new URL(mergeTimedTextParams(
    'https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr&sig=1',
    'https://www.youtube.com/api/timedtext?v=abc&lang=de&fmt=json3&pot=TOKEN&c=WEB&cver=2.2025&tlang=fr',
  ));
  assert.equal(merged.searchParams.get('pot'), 'TOKEN');
  assert.equal(merged.searchParams.get('c'), 'WEB');
  assert.equal(merged.searchParams.get('lang'), 'en'); // parça kimliği korunur
  assert.equal(merged.searchParams.get('kind'), 'asr');
  assert.equal(merged.searchParams.get('tlang'), null);
  assert.equal(merged.searchParams.get('sig'), '1');
});

test('cleanText: ses etiketleri ve varlıklar', () => {
  assert.equal(cleanText('[Music] hello &amp; welcome ♪'), 'hello & welcome');
  assert.equal(cleanText('>> so what'), 'so what');
  assert.equal(cleanText("it&#39;s  (applause)  fine"), "it's fine");
});

// Gerçek YouTube ASR json3 yapısına benzer örnek
const ASR = {
  wireMagic: 'pb3',
  events: [
    { tStartMs: 0, dDurationMs: 9000, id: 1, wpWinPosId: 1, wsWinStyleId: 1 },
    { tStartMs: 160, dDurationMs: 4000, wWinId: 1, segs: [
      { utf8: 'so', acAsrConf: 0 }, { utf8: ' today', tOffsetMs: 240 }, { utf8: ' we', tOffsetMs: 480 },
      { utf8: ' are', tOffsetMs: 600 }, { utf8: ' going', tOffsetMs: 720 } ] },
    { tStartMs: 1500, dDurationMs: 2660, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 1510, dDurationMs: 3000, wWinId: 1, segs: [
      { utf8: 'to', acAsrConf: 0 }, { utf8: ' talk', tOffsetMs: 200 }, { utf8: ' about', tOffsetMs: 400 },
      { utf8: ' models', tOffsetMs: 700 } ] },
    // 2.21 sn → 3.6 sn: >700 ms duraklama
    { tStartMs: 3600, dDurationMs: 2000, wWinId: 1, segs: [
      { utf8: '[Music]' } ] },
    { tStartMs: 6000, dDurationMs: 2000, wWinId: 1, segs: [
      { utf8: 'first', acAsrConf: 0 }, { utf8: ' things', tOffsetMs: 300 }, { utf8: ' first', tOffsetMs: 600 } ] },
  ],
};

test('parseJson3 (ASR): kelime zamanları ve sıra', () => {
  const cues = parseJson3(ASR);
  assert.deepEqual(cues.map((c) => c.text), ['so', 'today', 'we', 'are', 'going', 'to', 'talk', 'about', 'models', 'first', 'things', 'first']);
  assert.equal(cues[1].start, 400);
  assert.equal(cues[0].end, 400); // sonraki kelimeyle sınırlandı
  assert.equal(cues[4].end, 1510); // olaylar üst üste biner: sonraki olayın başlangıcı
  for (let i = 1; i < cues.length; i++) assert.ok(cues[i].start >= cues[i - 1].start);
  assert.ok(cues.every((c) => c.end > c.start));
});

test('parseJson3: string girdi ve boş olaylar', () => {
  assert.deepEqual(parseJson3('{"events":[]}'), []);
  assert.deepEqual(parseJson3({}), []);
});

test('mergeSentences (ASR): duraklama > 700 ms cümleyi böler', () => {
  const s = mergeSentences(parseJson3(ASR));
  assert.equal(s.length, 2);
  assert.equal(s[0].text, 'so today we are going to talk about models');
  assert.equal(s[0].start, 0.16);
  assert.equal(s[1].text, 'first things first');
  assert.equal(s[1].start, 6);
  assert.ok(s[1].end <= 8.0001);
});

const MANUAL = {
  events: [
    { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Hello everyone, and welcome' }] },
    { tStartMs: 3000, dDurationMs: 2500, segs: [{ utf8: 'to the show. Today Mr. Smith\nis here.' }] },
    { tStartMs: 5500, dDurationMs: 1500, segs: [{ utf8: 'It costs 3.5 million dollars!' }] },
  ],
};

test('mergeSentences (manuel): noktalama, kısaltma ve ondalık sayılar', () => {
  const s = mergeSentences(parseJson3(MANUAL));
  assert.deepEqual(s.map((x) => x.text), [
    'Hello everyone, and welcome to the show.',
    'Today Mr. Smith is here.',
    'It costs 3.5 million dollars!',
  ]);
  assert.equal(s[0].start, 1);
  assert.ok(s[0].end > 3 && s[0].end < 5.5, 'parça içi bölme zamanı orantılı');
  assert.equal(s[1].end, 5.5);
  assert.equal(s[2].start, 5.5);
});

test('splitCue: zaman karakter oranıyla dağıtılır', () => {
  const parts = splitCue({ start: 0, end: 1000, text: 'Yes. No way!' });
  assert.equal(parts.length, 2);
  assert.equal(parts[0].text, 'Yes.');
  assert.equal(parts[0].start, 0);
  assert.equal(parts[1].end, 1000);
  assert.ok(parts[0].end > 0 && parts[0].end < 1000);
  assert.equal(splitCue({ start: 0, end: 10, text: 'one piece' }).length, 1);
});

test('mergeSentences: en fazla ~12 sn, mümkünse virgülde böl', () => {
  // Noktalamasız, duraklamasız 20 sn konuşma (her 500 ms bir kelime), 7. sn'de virgül
  const cues = [];
  for (let i = 0; i < 40; i++) {
    cues.push({ start: i * 500, end: i * 500 + 450, text: i === 13 ? 'word,' : 'word' });
  }
  const s = mergeSentences(cues);
  assert.ok(s.length >= 2);
  for (const x of s) assert.ok(x.end - x.start <= 12.0001, `uzun cümle: ${x.end - x.start}`);
  assert.ok(s[0].text.endsWith('word,'), 'ilk bölüm virgülde bitmeli');
  const words = s.reduce((n, x) => n + x.text.split(' ').length, 0);
  assert.equal(words, 40, 'kelime kaybı yok');
});

test('mergeSentences: konuşmacı değişimi (>>) yeni cümle başlatır', () => {
  const cues = parseJson3({ events: [
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'are you ready' }] },
    { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: '>> yes I am' }] },
  ] });
  const s = mergeSentences(cues);
  assert.deepEqual(s.map((x) => x.text), ['are you ready', 'yes I am']);
});

test('mergeSentences: konuşmacı bilgisi cümlelere taşınır (>> her seferinde değişir)', () => {
  const cues = parseJson3({ events: [
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'are you ready?' }] },
    { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: '>> yes I am.' }] },
    { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'Let us go.' }] },
    { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: '>> okay then.' }] },
  ] });
  const s = mergeSentences(cues);
  assert.deepEqual(s.map((x) => [x.text, x.speaker ?? 0]), [
    ['are you ready?', 0], ['yes I am.', 1], ['Let us go.', 1], ['okay then.', 0],
  ]);
  assert.ok(!('speaker' in s[0]), 'ilk konuşmacıda alan yazılmaz');
});
