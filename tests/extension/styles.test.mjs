// engines/tts/styles.js: üslup tablosu, perde toplamı ve sınırı, bilinmeyen değerler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STYLES, STYLE_IDS, HIGH_STEPS, TOTAL_PITCH_LIMIT, normalizeTone, resolveTone, totalPitch, styleSpeed, pitchRatio,
  toneFromSettings,
} from '../../extension/engines/tts/styles.js';

const AHENK = ['neutral', 'angry', 'calm', 'cheerful', 'empathetic', 'sad', 'surprised', 'laughter'];

test('tablo: üç üslup, başlangıç değerleri; kahkaha sunulmaz', () => {
  assert.deepEqual(STYLE_IDS, ['natural', 'lively', 'calm']);
  assert.deepEqual(
    Object.fromEntries(STYLE_IDS.map((k) => [k, [STYLES[k].ahenk, STYLES[k].temperature, STYLES[k].speed, STYLES[k].pitch]])),
    { natural: ['neutral', 0.6, 1, 0], lively: ['cheerful', 0.8, 1.05, 1], calm: ['calm', 0.4, 0.95, -1] },
  );
  assert.ok(!Object.values(STYLES).some((s) => s.ahenk === 'laughter'));
});

test('bilinmeyen üslup doğala düşer', () => {
  assert.equal(normalizeTone({ style: 'robot' }).style, 'natural');
  assert.deepEqual(normalizeTone(undefined), { style: 'natural', pitch: 0, quality: 'fast' });
  assert.deepEqual(normalizeTone(null), { style: 'natural', pitch: 0, quality: 'fast' });
  assert.equal(styleSpeed('???'), 1);
  assert.equal(totalPitch('???', 1), 1);
});

test('perde: üslubun perdesi + kullanıcınınki, ±4 ile sınırlı', () => {
  assert.equal(totalPitch('natural', 0), 0);
  assert.equal(totalPitch('lively', 0), 1);
  assert.equal(totalPitch('lively', 1.5), 2.5);
  assert.equal(totalPitch('calm', 0), -1);
  assert.equal(totalPitch('calm', -3), -4);
  assert.equal(totalPitch('lively', 3), TOTAL_PITCH_LIMIT);
  assert.equal(totalPitch('calm', -99), -TOTAL_PITCH_LIMIT);
  assert.equal(totalPitch('lively', 99), TOTAL_PITCH_LIMIT);
  assert.equal(totalPitch('calm', 3), 2);
  assert.ok(Math.abs(pitchRatio(12) - 2) < 1e-12);
  assert.equal(pitchRatio(0), 1);
});

test('resolveTone: Ahenk stili, Antalia sıcaklığı, kalite adımı', () => {
  const nat = resolveTone({}, AHENK);
  assert.deepEqual([nat.ahenkStyle, nat.temperature, nat.semitones, nat.steps], ['neutral', 0.6, 0, null]);
  const liv = resolveTone({ style: 'lively', pitch: 1, quality: 'high' }, AHENK);
  assert.deepEqual([liv.ahenkStyle, liv.temperature, liv.semitones, liv.steps], ['cheerful', 0.8, 2, HIGH_STEPS]);
  assert.equal(resolveTone({ style: 'calm' }, AHENK).ahenkStyle, 'calm');
  // stil adı manifestte yoksa (ya da Antalia: stil listesi boş) neutral
  assert.equal(resolveTone({ style: 'lively' }, ['neutral', 'calm']).ahenkStyle, 'neutral');
  assert.equal(resolveTone({ style: 'lively' }, []).ahenkStyle, 'neutral');
  assert.equal(resolveTone({ style: 'lively' }).ahenkStyle, 'neutral');
  // geçersiz kalite → hızlı
  assert.equal(resolveTone({ quality: 'x' }, AHENK).steps, null);
});

test('toneFromSettings', () => {
  assert.deepEqual(toneFromSettings({ style: 'calm', pitch: 2, quality: 'high', voice: 'x' }), { style: 'calm', pitch: 2, quality: 'high' });
  assert.deepEqual(toneFromSettings({}), { style: 'natural', pitch: 0, quality: 'fast' });
});
