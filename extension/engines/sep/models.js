// Ses ayırma (konuşma ↔ müzik+efekt) model kataloğu: saf veri; işçiden, offscreen'den ve Node'dan içe aktarılabilir.
//
// Hepsi UVR (Ultimate Vocal Remover) MDX-Net modelleri: stereo 44.1 kHz STFT spektrogramı girer
// ([B, 4, dim_f, dim_t]: L.re, L.im, R.re, R.im), hedef kaynağın spektrogramı çıkar. Parametreler UVR'nin
// model_data.json'undan (dosyanın son 10 MB'ının md5'iyle eşlenir) alınıp dosyalar açılarak doğrulandı
// (docs/SES-AYIRMA.md). URL'ler commit'e sabitlenir; boyut yüklemede denetlenir.

const UVR_REPO = 'Politrees/UVR_resources';
const UVR_REV = '929e057b81aa49bc2e6490bef8671f47b2c120f6';
const UVR_BASE = `https://huggingface.co/${UVR_REPO}/resolve/${UVR_REV}/models/MDXNet/`;
const UVR_LICENSE = 'MIT (UVR projesi; HF deposu MIT etiketli)';

/**
 * @typedef {{ id:string, label:string, arch:'mdx', url:string, file:string, repo:string, revision:string,
 *   bytes:number, sha256:string, sampleRate:number, nFft:number, hop:number, dimF:number, dimT:number,
 *   compensate:number, stem:'vocals'|'instrumental', license:string, homepage:string }} SepModel
 */

const mdx = (o) => ({
  arch: 'mdx',
  repo: UVR_REPO,
  revision: UVR_REV,
  url: UVR_BASE + o.file,
  sampleRate: 44100,
  hop: 1024,
  dimT: 256,
  license: UVR_LICENSE,
  homepage: 'https://github.com/Anjok07/ultimatevocalremovergui',
  ...o,
});

/** @type {SepModel[]} */
export const SEP_MODELS = [
  // Varsayılan: gerçek müzik (MUSDB18 eşlikleri) + konuşma ölçümünde en yüksek SDR'lardan ve en düşük konuşma
  // kalıntısı (docs/SES-AYIRMA.md).
  // Vokal modeli: eşlik = karışım − vokal·compensate.
  mdx({
    id: 'kim-vocal-2',
    label: 'Kim Vocal 2 (MDX-Net, vokal)',
    file: 'Kim_Vocal_2.onnx',
    bytes: 66759214,
    sha256: 'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b',
    nFft: 7680,
    dimF: 3072,
    compensate: 1.009,
    stem: 'vocals',
  }),
  mdx({
    id: 'voc-ft',
    label: 'UVR-MDX-NET Voc FT (vokal)',
    file: 'UVR-MDX-NET-Voc_FT.onnx',
    bytes: 66762490,
    sha256: '534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111',
    nFft: 7680,
    dimF: 3072,
    compensate: 1.021,
    stem: 'vocals',
  }),
  // Hafif seçenek (≈ 3.4× daha az işlem, 30 MB): GPU'suz makinelerde. Bant 0–14.7 kHz (dim_f 2048 / n_fft 6144).
  mdx({
    id: 'mdxnet-lite',
    label: 'UVR-MDX-NET 1 (hafif, vokal)',
    file: 'UVR_MDXNET_1_9703.onnx',
    bytes: 29704436,
    sha256: '229ad3bb96a037e89d8ed86732d6d3675856e6a07c3e3f02896eac01ec7ee4be',
    nFft: 6144,
    dimF: 2048,
    compensate: 1.03,
    stem: 'vocals',
  }),
  // Enstrümantal modeller eşliği doğrudan verir.
  mdx({
    id: 'inst-hq-3',
    label: 'UVR-MDX-NET Inst HQ 3 (enstrümantal)',
    file: 'UVR-MDX-NET-Inst_HQ_3.onnx',
    bytes: 66759214,
    sha256: '317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc',
    nFft: 6144,
    dimF: 3072,
    compensate: 1.022,
    stem: 'instrumental',
  }),
  mdx({
    id: 'inst-hq-5',
    label: 'UVR-MDX-NET Inst HQ 5 (enstrümantal)',
    file: 'UVR-MDX-NET-Inst_HQ_5.onnx',
    bytes: 59074342,
    sha256: '811cb24095d865763752310848b7ec86aeede0626cb05749ab35350e46897000',
    nFft: 5120,
    dimF: 2560,
    compensate: 1.01,
    stem: 'instrumental',
  }),
];

export const DEFAULT_SEP_MODEL = 'kim-vocal-2';
/** model 'auto' iken WebGPU yoksa (WASM): ≈ 2.6× hızlı, gerçek müzikte ≈ 1.3 dB daha düşük SDR. */
export const WASM_SEP_MODEL = 'mdxnet-lite';

export const sepModelById = (id) => SEP_MODELS.find((m) => m.id === (id || DEFAULT_SEP_MODEL)) || null;

/** Modelin bir çalıştırmada işlediği örnek sayısı (hop · (dim_t − 1)): 261 120 = 5.92 sn @ 44.1 kHz. */
export const chunkSamples = (m) => m.hop * (m.dimT - 1);
