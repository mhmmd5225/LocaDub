import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodePcmBase64, decodePcmBase64ToInt16, int16ToFloat32, int16ToWav, trimSilenceInt16, float32ToInt16,
} from '../../extension/common/pcm.js';
import { normalizeSettings, DEFAULTS } from '../../extension/common/settings.js';
import * as mockMt from '../../extension/engines/_mock/mt.js';
import * as mockTts from '../../extension/engines/_mock/tts.js';

test('PCM base64 gidiş-dönüş (Int16 LE)', () => {
  const pcm = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2, NaN]);
  const back = int16ToFloat32(decodePcmBase64ToInt16(encodePcmBase64(pcm)));
  const expect = [0, 0.5, -0.5, 1, -1, 1, -1, 0];
  back.forEach((v, i) => assert.ok(Math.abs(v - expect[i]) < 1e-4, `${i}: ${v}`));
  // büyük dizi (yığın taşması olmadan)
  const big = new Float32Array(24000 * 20).map((_, i) => Math.sin(i / 10) * 0.3);
  assert.equal(decodePcmBase64ToInt16(encodePcmBase64(big)).length, big.length);
});

test('WAV başlığı', () => {
  const wav = int16ToWav(new Int16Array([1, 2, 3]), 22050);
  const dv = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE');
  assert.equal(dv.getUint32(24, true), 22050);
  assert.equal(dv.getUint32(40, true), 6);
  assert.equal(wav.length, 50);
  assert.equal(dv.getInt16(46, true), 2);
});

test('trimSilenceInt16', () => {
  const sr = 1000;
  const a = new Int16Array(1000);
  for (let i = 300; i < 600; i++) a[i] = 5000;
  const t = trimSilenceInt16(a, sr, { padMs: 10 });
  assert.equal(t.length, 300 + 20);
  assert.equal(trimSilenceInt16(new Int16Array(100), sr).length, 0);
  assert.equal(float32ToInt16(new Float32Array([1]))[0], 32767);
});

test('normalizeSettings: aralıklar ve varsayılanlar', () => {
  const s = normalizeSettings({ ttsSpeed: 5, originalVolume: -1, engineMode: 'x', bogus: 1, ttsVolume: 'a' });
  assert.equal(s.ttsSpeed, 2);
  assert.equal(s.originalVolume, 0);
  assert.equal(s.engineMode, 'real');
  assert.equal(s.ttsVolume, DEFAULTS.ttsVolume);
  assert.equal('bogus' in s, false);
  assert.deepEqual(normalizeSettings({}), { ...DEFAULTS });
});

test('Sahte mt motoru sözleşme API’sine uyar', async () => {
  assert.equal(mockMt.id, 'mt');
  const b = await mockMt.listBackends();
  assert.ok(b[0].id && b[0].label && typeof b[0].available === 'boolean');
  const prog = [];
  await mockMt.init({ onProgress: (p) => prog.push(p) });
  assert.ok(prog.length > 0 && prog.at(-1).loaded === prog.at(-1).total);
  const out = await mockMt.translateBatch(['Hello world', '', '  hi ']);
  assert.deepEqual(out, ['[TR] Hello world', '', '[TR] hi']);
  const ac = new AbortController();
  const p = mockMt.translateBatch(['x'], { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
  await mockMt.dispose();
});

test('Sahte tts motoru sözleşme API’sine uyar', async () => {
  assert.equal(mockTts.id, 'tts');
  const v = await mockTts.listVoices();
  assert.ok(v.every((x) => x.id && x.label && x.gender && 'sizeMB' in x && x.license));
  await mockTts.init({});
  const r1 = await mockTts.synthesize('Merhaba dünya, nasılsınız?', { speed: 1 });
  const r2 = await mockTts.synthesize('Merhaba dünya, nasılsınız?', { speed: 2 });
  assert.ok(r1.pcm instanceof Float32Array && r1.sampleRate > 0);
  assert.ok(r2.pcm.length < r1.pcm.length * 0.6, 'hız artınca süre kısalır');
  assert.ok(r1.pcm.some((x) => Math.abs(x) > 0.05));
  const s = await mockTts.synthesize('Sessiz', { voice: 'mock-silent' });
  assert.ok(s.pcm.every((x) => x === 0));
  await mockTts.dispose();
});
