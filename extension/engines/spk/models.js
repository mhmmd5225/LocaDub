// Konuşmacı gömme (speaker embedding) model kataloğu: saf veri; offscreen'den, işçiden ve Node'dan içe aktarılabilir.
//
// Model bir cümlenin sesinden (16 kHz mono) sabit uzunlukta bir vektör çıkarır: aynı kişinin cümleleri birbirine
// yakın (kosinüs), farklı kişilerinki uzak düşer. Girdi Kaldi fbank (fbank.js, 80 mel, zaman ortalaması
// çıkarılmış), [1, T, 80]. ONNX dosyaları sherpa-onnx projesinin dışa aktarımları (csukuangfj/speaker-embedding-models);
// URL'ler commit'e sabitlenir, boyut ve sha256 yüklemede denetlenir. Seçim ölçümü: tools/spk-eval.mjs.

const REPO = 'csukuangfj/speaker-embedding-models';
const REV = '0743f301363dec56491a490f6d6cbc9d67f9a3bf';
const BASE = `https://huggingface.co/${REPO}/resolve/${REV}/`;

/**
 * @typedef {{ id:string, label:string, url:string, file:string, repo:string, revision:string, bytes:number,
 *   sha256:string, dim:number, window:'povey'|'hamming', scale:number, input:string, output:string,
 *   license:string, homepage:string }} SpkModel
 */

const m = (o) => ({ repo: REPO, revision: REV, url: BASE + o.file, ...o });

// CAM++ dışa aktarımları (3D-Speaker ve WeSpeaker) onnxruntime 1.22'de (eklentideki sürüm) yanlış sonuç veriyor:
// aynı girdi onnxruntime 1.29'da doğru, 1.22'de farklı konuşmacılar birbirine benziyor (EER ≈ %40–48). Katalogda yok.

/** @type {SpkModel[]} */
export const SPK_MODELS = [
  m({
    id: 'eres2net-vox',
    label: 'ERes2Net (3D-Speaker, VoxCeleb)',
    file: '3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx',
    bytes: 26485263,
    sha256: 'c59158379255ad66e161679cca6af8d52d51e389e3224ab7d7a7baae295c2db5',
    dim: 192,
    window: 'povey',
    scale: 1,
    input: 'x',
    output: 'embedding',
    license: 'Apache-2.0 (3D-Speaker, iic/speech_eres2net_sv_en_voxceleb_16k)',
    homepage: 'https://github.com/modelscope/3D-Speaker',
  }),
  // Varsayılan: WeSpeaker ResNet34-LM (VoxCeleb, 6.6 M parametre). Ölçümde (tools/spk-eval.mjs --compare) en düşük
  // EER ve ERes2Net'ten hızlı (3 sn'lik cümle tek iş parçacığında ≈ 110 ms).
  m({
    id: 'wespeaker-r34',
    label: 'ResNet34-LM (WeSpeaker, VoxCeleb)',
    file: 'wespeaker_en_voxceleb_resnet34_LM.onnx',
    bytes: 26530550,
    sha256: 'e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012',
    dim: 256,
    window: 'hamming',
    scale: 32768,
    input: 'feats',
    output: 'embs',
    license: 'CC-BY-4.0 (WeSpeaker VoxCeleb modelleri, VoxCeleb lisansı)',
    homepage: 'https://github.com/wenet-e2e/wespeaker',
  }),
];

export const DEFAULT_SPK_MODEL = 'wespeaker-r34';
export const spkModelById = (id) => SPK_MODELS.find((x) => x.id === (id || DEFAULT_SPK_MODEL)) || null;
/** Önbellekteki dosyaları bulmak/silmek için önek (model-cache deleteByPrefix). */
export const spkCachePrefix = (model) => model.url;
