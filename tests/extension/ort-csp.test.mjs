import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const FILE = new URL('../../extension/lib/ort/ort-wasm-simd-threaded.jsep.mjs', import.meta.url);
const src = fs.readFileSync(FILE, 'utf8');

test('ort jsep: eval/new Function çalıştıran yol kalmadı (MV3 CSP)', () => {
  assert.ok(src.includes('/*locadub-csp*/'), 'yama uygulanmamış: python3 tools/patch-ort-csp.py');
  assert.ok(!src.includes('a=ee(l)(...m)'), 'method caller hâlâ kod derliyor');
  assert.ok(!/new Function|[^\w.$]eval\(/.test(src));
  // kalan tek dinamik Function çağrısı: globalThis yokken devreye giren yedek
  const calls = src.match(/[^\w.$]Function\(/g) || [];
  assert.equal(calls.length, 1);
  assert.match(src, /globalThis\?globalThis:Function\("return this"\)\(\)/);
});

test('yama betiği: ikinci çalıştırma "zaten yamalı", yabancı dosyada hata', () => {
  const py = (args) => spawnSync('python3', ['tools/patch-ort-csp.py', ...args], { cwd: new URL('../../', import.meta.url), encoding: 'utf8' });
  assert.match(py([]).stdout, /zaten yamalı/);
  const r = py(['/dev/null']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /beklenen metin bulunamadı/);
});

// yamanın kapanışını dosyadan çıkarıp sahte türlerle üç kipte sınar
function factory() {
  const i = src.indexOf('/*locadub-csp*/a=') + '/*locadub-csp*/a='.length;
  const j = src.indexOf('(a,b,c,d);c=`methodCaller<', i);
  const body = src.slice(i, j);
  const out = [];
  const Gd = (ret, d, rv) => { out.push(['return', ret.name, rv]); return `ret:${rv}`; };
  return { make: new Function('Gd', 'return ' + body)(Gd), out };
}
const mem = (vals) => ({ name: 'T', Db: 4, readValueFromPointer: (p) => vals[p] });

test('method caller kipleri: 0 = func.call(obj, …), 1 = new func(…), 2 = func.call(arg0, …)', () => {
  const { make } = factory();
  const types = [mem({ 0: 'x', 4: 'y' }), mem({ 0: 'x', 4: 'y' })];
  const ret = { name: 'R', Ub: false };
  // kip 0: this=obj, argümanlar x, y
  const call0 = make(2, types, 0, ret);
  const fn0 = function (...a) { return [this.tag, ...a].join('|'); };
  assert.equal(call0({ tag: 'O' }, fn0, 0, 0), 'ret:O|x|y');
  // kip 2: ilk argüman this olur
  const fn2 = function (...a) { return [this, ...a].join('|'); };
  const call2 = make(2, types, 2, ret);
  assert.equal(call2(null, fn2, 0, 0), 'ret:x|y');
  // kip 1: new
  const call1 = make(2, types, 1, ret);
  class K { constructor(a, b) { this.v = a + b; } toString() { return 'K' + this.v; } }
  assert.equal(call1(null, K, 0, 0), 'ret:Kxy');
  // dönüş türü değer döndürmeyen (Ub): undefined
  assert.equal(make(2, types, 0, { name: 'V', Ub: true })({ tag: 'O' }, fn0, 0, 0), undefined);
});
