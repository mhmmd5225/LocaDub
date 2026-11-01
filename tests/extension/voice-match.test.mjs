import test from 'node:test';
import assert from 'node:assert/strict';
import { matchVoice, VoiceAssigner, MATCH_MIN_F0, MATCH_MAX_PITCH } from '../../extension/common/voice-match.js';
import { VOICES } from '../../extension/engines/tts/voices.js';

const F = [
  { id: 'a', gender: 'female', f0: 222 },
  { id: 'b', gender: 'female', f0: 187 },
  { id: 'c', gender: 'female', f0: 166 },
];
const M = [
  { id: 'x', gender: 'male', f0: 132 },
  { id: 'y', gender: 'male', f0: 93 },
];

test('matchVoice: perdesi en yakın ses, ayarsız yeğlenir', () => {
  assert.deepEqual(matchVoice(188, F), { voice: 'b', pitch: 0, diff: 0.09 });
  assert.equal(matchVoice(225, F).voice, 'a');
  assert.equal(matchVoice(0, F), null);
  assert.equal(matchVoice(200, []), null);
});

test('matchVoice: aradaki perdeye küçük ayar, en çok ±2 yarım ton', () => {
  // 179 Hz erkek: 132 Hz'lik ses +2 (sınır), kalan fark ≈ 3.3 yarım ton
  const r = matchVoice(179, M);
  assert.equal(r.voice, 'x');
  assert.equal(r.pitch, MATCH_MAX_PITCH);
  assert.ok(Math.abs(r.diff - 3.27) < 0.05, String(r.diff));
  // 110 Hz: 93 Hz'lik ses +3 gerekir (sınırda +2) ya da 132 Hz'lik ses −3 (sınırda −2); yakın olan seçilir
  const q = matchVoice(110, M);
  assert.ok(Math.abs(q.pitch) <= MATCH_MAX_PITCH);
});

test('matchVoice: kaçınılan ses, yakın bir aday varsa atlanır', () => {
  assert.equal(matchVoice(188, F, { avoid: new Set(['b']) }).voice, 'c');
  // yakın aday yoksa yine en iyisi
  assert.equal(matchVoice(132, M, { avoid: new Set(['x']) }).voice, 'x');
});

test('VoiceAssigner: yeterli kanıtla bir kez atar, değişmez; aynı cinsiyete farklı ses', () => {
  const A = new VoiceAssigner([...F, ...M, { id: 'sys', gender: 'unknown', f0: 100 }]);
  assert.equal(A.assign({ id: 1, gender: 'female', hz: 190, nf0: MATCH_MIN_F0 - 1 }), null); // kanıt az
  const a = A.assign({ id: 1, gender: 'female', hz: 190, nf0: MATCH_MIN_F0 });
  assert.equal(a.voice, 'b');
  assert.equal(A.assign({ id: 1, gender: 'female', hz: 230, nf0: 500 }), null); // atanmış: değişmez
  assert.equal(A.get(1).voice, 'b');
  const b = A.assign({ id: 2, gender: 'female', hz: 185, nf0: 100 });
  assert.notEqual(b.voice, 'b');
  assert.equal(A.assign({ id: 3, gender: null, hz: 185, nf0: 100 }), null); // cinsiyet bilinmiyor
});

test('VoiceAssigner: bir cinsiyette ikiden az aday varsa seçim yok', () => {
  const A = new VoiceAssigner([F[0], ...M]);
  assert.equal(A.usable('female'), false);
  assert.equal(A.assign({ id: 1, gender: 'female', hz: 220, nf0: 100 }), null);
  assert.equal(A.assign({ id: 2, gender: 'male', hz: 120, nf0: 100 }).voice, 'x');
});

test('ses kataloğu: Türkçe seslerin hepsinde perde profili var, cinsiyetle uyumlu', () => {
  for (const v of VOICES) {
    assert.ok(v.f0 > 0, v.id);
    assert.ok(v.gender === 'female' ? v.f0 > 150 : v.f0 < 150, `${v.id} ${v.f0}`);
  }
});
