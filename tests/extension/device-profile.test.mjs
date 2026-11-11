// common/device-profile.js: algılama, profil tablosu, ayar normalizasyonu, rapor satırı.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE_IDS, PROFILES, normalizeDeviceProfile, detectProfile, resolveProfile, profileDefaults } from '../../extension/common/device-profile.js';
import { normalizeSettings, DEFAULTS } from '../../extension/common/settings.js';
import { buildReport, profileLine } from '../../extension/common/diagnostics.js';

test('detectProfile tablosu', () => {
  const cases = [
    ['nvidia ada lovelace', 'rtx'], ['amd radeon rx 7800', 'rtx'], ['intel arc a770', 'rtx'],
    ['apple metal-3 m4', 'apple'], ['intel gen-12lp', 'igpu'], ['intel xe', 'igpu'],
    [null, 'cpu'], ['', 'cpu'], ['bilinmiyor', 'igpu'], ['qualcomm adreno', 'igpu'],
  ];
  for (const [adapter, want] of cases) assert.equal(detectProfile({ adapter }), want, String(adapter));
  assert.equal(detectProfile({}), 'cpu');
});

test('normalizeDeviceProfile', () => {
  for (const id of PROFILE_IDS) assert.equal(normalizeDeviceProfile(id), id);
  for (const v of ['auto', 'x', null, undefined, 3]) assert.equal(normalizeDeviceProfile(v), 'auto');
});

test('tablo: bugünkü varsayılanlar; toplu boyut / hız sınırı alanı yok', () => {
  assert.deepEqual(profileDefaults('rtx'), { sepQuality: DEFAULTS.sepQuality, prebufferSec: DEFAULTS.prebufferSec, lookaheadSec: DEFAULTS.lookaheadSec });
  assert.deepEqual(profileDefaults('apple'), profileDefaults('rtx'));
  assert.deepEqual(profileDefaults('igpu'), { sepQuality: 'fast', prebufferSec: 30, lookaheadSec: 45 });
  assert.deepEqual(profileDefaults('cpu'), { sepQuality: 'fast', prebufferSec: 45, lookaheadSec: 60 });
  for (const p of Object.values(PROFILES)) {
    assert.ok(p.label && p.hint);
    assert.equal('batch' in p || 'batchSize' in p || 'rateLimit' in p, false);
  }
});

test('resolveProfile: otomatik ve elle', () => {
  const a = resolveProfile('auto', { adapter: 'nvidia ada' });
  assert.equal(a.id, 'rtx'); assert.equal(a.auto, true); assert.equal(a.label, PROFILES.rtx.label);
  const m = resolveProfile('cpu', { adapter: 'nvidia ada' });
  assert.equal(m.id, 'cpu'); assert.equal(m.auto, false); assert.equal(m.prebufferSec, 45);
  assert.equal(resolveProfile('geçersiz', { adapter: null }).id, 'cpu');
});

test('ayarlar: deviceProfile varsayılanı otomatik; profil diğer ayarları ezmez', () => {
  assert.equal(DEFAULTS.deviceProfile, 'auto');
  assert.equal(normalizeSettings({ deviceProfile: 'zzz' }).deviceProfile, 'auto');
  const s = normalizeSettings({ deviceProfile: 'cpu', sepQuality: 'high', prebufferSec: 20 });
  assert.equal(s.deviceProfile, 'cpu'); assert.equal(s.sepQuality, 'high'); assert.equal(s.prebufferSec, 20);
});

test('rapor satırı', () => {
  assert.equal(profileLine({ id: 'rtx', auto: true, adapter: 'nvidia ada' }), 'profil: rtx (otomatik) · kart: nvidia ada');
  assert.equal(profileLine({ id: 'cpu', auto: false, adapter: null }), 'profil: cpu (elle) · kart: yok');
  const r = buildReport({ version: '1', browser: 'c', platform: 'p', profile: { id: 'apple', auto: true, adapter: 'apple m4' }, settings: { deviceProfile: 'auto' } });
  assert.match(r, /deviceProfile: "auto"/);
  assert.match(r, /\[Motorlar\]\ndurum okunamadı\nprofil: apple \(otomatik\) · kart: apple m4\n\n\[Ses ayırma\]/);
});
