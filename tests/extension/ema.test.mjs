// EMA Lightning: katalog kaydı, kare hizalama planı, tohumlu gürültü ve ses eşleştirme.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VOICES, voiceById, voiceBytes } from '../../extension/engines/tts/voices.js';
import { gaussian, plan, words } from '../../extension/engines/tts/ema.js';
import { secondVoice, normalizeSettings } from '../../extension/common/settings.js';

test('katalog: EMA Lightning kadın, sabitlenmiş adresler, ~35 MB', () => {
  const v = voiceById('ema-lightning');
  assert.equal(v.gender, 'female');
  assert.equal(v.model, 'ema');
  assert.equal(v.license, 'Apache-2.0');
  assert.deepEqual(v.files.map((f) => f.name), ['manifest', 'text', 'sound', 'decoder']);
  for (const f of v.files) assert.match(f.url, /^https:\/\/huggingface\.co\/ozcancelik\/ema-lightning-onnx\/resolve\/13c431d\//);
  assert.ok(voiceBytes(v) > 34e6 && voiceBytes(v) < 36e6);
  assert.equal(new Set(VOICES.map((x) => x.id)).size, VOICES.length);
});

test('gaussian: aynı tohum aynı dizi, ortalama ~0, sapma ~1', () => {
  const a = gaussian(7)(4001);
  assert.deepEqual(a, gaussian(7)(4001));
  assert.notDeepEqual(a, gaussian(8)(4001));
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / a.length);
  assert.ok(Math.abs(mean) < 0.08 && Math.abs(sd - 1) < 0.08, `${mean} ${sd}`);
});

test('plan: kare sayısı süreyle orantılı, hız kare sayısını azaltır', () => {
  const text = 'merhaba dünya nasılsın';
  const { cw, wstart } = words(text);
  const dur = Float32Array.from(cw, () => 3);
  const slow = plan(cw, wstart, dur, 1);
  const fast = plan(cw, wstart, dur, 2);
  assert.equal(slow.fw.length, slow.T);
  assert.equal(slow.cg.length, cw.length);
  assert.ok(fast.T < slow.T && Math.abs(fast.T - slow.T / 2) <= 3);
  assert.equal(slow.fw[0], 0);
  assert.equal(slow.fw[slow.T - 1], 2);
});

test('ikinci konuşmacı: kadın sesin eşi erkek, erkeğin eşi kadın', () => {
  const S = (o) => normalizeSettings({ speakerVoices: true, ...o });
  assert.equal(secondVoice(S({ voice: 'ema-lightning' })), 'antalia-mini');
  assert.equal(secondVoice(S({ voice: 'ahenk-cep' })), 'antalia-mini');
  assert.equal(secondVoice(S({ voice: 'antalia-mini' })), 'ahenk-cep');
});
