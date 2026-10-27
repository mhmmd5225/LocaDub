#!/usr/bin/env node
// out/<aday>/stats-t*.json ve out/utmos.json dosyalarından rapor tablosunu (markdown) basar.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { OUT } from './lib.mjs';

const utmos = existsSync(join(OUT, 'utmos.json')) ? JSON.parse(readFileSync(join(OUT, 'utmos.json'), 'utf8')) : {};
const f = (x, d = 3) => (x == null ? '–' : x.toFixed(d));
console.log('| Aday | Çıkış Hz | RTF 4 iş p. | RTF 1 iş p. | UTMOS22 ± %95 GA |\n|---|---|---|---|---|');
for (const id of readdirSync(OUT).sort()) {
  const read = (t) => { const p = join(OUT, id, `stats-t${t}.json`); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; };
  const s4 = read(4), s1 = read(1);
  if (!s4 && !s1) continue;
  const u = utmos[id];
  console.log(`| ${id} | ${(s4 || s1).sampleRate} | ${f(s4?.rtf)} | ${f(s1?.rtf)} | ${u ? `${f(u.utmos, 2)} ± ${f(u.ci95, 2)}` : '–'} |`);
}
