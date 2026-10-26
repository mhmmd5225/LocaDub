// Downloads the opus-mt files used by tests/mt into tests/mt/.models/tc-big-en-tr/ (whole files, so the
// tests can also simulate the extension's sliced download).
//
//   node tools/mt/download-test-models.mjs [int8-slim|q4-slim|all]     (int8-slim ≈ 534 MB on disk)
//
// The extension itself downloads only ≈300 MB (see extension/engines/mt/models.js).

import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HF_BASE, TOKENIZER_FILES, VARIANTS } from '../../extension/engines/mt/models.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'tests', 'mt', '.models', 'tc-big-en-tr');
mkdirSync(out, { recursive: true });

const which = process.argv[2] ?? 'int8-slim';
const variants = which === 'all' ? Object.values(VARIANTS) : [VARIANTS[which]];
const files = new Map();
for (const f of Object.values(TOKENIZER_FILES)) files.set(f.file, f);
for (const v of variants) {
  files.set(v.encoder.file, v.encoder);
  files.set(v.decoder.file, v.decoder);
}

for (const f of files.values()) {
  const dst = join(out, f.file);
  if (existsSync(dst) && statSync(dst).size === f.size) {
    console.log(`ok    ${f.file}`);
    continue;
  }
  console.log(`get   ${f.file} (${(f.size / 1e6).toFixed(1)} MB)`);
  const res = await fetch(HF_BASE + f.path);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${f.path}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dst));
  if (statSync(dst).size !== f.size) throw new Error(`${f.file}: size mismatch`);
}
console.log(`done: ${out}`);
