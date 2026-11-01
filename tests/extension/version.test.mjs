// common/version.js: sürüm karşılaştırma.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions, updateFrom, pickLatest, checkSources, isSiteUrl, SITE_SOURCES, VERSION_URL, DOWNLOAD_URL, INSTALL_URL,
} from '../../extension/common/version.js';

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

const A = SITE_SOURCES[0].base;
const B = SITE_SOURCES[1].base;

test('kaynaklar: asıl adres ve GitHub Pages; eski sabitler asıl adresi gösterir', () => {
  assert.equal(A, 'https://localdub.mhmmd.app/');
  assert.equal(B, 'https://mhmmd5225.github.io/LocaDub/');
  assert.equal(VERSION_URL, A + 'version.json');
  assert.equal(DOWNLOAD_URL, A + 'LocaDub.zip');
  assert.equal(INSTALL_URL, A + '#kurulum');
});

test('pickLatest: en yeni sürüm kazanır, eşitte ilk kaynak; geçersizler atlanır', () => {
  const r = pickLatest([{ base: A, remote: { version: '0.2.1', bytes: 100 } }, { base: B, remote: { version: '0.5.2', bytes: 8419724 } }]);
  assert.deepEqual(r, { version: '0.5.2', bytes: 8419724, downloadUrl: B + 'LocaDub.zip', installUrl: B + '#kurulum' });
  const tie = pickLatest([{ base: A, remote: { version: '0.5.2' } }, { base: B, remote: { version: '0.5.2' } }]);
  assert.equal(tie.downloadUrl, A + 'LocaDub.zip');
  const bad = pickLatest([{ base: A, remote: { version: 'x.y' } }, { base: B, remote: null }, { base: B, remote: { version: 5 } }]);
  assert.equal(bad, null);
  assert.equal(pickLatest([]), null);
  assert.equal(pickLatest(undefined), null);
  // biri geçersizse diğeri
  assert.equal(pickLatest([{ base: A, remote: { version: 'abc' } }, { base: B, remote: { version: '0.1.0' } }]).version, '0.1.0');
});

test('checkSources: iki kaynak paralel; biri düşerse ya da zaman aşımına uğrarsa diğeriyle devam; ikisi de yoksa null', async () => {
  const urls = [];
  const ok = async (url) => {
    urls.push(url);
    if (url.startsWith(A)) return { version: '0.2.1', bytes: 8283726 }; // eskide kalmış asıl adres
    return { version: '0.5.2', bytes: 8419724 };
  };
  const r = await checkSources(ok);
  assert.equal(r.version, '0.5.2');
  assert.equal(r.downloadUrl, B + 'LocaDub.zip');
  assert.deepEqual(urls.sort(), [A + 'version.json', B + 'version.json']);
  const down = await checkSources(async (url) => { if (url.startsWith(B)) throw new Error('HTTP 503'); return { version: '0.3.0' }; });
  assert.equal(down.version, '0.3.0');
  assert.equal(down.downloadUrl, A + 'LocaDub.zip');
  assert.equal(await checkSources(async () => { throw new Error('çevrimdışı'); }), null);
});

test('isSiteUrl ve updateFrom: bağlantı yalnız bilinen site adreslerindense taşınır', () => {
  assert.equal(isSiteUrl(B + 'LocaDub.zip'), true);
  assert.equal(isSiteUrl(A + '#kurulum'), true);
  assert.equal(isSiteUrl('https://evil.example/LocaDub.zip'), false);
  assert.equal(isSiteUrl('https://mhmmd5225.github.io/baska/x.zip'), false);
  assert.equal(isSiteUrl(undefined), false);
  const u = updateFrom({ version: '0.5.2', bytes: 8419724, downloadUrl: B + 'LocaDub.zip', installUrl: B + '#kurulum' }, '0.5.1');
  assert.deepEqual(u, { version: '0.5.2', sizeMB: 8, downloadUrl: B + 'LocaDub.zip', installUrl: B + '#kurulum' });
  const unsafe = updateFrom({ version: '0.5.2', downloadUrl: 'https://evil.example/x.zip', installUrl: 'javascript:alert(1)' }, '0.5.1');
  assert.deepEqual(unsafe, { version: '0.5.2', sizeMB: null });
});
