// Model files for the 'opus-mt' backend.
//
// Model: Helsinki-NLP/opus-mt-tc-big-en-tr (Marian transformer-big, CC-BY-4.0, Tatoeba-Challenge /
// OPUS-MT, University of Helsinki), ONNX conversion by onnx-community (same licence), pinned to a commit
// so that the byte offsets below stay valid.
//
// "Slim" variants skip the decoder's float32 copy of the shared 57060x1024 embedding (234 MB) with two
// HTTP Range requests and rebuild it from the uint8 copy (see onnx-patch.js). Offsets were read from the
// files at REVISION and are verified at load time.

export const REPO = 'onnx-community/opus-mt-tc-big-en-tr';
export const REVISION = 'ce128ea834a090aca240e4e113e7756e06cc78e0';
export const HF_BASE = `https://huggingface.co/${REPO}/resolve/${REVISION}/`;
export const MODEL_LICENSE = 'CC-BY-4.0 (Helsinki-NLP/opus-mt-tc-big-en-tr; ONNX: onnx-community)';

export const TOKENIZER_FILES = {
  spm: { file: 'source.spm', path: 'source.spm', size: 796953 },
  vocab: { file: 'vocab.json', path: 'vocab.json', size: 1501287 },
};

const ENCODER_INT8 = { file: 'encoder_model_int8.onnx', path: 'onnx/encoder_model_int8.onnx', size: 135730164 };

const mb = (...bytes) => Math.round(bytes.reduce((a, b) => a + b, 0) / 1e5) / 10;
const holeBytes = (f) => (f.holes ?? []).reduce((a, h) => a + h.range[1] - h.range[0], 0);

function variant(v) {
  const tok = TOKENIZER_FILES.spm.size + TOKENIZER_FILES.vocab.size;
  v.downloadMB = mb(v.encoder.size, v.decoder.size - holeBytes(v.decoder), tok);
  return v;
}

export const VARIANTS = {
  /** Original files, downloaded whole (fp32 output projection). */
  int8: variant({
    label: 'int8 (tam dosyalar)',
    encoder: ENCODER_INT8,
    decoder: { file: 'decoder_model_merged_int8.onnx', path: 'onnx/decoder_model_merged_int8.onnx', size: 395716769 },
  }),
  /** int8 decoder; output projection rebuilt from the decoder's own uint8 embedding. */
  'int8-slim': variant({
    label: 'int8, dilimli indirme',
    encoder: ENCODER_INT8,
    decoder: {
      file: 'decoder_model_merged_int8.onnx',
      path: 'onnx/decoder_model_merged_int8.onnx',
      size: 395716769,
      holes: [{
        tensor: 'model.shared.weight_merged_0',
        range: [13424084, 247141844],
        from: 'self',
        source: 'model.shared.weight_merged_0',
      }],
    },
  }),
  /** 4-bit (MatMulNBits, block 32) decoder; embedding rebuilt from the encoder's uint8 embedding. */
  'q4-slim': variant({
    label: 'q4 decoder, dilimli indirme',
    encoder: ENCODER_INT8,
    decoder: {
      file: 'decoder_model_merged_q4.onnx',
      path: 'onnx/decoder_model_merged_q4.onnx',
      size: 302166508,
      holes: [{
        tensor: 'model.shared.weight_merged_0',
        range: [8528578, 242246338],
        from: 'encoder',
        source: 'embed_tokens.weight',
      }],
    },
  }),
};

export const DEFAULT_VARIANT = 'int8-slim';
