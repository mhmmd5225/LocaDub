// common/version.js: sürüm karşılaştırma.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, updateFrom } from '../../extension/common/version.js';

test('compareVersions', () => {
  assert.equal(compareVersions('0.2.0', '0.1.0'), 1);
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
  assert.equal(compareVersions('abc', '0.1.0'), 0);
  assert.equal(compareVersions('', '0.1.0'), 0);
});

test('updateFrom: yalnızca daha yeni sürüm', () => {
  assert.deepEqual(updateFrom({ version: '0.2.0', bytes: 8262988 }, '0.1.0'), { version: '0.2.0', sizeMB: 7.9 });
  assert.equal(updateFrom({ version: '0.1.0' }, '0.1.0'), null);
  assert.equal(updateFrom({ version: '0.0.9' }, '0.1.0'), null);
  assert.equal(updateFrom(null, '0.1.0'), null);
  assert.equal(updateFrom({ version: 5 }, '0.1.0'), null);
});
