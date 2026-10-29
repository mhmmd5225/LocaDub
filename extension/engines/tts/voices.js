// Voice catalog of the TTS engine: pure data, importable from the offscreen document, the worker and Node.
//
// Every model URL is pinned to a commit so a cached copy never goes stale and the JS glue (which mirrors
// that exact release) keeps matching the graphs. Only model *data* is downloaded; all code is packaged.

const AHENK = 'https://huggingface.co/ozgurguler/ahenk-cep-tr/resolve/345c4cbb934815fa96ffd0d5061fd913237544bc/onnx/';
const ANTALIA = 'https://huggingface.co/spaces/cloud0day3/antalia-mini/resolve/2c24b406fedada11bd731a2ec9f4535bfd354f03/';

const EMA = 'https://huggingface.co/ozcancelik/ema-lightning-onnx/resolve/13c431d/';

/** @typedef {{ name:string, url:string, bytes:number, kind:'onnx'|'json'|'bin' }} VoiceFile */

export const VOICES = [
  {
    id: 'antalia-mini',
    label: 'Antalia Mini (erkek, hızlı)',
    gender: 'male',
    license: 'Apache-2.0',
    model: 'antalia',
    sampleRate: 48000,
    homepage: 'https://huggingface.co/cloud0day3/antalia-mini',
    // "mixed" precision, the release default: fp32 acoustic graphs, vocoder from the fp16 weights
    files: [
      { name: 'manifest', url: ANTALIA + 'models/manifest.json', bytes: 2165, kind: 'json' },
      { name: 'text', url: ANTALIA + 'models/text.onnx', bytes: 4048328, kind: 'onnx' },
      { name: 'cond', url: ANTALIA + 'models/cond.onnx', bytes: 613058, kind: 'onnx' },
      { name: 'flow', url: ANTALIA + 'models/flow.onnx', bytes: 10288080, kind: 'onnx' },
      { name: 'vocoder', url: ANTALIA + 'models/vocoder.fp16.onnx', bytes: 7898746, kind: 'onnx' },
      { name: 'frontend', url: ANTALIA + 'assets/frontend-data.json.gz', bytes: 560861, kind: 'bin' },
    ],
  },
  {
    id: 'ahenk-cep',
    label: 'Ahenk Cep (kadın)',
    gender: 'female',
    license: 'CC-BY-4.0',
    model: 'ahenk',
    sampleRate: 48000,
    homepage: 'https://huggingface.co/ozgurguler/ahenk-cep-tr',
    // 8 flow steps instead of the release's 16: single-thread WASM RTF 0.41 -> 0.30; the model card reports the
    // same WER range and ~0.1 lower UTMOS at 8 steps
    steps: 8,
    attribution: 'Ahenk Cep by ozgurguler (CC BY 4.0), derived from EMA Lightning (Apache-2.0) and Alania data (CC BY 4.0)',
    files: [
      { name: 'manifest', url: AHENK + 'ahenk-cep.json', bytes: 2628, kind: 'json' },
      { name: 'text', url: AHENK + 'text.f16.onnx', bytes: 2422701, kind: 'onnx' },
      { name: 'cond', url: AHENK + 'cond.f16.onnx', bytes: 428024, kind: 'onnx' },
      { name: 'step', url: AHENK + 'step.f16.onnx', bytes: 8486846, kind: 'onnx' },
      { name: 'decoder', url: AHENK + 'decoder.f16.onnx', bytes: 6092374, kind: 'onnx' },
    ],
  },
  {
    id: 'ema-lightning',
    label: 'EMA Lightning (kadın)',
    gender: 'female',
    license: 'Apache-2.0',
    model: 'ema',
    sampleRate: 48000,
    homepage: 'https://huggingface.co/canberkkkkkk/ema-lightning',
    // fp32 graphs (the fp16 sound graph is 9.6 MB smaller but was not measured); the four flow steps are inside sound.onnx
    attribution: 'EMA Lightning by canberkkkkkk (Apache-2.0), ONNX export by ozcancelik',
    files: [
      { name: 'manifest', url: EMA + 'meta.json', bytes: 357, kind: 'json' },
      { name: 'text', url: EMA + 'text.onnx', bytes: 4806400, kind: 'onnx' },
      { name: 'sound', url: EMA + 'sound.onnx', bytes: 18120655, kind: 'onnx' },
      { name: 'decoder', url: EMA + 'decoder.onnx', bytes: 12031945, kind: 'onnx' },
    ],
  },
];

