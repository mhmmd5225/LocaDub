// Web uygulamasının altyazı ayrıştırıcısı (site/app/subs.js). site/app/ext/ yoksa derleme betiği çalıştırılır.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
if (!existsSync(ROOT + 'site/app/ext/content/captions.js')) {
  execFileSync('python3', [ROOT + 'tools/site/build.py'], { stdio: 'ignore' });
}
const { parseSubtitles, parseTranscript, parseTimedBlocks, detectFormat } = await import('../../site/app/subs.js');
const { parseYouTubeId } = await import('../../site/app/media.js').catch(() => ({}));

test('YouTube transkripti: zaman damgası ayrı satırda', () => {
  const text = '0:00\nHello and welcome\n0:02\nto the channel.\n0:05\n[Music]\n0:09\nToday we talk about cats.\n';
  const { sentences, format } = parseSubtitles(text);
  assert.equal(format, 'transcript');
  assert.deepEqual(sentences.map((s) => s.text), ['Hello and welcome to the channel.', 'Today we talk about cats.']);
  assert.equal(sentences[0].start, 0);
  assert.equal(sentences[1].start, 9);
});

test('YouTube transkripti: aynı satırda damga, saatli zaman ve ekran okuyucu satırları', () => {
  const cues = parseTranscript('1:02:03 First line here.\n1 hour, 2 minutes, 3 seconds\n1:02:07\n5 minutes later we left.');
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 3723000);
  assert.equal(cues[0].text, 'First line here.');
  assert.equal(cues[1].text, '5 minutes later we left.');
  assert.equal(cues[0].end, 3727000);
});

test('SRT', () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,500\n<i>Hi there.</i>\n\n2\n00:00:04,000 --> 00:00:06,000\nHow are you?\n';
  assert.equal(detectFormat(srt), 'timed');
  const { sentences } = parseSubtitles(srt);
  assert.deepEqual(sentences, [
    { start: 1, end: 3.5, text: 'Hi there.' },
    { start: 4, end: 6, text: 'How are you?' },
  ]);
});

test('YouTube otomatik VTT: kayan satır tekrarları atılır', () => {
  const vtt = [
    'WEBVTT', 'Kind: captions', 'Language: en', '',
    '00:00:00.000 --> 00:00:02.000 align:start position:0%', 'so<00:00:00.500><c> today</c>', '',
    '00:00:02.000 --> 00:00:02.010', 'so today', '',
    '00:00:02.010 --> 00:00:04.000', 'so today', 'we are going', '',
  ].join('\n');
  const cues = parseTimedBlocks(vtt);
  assert.deepEqual(cues.map((c) => c.text), ['so today', 'we are going']);
});

test('json3', () => {
  const j = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello world.' }] }] });
  const { sentences, format } = parseSubtitles(j);
  assert.equal(format, 'json3');
  assert.equal(sentences[0].text, 'Hello world.');
});

test('tanınmayan metin hata verir', () => {
  assert.throws(() => parseSubtitles('just some words'), /tanınmadı/);
});

test('YouTube bağlantısından video kimliği', { skip: !parseYouTubeId && 'media.js DOM gerektiriyor' }, () => {
  const id = 'dQw4w9WgXcQ';
  for (const u of [id, `https://www.youtube.com/watch?v=${id}&t=10`, `youtu.be/${id}`, `https://m.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`]) assert.equal(parseYouTubeId(u), id, u);
  assert.equal(parseYouTubeId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
});
