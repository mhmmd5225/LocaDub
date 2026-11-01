#!/usr/bin/env node
// Konuşmacı/cinsiyet değerlendirmesi (tools/spk-eval.mjs) için konuşma verisi: cinsiyeti bilinen konuşmacıların
// cümleleri, 16 kHz mono WAV + manifest.json.
//
//   node tools/spk-data.mjs [--out <dizin>] [--libri <LibriSpeech kökü>] [--per 14] [--tts-only|--libri-only]
//
// İki kaynak:
//   tts    eklentinin kendi sesleri (Antalia, Ahenk, EMA, Supertonic F1–F5/M1–M5), Türkçe cümleler. Modeller:
//          node tools/tts/fetch-models.mjs (tests/tts/.models), onnxruntime-node: cd tests/tts && npm ci
//   libri  LibriSpeech dev-clean (CC-BY 4.0; 20 kadın + 20 erkek, gerçek insan sesi; cinsiyet SPEAKERS.TXT'den).
//          İndir: https://www.openslr.org/resources/12/dev-clean.tar.gz (337 MB), açıp --libri ile kökü verin
//          (içinde SPEAKERS.TXT ve dev-clean/ olan dizin). FLAC → WAV için ffmpeg gerekir.
//   train  LibriSpeech test-clean (CC-BY 4.0; 20 + 20 başka konuşmacı): yalnızca cinsiyet sınıflandırıcısının
//          eğitimi (spk-eval.mjs --train-gender), değerlendirmede kullanılmaz. test-clean.tar.gz aynı köke açılır.
// Varsayılan çıktı: tests/extension/.models/spk-eval (git dışı).

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VOICES, packOf } from '../extension/engines/tts/voices.js';
import { encodeWav, convertRate } from '../extension/engines/tts/dsp.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes('--' + k);
const OUT = resolve(opt('out', join(root, 'tests/extension/.models/spk-eval')));
const LIBRI = opt('libri', null);
const PER = Number(opt('per', 14));

// Farklı uzunlukta (≈ 1–6 sn) Türkçe cümleler: altyazı cümlelerine benzer
const TEXTS = [
  'Evet.',
  'Bunu hiç düşünmemiştim.',
  'Merhaba arkadaşlar, bugün çok ilginç bir konuyu konuşacağız.',
  'Peki sence bu işin sonu nereye varacak?',
  'Dün akşam şehir merkezinde büyük bir toplantı yapıldı ve herkes oradaydı.',
  'Kesinlikle katılıyorum.',
  'Bu verileri dikkatle incelediğimizde, ortaya çok farklı bir tablo çıkıyor.',
  'Hayır, öyle bir şey söylemedim.',
  'Yarın sabah erkenden yola çıkmamız gerekiyor, yoksa trafiğe yakalanırız.',
  'Gerçekten mi? Buna inanamıyorum!',
  'Bilim insanları yeni bir gezegen keşfettiklerini açıkladılar.',
  'Biraz daha yavaş anlatır mısın lütfen?',
  'Şirketin geliri geçen yıla göre yüzde on iki arttı.',
  'Tamam, o zaman yarın görüşürüz.',
  'Bu videoyu beğendiyseniz kanalıma abone olmayı unutmayın.',
  'İlk bakışta basit görünse de aslında oldukça karmaşık bir sistem.',
];

async function ttsData() {
  const require = createRequire(join(root, 'tests/tts/package.json'));
  let ort;
  try { ort = require('onnxruntime-node'); } catch {
    throw new Error('onnxruntime-node yok: cd tests/tts && ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci');
  }
  const { loadVoice, synthesizeText, releaseVoice } = await import('../extension/engines/tts/core.js');
  const models = join(root, 'tests/tts/.models');
  const speakers = [];
  const loaded = new Map(); // paket → ses (Supertonic ön ayarları tek model)
  for (const def of VOICES) {
    if (def.system) continue;
    let voice = loaded.get(packOf(def));
    if (!voice) {
      const buffers = {};
      try {
        for (const f of def.files) buffers[f.name] = await readFile(join(models, packOf(def), f.url.split('/').pop()));
      } catch {
        console.warn(`atlandı ${def.id}: model yok (node tools/tts/fetch-models.mjs)`);
        continue;
      }
      voice = await loadVoice(ort, def, buffers, { sessionOptions: { executionProviders: ['cpu'], intraOpNumThreads: 4 } });
      loaded.set(packOf(def), voice);
    }
    const id = 'tts-' + def.id.replace(/[^\w]+/g, '-');
    const dir = join(OUT, 'tts', id);
    await mkdir(dir, { recursive: true });
    const files = [];
    for (let i = 0; i < Math.min(PER, TEXTS.length); i++) {
      const { pcm, sampleRate } = await synthesizeText(voice, TEXTS[i], { speed: 1, preset: def.preset });
      const x = convertRate(pcm, sampleRate, 16000);
      const f = join('tts', id, `${String(i).padStart(2, '0')}.wav`);
      await writeFile(join(OUT, f), encodeWav(x, 16000));
      files.push(f);
    }
    speakers.push({ id, gender: def.gender, source: 'tts', files });
    console.log(`${id} (${def.gender}): ${files.length} cümle`);
  }
  for (const v of loaded.values()) await releaseVoice(v);
  return speakers;
}

async function libriData(subset, source) {
  const txt = await readFile(join(LIBRI, 'SPEAKERS.TXT'), 'utf8');
  const genderOf = new Map();
  for (const line of txt.split('\n')) {
    if (line.startsWith(';')) continue;
    const [id, sex, sub] = line.split('|').map((s) => s.trim());
    if (sub === subset) genderOf.set(id, sex === 'F' ? 'female' : 'male');
  }
  const speakers = [];
  for (const spk of [...genderOf.keys()].sort((a, b) => a - b)) {
    const base = join(LIBRI, subset, spk);
    const flacs = [];
    for (const ch of (await readdir(base)).sort()) {
      for (const f of (await readdir(join(base, ch))).sort()) if (f.endsWith('.flac')) flacs.push(join(base, ch, f));
    }
    // bölümlere yayılmış seçim (aynı bölümün ardışık cümleleri olmasın)
    const step = Math.max(1, Math.floor(flacs.length / PER));
    const id = `${source}-${spk}`;
    await mkdir(join(OUT, source, id), { recursive: true });
    const files = [];
    for (let i = 0; i < flacs.length && files.length < PER; i += step) {
      const f = join(source, id, `${String(files.length).padStart(2, '0')}.wav`);
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', flacs[i], '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', join(OUT, f)]);
      files.push(f);
    }
    speakers.push({ id, gender: genderOf.get(spk), source, files });
  }
  console.log(`LibriSpeech ${subset}: ${speakers.length} konuşmacı`);
  return speakers;
}

await mkdir(OUT, { recursive: true });
let old = { speakers: [] };
try { old = JSON.parse(await readFile(join(OUT, 'manifest.json'), 'utf8')); } catch { /* yeni */ }
const keep = (src) => old.speakers.filter((s) => s.source === src);
const tts = flag('libri-only') ? keep('tts') : await ttsData();
const libri = flag('tts-only') || !LIBRI ? keep('libri') : await libriData('dev-clean', 'libri');
const train = flag('tts-only') || !LIBRI ? keep('train') : await libriData('test-clean', 'train');
const speakers = [...tts, ...libri, ...train];
await writeFile(join(OUT, 'manifest.json'), JSON.stringify({ rate: 16000, speakers }, null, 1));
console.log(`manifest: ${speakers.length} konuşmacı → ${join(OUT, 'manifest.json')}`);