// Supertonic 3: one set of graphs, ten preset voices (style vectors). Every preset is a voice of its own in the
// catalog, all sharing the pack's files (downloaded, cached and loaded once; `pack` is the shared key).
const SUPERTONIC_FP32 = 'https://huggingface.co/Supertone/supertonic-3/resolve/3cadd1ee6394adea1bd021217a0e650ede09a323/';
/**
 * The 8-bit copy (tools/tts/quantize-supertonic.py, docs/TTS-KIYAS.md section 4): 210 MB instead of 398 MB, same
 * intelligibility and melody, ≈ 1.4× faster in the browser. Set to { repo: 'OWNER/supertonic-3-int8', rev: '<commit>' }
 * once it is published on HuggingFace; until then the official fp32 files are used.
 */
export const SUPERTONIC_INT8 = null;
const SUPERTONIC_STYLES = {
  F1: 292046, F2: 292423, F3: 290794, F4: 291808, F5: 291479,
  M1: 291748, M2: 292055, M3: 290198, M4: 291522, M5: 291469,
};

/** The pack's file list: the official fp32 release, or (source = { repo, rev }) the 8-bit copy with the same layout. */
export function supertonicFiles(source = SUPERTONIC_INT8) {
  const base = source ? `https://huggingface.co/${source.repo}/resolve/${source.rev}/` : SUPERTONIC_FP32;
  const vector = source
    ? { name: 'vector', url: base + 'onnx/vector_estimator.int8.onnx', bytes: 65361204, kind: 'onnx' }
    : { name: 'vector', url: base + 'onnx/vector_estimator.onnx', bytes: 256534781, kind: 'onnx' };
  return [
    { name: 'manifest', url: base + 'onnx/tts.json', bytes: 8253, kind: 'json' },
    { name: 'indexer', url: base + 'onnx/unicode_indexer.json', bytes: 277676, kind: 'json' },
    { name: 'duration', url: base + 'onnx/duration_predictor.onnx', bytes: 3700147, kind: 'onnx' },
    { name: 'text', url: base + 'onnx/text_encoder.onnx', bytes: 36416150, kind: 'onnx' },
    vector,
    { name: 'vocoder', url: base + 'onnx/vocoder.onnx', bytes: 101424195, kind: 'onnx' },
    ...Object.entries(SUPERTONIC_STYLES).map(([k, bytes]) => ({ name: `style:${k}`, url: `${base}voice_styles/${k}.json`, bytes, kind: 'json' })),
  ];
}

export const SUPERTONIC_PACK = {
  id: 'supertonic-3',
  label: 'Supertonic 3 (10 ses)',
  license: 'OpenRAIL-M',
  model: 'supertonic',
  sampleRate: 44100,
  homepage: SUPERTONIC_INT8 ? `https://huggingface.co/${SUPERTONIC_INT8.repo}` : 'https://huggingface.co/Supertone/supertonic-3',
  attribution: 'Supertonic 3 by Supertone Inc. (OpenRAIL-M; sample code MIT)' +
    (SUPERTONIC_INT8 ? `, 8-bit copy ${SUPERTONIC_INT8.repo}` : ''),
  experimental: true,
  // single-threaded WASM is slower than real time for this model (docs/TTS-KIYAS.md): index.js runs it on up to
  // four threads when the page is cross-origin isolated
  threads: 4,
  // the fp32 graphs, or the 8-bit copy; the denoising steps are run from JS
  files: supertonicFiles(),
  // once the 8-bit copy is used, index.js deletes the fp32 files a user downloaded before (398 MB)
  legacyPrefixes: SUPERTONIC_INT8 ? [SUPERTONIC_FP32] : [],
};
for (const preset of Object.keys(SUPERTONIC_STYLES)) {
  const female = preset[0] === 'F';
  const { files, model, license, sampleRate, homepage, attribution, experimental, threads, legacyPrefixes } = SUPERTONIC_PACK;
  VOICES.push({
    id: `supertonic-3:${preset}`,
    label: `Supertonic ${female ? 'Kadın' : 'Erkek'} ${preset[1]}`,
    gender: female ? 'female' : 'male',
    pack: SUPERTONIC_PACK.id,
    preset,
    license, model, sampleRate, homepage, attribution, experimental, threads, legacyPrefixes, files,
  });
}

export const SYSTEM_VOICE = {
  id: 'system',
  label: 'Sistem sesi (chrome.tts / speechSynthesis)',
  gender: 'unknown',
  sizeMB: 0,
  license: 'system',
  available: true,
  system: true,
};

/** The default voice: fastest on a single WASM thread with the best measured intelligibility (see README). */
export const DEFAULT_VOICE = 'antalia-mini';

export const voiceById = (id) => VOICES.find((v) => v.id === id) || null;

export const voiceBytes = (v) => v.files.reduce((n, f) => n + f.bytes, 0);

/** The key a voice's files and loaded model are shared under (the pack for Supertonic presets, else the voice). */
export const packOf = (v) => v.pack || v.id;

/** Presets of the same pack (Supertonic), for blending; [] for single-voice models. */
export const presetsOf = (packId) => VOICES.filter((v) => v.pack === packId);
