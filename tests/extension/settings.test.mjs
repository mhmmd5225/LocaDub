// common/settings.js: konuşmacıya göre ses seçimi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, secondVoice, voiceForSpeaker } from '../../extension/common/settings.js';

const S = (o) => normalizeSettings(o);

test('kapalıyken ya da ilk konuşmacıda birinci ses', () => {
  assert.equal(voiceForSpeaker(S({ voice: 'antalia-mini' }), 1), 'antalia-mini');
  assert.equal(voiceForSpeaker(S({ speakerVoices: true, voice: 'antalia-mini' }), 0), 'antalia-mini');
  assert.equal(voiceForSpeaker(S({ speakerVoices: true }), undefined), undefined);
});

test('ikinci konuşmacı: karşıt ses ya da seçilen ses', () => {
  assert.equal(voiceForSpeaker(S({ speakerVoices: true }), 1), 'ahenk-cep');
  assert.equal(voiceForSpeaker(S({ speakerVoices: true, voice: 'ahenk-cep' }), 1), 'antalia-mini');
  assert.equal(voiceForSpeaker(S({ speakerVoices: true, voice: 'antalia-mini', voice2: 'ahenk-cep' }), 1), 'ahenk-cep');
  // ikinci ses birinciyle aynı seçilmişse karşıt sese düşer
  assert.equal(secondVoice(S({ voice: 'ahenk-cep', voice2: 'ahenk-cep' })), 'antalia-mini');
});

test('sistem sesinde ve test motorunda (ikinci ses seçilmemişse) ayrım yok', () => {
  assert.equal(voiceForSpeaker(S({ speakerVoices: true, voice: 'system' }), 1), 'system');
  assert.equal(voiceForSpeaker(S({ speakerVoices: true, engineMode: 'mock', voice: 'mock-beep' }), 1), 'mock-beep');
  assert.equal(voiceForSpeaker(S({ speakerVoices: true, engineMode: 'mock', voice: 'mock-beep', voice2: 'mock-silent' }), 1), 'mock-silent');
});

test('fixAsrPunct varsayılan kapalı, değer normalleştirilir', () => {
  assert.equal(S({}).fixAsrPunct, false);
  assert.equal(S({ fixAsrPunct: 1 }).fixAsrPunct, true);
  assert.equal(S({ fixAsrPunct: '' }).fixAsrPunct, false);
});

test('dublaj varsayılan olarak kapalı (her açılışta kapalı davranışının dayanağı)', () => {
  assert.equal(S({}).enabled, false);
});

test('üslup, perde, kalite: varsayılanlar ve geçersiz değerler', () => {
  const d = S({});
  assert.equal(d.style, 'natural');
  assert.equal(d.pitch, 0);
  assert.equal(d.quality, 'fast');
  assert.deepEqual([S({ style: 'lively' }).style, S({ style: 'calm' }).style], ['lively', 'calm']);
  assert.equal(S({ style: 'robot' }).style, 'natural');
  assert.equal(S({ style: 5 }).style, 'natural');
  assert.equal(S({ quality: 'high' }).quality, 'high');
  assert.equal(S({ quality: 'ultra' }).quality, 'fast');
  assert.equal(S({ pitch: 1.5 }).pitch, 1.5);
  assert.equal(S({ pitch: '2' }).pitch, 2);
  assert.equal(S({ pitch: 9 }).pitch, 3);
  assert.equal(S({ pitch: -9 }).pitch, -3);
  assert.equal(S({ pitch: 0.7 }).pitch, 0.5); // 0.5 adıma yuvarlanır
  assert.equal(S({ pitch: 'abc' }).pitch, 0);
  assert.equal(S({ pitch: null }).pitch, 0);
  assert.equal(S({ pitch: NaN }).pitch, 0);
  assert.ok(Object.is(S({ pitch: -0.1 }).pitch, 0), '-0 olmamalı');
});
