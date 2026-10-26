// Voice catalog of the TTS engine: pure data, importable from the offscreen document, the worker and Node.
//
// Every model URL is pinned to a commit so a cached copy never goes stale and the JS glue (which mirrors
// that exact release) keeps matching the graphs. Only model *data* is downloaded; all code is packaged.

const AHENK = 'https://huggingface.co/ozgurguler/ahenk-cep-tr/resolve/345c4cbb934815fa96ffd0d5061fd913237544bc/onnx/';
const ANTALIA = 'https://huggingface.co/spaces/cloud0day3/antalia-mini/resolve/2c24b406fedada11bd731a2ec9f4535bfd354f03/';

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
];

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
