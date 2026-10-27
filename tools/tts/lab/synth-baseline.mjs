#!/usr/bin/env node
// Taban çizgisi: eklentinin kendi motoru (extension/engines/tts/core.js, değiştirilmeden içe aktarılır) ile
// Antalia Mini ve Ahenk Cep. Ahenk stilleri için eklenti dosyası değiştirilmez: ahenk.js stili
// `manifest.styles.indexOf('neutral')` ile seçtiğinden, manifest KOPYASINDA istenen stilin adı 'neutral' ile
// değiştirilir (sentez kodu aynı kalır).
//
//   node synth-baseline.mjs [--threads 4] [--styles neutral,calm,cheerful]
import * as ort from 'onnxruntime-node';
import { join, basename } from 'node:path';
import { VOICES } from '../../../extension/engines/tts/voices.js';
import { loadVoice, synthesizeText, releaseVoice } from '../../../extension/engines/tts/core.js';
import { MODELS, THREADS, arg, readFile, runCandidate } from './lib.mjs';

const styles = arg('--styles', 'neutral,calm,cheerful').split(',');
const sessionOptions = { executionProviders: ['cpu'], intraOpNumThreads: THREADS, interOpNumThreads: 1 };

async function load(def, mutateManifest) {
  const buffers = {};
  for (const f of def.files) buffers[f.name] = await readFile(join(MODELS, 'baseline', def.id, basename(f.url)));
  if (mutateManifest) buffers.manifest = mutateManifest(JSON.parse(buffers.manifest.toString('utf8')));
  return loadVoice(ort, def, buffers, { sessionOptions });
}

for (const def of VOICES) {
  if (def.id === 'antalia-mini') {
    const v = await load(def);
    await runCandidate('antalia-mini', { model: def.homepage, license: def.license, voice: 'varsayılan (erkek)' }, async (text) => {
      const { pcm, sampleRate } = await synthesizeText(v, text, { speed: 1 });
      return { pcm, sampleRate };
    });
    await releaseVoice(v);
  } else {
    for (const style of styles) {
      const v = await load(def, (m) => {
        m.styles = m.styles.map((s) => (s === style ? 'neutral' : s === 'neutral' ? '__neutral' : s));
        return m;
      });
      await runCandidate(`ahenk-cep-${style}`, { model: def.homepage, license: def.license, voice: `kadın, stil ${style}`, steps: def.steps }, async (text) => {
        const { pcm, sampleRate } = await synthesizeText(v, text, { speed: 1 });
        return { pcm, sampleRate };
      });
      await releaseVoice(v);
    }
  }
}
