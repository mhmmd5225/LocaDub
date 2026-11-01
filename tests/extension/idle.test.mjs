// Boşta kaynak bırakma kararı (common/idle.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldUnload, IDLE_UNLOAD_MS, IDLE_CHECK_MS } from '../../extension/common/idle.js';

test('shouldUnload: yalnız yüklüyse, iş yokken ve süre dolunca', () => {
  const base = { now: 1_000_000, lastActive: 1_000_000 - IDLE_UNLOAD_MS, active: 0, loaded: true };
  assert.equal(shouldUnload(base), true);
  assert.equal(shouldUnload({ ...base, lastActive: base.lastActive + 1 }), false, 'süre dolmadı');
  assert.equal(shouldUnload({ ...base, active: 1 }), false, 'iş sürerken boşaltılmaz');
  assert.equal(shouldUnload({ ...base, loaded: false }), false, 'yüklü motor yok');
  assert.equal(shouldUnload({ ...base, idleMs: 500, lastActive: base.now - 600 }), true, 'özel süre');
});

test('süreler: 3 dk boşta, 30 sn denetim; canlı tutma aralığından uzun', () => {
  assert.equal(IDLE_UNLOAD_MS, 180000);
  assert.equal(IDLE_CHECK_MS, 30000);
  assert.ok(IDLE_UNLOAD_MS > 60000 * 2, 'keepalive (60 sn) iki kez kaçsa bile boşaltılmaz');
});
