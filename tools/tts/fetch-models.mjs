#!/usr/bin/env node
// Downloads the TTS voices listed in extension/engines/tts/voices.js into a local directory, for the Node tests
// (tests/tts/synth.mjs). The extension itself downloads the same URLs at runtime through model-cache.js.
//
//   node tools/tts/fetch-models.mjs [--dir <dir>] [voiceId ...]
//
// Default dir: tests/tts/.models. Files land at <dir>/<voiceId or pack>/<basename of url> (Supertonic presets share
// one pack folder). Sizes are checked against
// the catalog; existing complete files are skipped.

import { mkdir, stat, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VOICES, packOf } from '../../extension/engines/tts/voices.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let dir = resolve(here, '../../tests/tts/.models');
const di = args.indexOf('--dir');
if (di >= 0) {
  dir = resolve(args[di + 1]);
  args.splice(di, 2);
}
const matches = (v) => !args.length || args.includes(v.id) || args.includes(packOf(v));
// one entry per pack: the presets of a pack share its files
const wanted = [...new Map(VOICES.filter(matches).map((v) => [packOf(v), v])).values()];

export const localPath = (root, voice, file) => join(root, packOf(voice), file.url.split('/').pop());

for (const v of wanted) {
  for (const f of v.files) {
    const p = localPath(dir, v, f);
    const have = await stat(p).then((s) => s.size).catch(() => -1);
    if (have === f.bytes) continue;
    await mkdir(dirname(p), { recursive: true });
    process.stdout.write(`download ${f.url} ... `);
    const res = await fetch(f.url);
    if (!res.ok) throw new Error(`${f.url}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length !== f.bytes) console.warn(`\n  WARNING size ${buf.length} != catalog ${f.bytes}`);
    await writeFile(p + '.part', buf);
    await rename(p + '.part', p);
    console.log(`${(buf.length / 1e6).toFixed(2)} MB`);
  }
  console.log(`${packOf(v)}: ok (${dir})`);
}
