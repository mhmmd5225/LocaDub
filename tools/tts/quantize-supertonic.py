#!/usr/bin/env python3
"""Build the 8-bit Supertonic 3 package LocaDub downloads (docs/TTS-KIYAS.md, "8-bit paket").

The official release (Supertone/supertonic-3 @ 3cadd1ee) ships fp32 graphs only, ≈ 398 MB. Dynamic 8-bit quantization
of vector_estimator.onnx (MatMul + Conv weights, QUInt8) makes it 257 -> 65 MB and faster in onnxruntime-web; the
other files are copied unchanged so the package is self-contained (one repository, one cache prefix in the
extension). With --vocoder the vocoder is quantized too (only shipped if it passes the same listening metrics).

  python3 -m venv .venv && .venv/bin/pip install -r tools/tts/requirements-quantize.txt
  node tools/tts/fetch-models.mjs supertonic-3                        # fp32 source into tests/tts/.models/supertonic-3
  .venv/bin/python tools/tts/quantize-supertonic.py [--src DIR] [--out DIR] [--vocoder] [--repo OWNER/NAME]

Output (default tests/tts/.models/supertonic-3-int8/) mirrors the upstream layout: onnx/, voice_styles/, LICENSE,
README.md (model card), ORIGINAL_README.md, SHA256SUMS. With the pinned versions the bytes are reproducible: run it
twice and SHA256SUMS is identical.

Publishing (needs a write token in HF_TOKEN; huggingface_hub >= 1.0 `hf` CLI):

  hf auth whoami                                                       # -> OWNER
  hf repo create OWNER/supertonic-3-int8 --repo-type model
  hf upload OWNER/supertonic-3-int8 tests/tts/.models/supertonic-3-int8 . \\
      --commit-message "Supertonic 3, dynamic 8-bit vector_estimator"
  hf api ... / the web UI: note the commit id, then pin it in extension/engines/tts/voices.js (SUPERTONIC_INT8)

OpenRAIL-M (the upstream license) allows distributing derivatives if the license and its use restrictions
(Attachment A) travel with them, modified files carry a prominent notice and upstream notices are kept: LICENSE and
ORIGINAL_README.md are copied, the model card says what changed, and the quantized graphs carry the notice in their
ONNX metadata.
"""
import argparse
import hashlib
import shutil
import sys
from pathlib import Path

import onnx
import onnxruntime
from onnxruntime.quantization import QuantType, quantize_dynamic

ROOT = Path(__file__).resolve().parents[2]
SOURCE_REPO = 'Supertone/supertonic-3'
SOURCE_REV = '3cadd1ee6394adea1bd021217a0e650ede09a323'
PRESETS = [f'{g}{i}' for g in 'FM' for i in range(1, 6)]
COPIED = ['tts.json', 'unicode_indexer.json', 'duration_predictor.onnx', 'text_encoder.onnx']
NOTICE = (
    f'Modified from {SOURCE_REPO}@{SOURCE_REV[:8]} by dynamic 8-bit quantization '
    '(onnxruntime.quantization.quantize_dynamic, MatMul/Gemm/Conv weights, QUInt8). '
    'Licensed under BigScience OpenRAIL-M; the use restrictions of its Attachment A apply.'
)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def quantize(src, dst):
    tmp = dst.with_suffix('.tmp.onnx')
    quantize_dynamic(str(src), str(tmp), weight_type=QuantType.QUInt8, op_types_to_quantize=['MatMul', 'Gemm', 'Conv'])
    model = onnx.load(str(tmp))
    for key, value in (('modification_notice', NOTICE), ('source', f'https://huggingface.co/{SOURCE_REPO}/tree/{SOURCE_REV}')):
        prop = model.metadata_props.add()
        prop.key, prop.value = key, value
    onnx.save(model, str(dst))
    tmp.unlink()


def card(files, repo, vocoder):
    fmt = lambda n: f'{n / 1e6:.1f} MB' if n >= 1e5 else f'{n / 1e3:.0f} KB'
    rows = '\n'.join(f'| `{name}` | {fmt(size)} | {"8-bit (changed)" if ".int8." in name else "unchanged"} | `{digest}` |'
                     for name, size, digest in files)
    total = sum(size for _, size, _ in files) / 1e6
    quantized = 'vector_estimator and vocoder' if vocoder else 'vector_estimator'
    return f"""---
license: openrail
language:
  - tr
  - en
base_model: {SOURCE_REPO}
pipeline_tag: text-to-speech
tags:
  - onnx
  - quantized
  - supertonic
---

# Supertonic 3 — 8-bit {quantized} (ONNX)

An 8-bit copy of [{SOURCE_REPO}](https://huggingface.co/{SOURCE_REPO}/tree/{SOURCE_REV}) (commit `{SOURCE_REV[:8]}`)
for in-browser use by the [LocaDub](https://github.com/mhmmd5225/LocaDub) Chrome extension (on-device Turkish dubbing
of YouTube videos). Total {total:.0f} MB instead of 398 MB.

**This is a modified version of the Model.** The {quantized} graph{"s were" if vocoder else " was"} quantized with
`onnxruntime.quantization.quantize_dynamic` (onnxruntime {onnxruntime.__version__}, onnx {onnx.__version__}; MatMul, Gemm
and Conv weights, QUInt8, per-tensor). Every other file is the upstream file, unchanged. The quantized graphs carry
this notice in their ONNX metadata (`modification_notice`). Not affiliated with or endorsed by Supertone Inc.

Inputs, outputs, voice styles (F1–F5, M1–M5), sample rate (44.1 kHz) and usage are the same as upstream; see
`ORIGINAL_README.md` (the upstream model card, kept as required) and the official inference examples at
https://github.com/supertone-inc/supertonic. Measurements for Turkish (WER, prosody, browser speed):
https://github.com/mhmmd5225/LocaDub/blob/main/docs/TTS-KIYAS.md

## License and use restrictions

BigScience **OpenRAIL-M**, the upstream license, copied in `LICENSE`. You may not use the Model or its derivatives for
the restricted uses in Attachment A of the license, among them: violating the law, harming minors, generating false
information to harm others, impersonating people without their consent (e.g. voice deepfakes), harassment, and
disseminating generated content **without clearly disclosing that it is machine generated**. Anyone you redistribute
this model to must receive the license and be bound by these restrictions. Speech produced by this model is synthetic.

## Files

| File | Size | | SHA-256 |
|---|---|---|---|
{rows}

`SHA256SUMS` holds the same digests (`sha256sum -c SHA256SUMS`).

## Reproduce

```
python3 -m venv .venv && .venv/bin/pip install -r tools/tts/requirements-quantize.txt   # in the LocaDub repository
node tools/tts/fetch-models.mjs supertonic-3
.venv/bin/python tools/tts/quantize-supertonic.py{" --vocoder" if vocoder else ""}{f" --repo {repo}" if repo else ""}
```
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--src', type=Path, default=ROOT / 'tests/tts/.models/supertonic-3')
    ap.add_argument('--out', type=Path, default=ROOT / 'tests/tts/.models/supertonic-3-int8')
    ap.add_argument('--vocoder', action='store_true', help='quantize the vocoder too')
    ap.add_argument('--repo', default='', help='OWNER/NAME of the target repository (model card only)')
    a = ap.parse_args()

    need = COPIED + ['vector_estimator.onnx', 'vocoder.onnx', 'LICENSE', 'ORIGINAL_README.md'] + [f'{p}.json' for p in PRESETS]
    missing = [n for n in need if not (a.src / n).exists()]
    if missing:
        sys.exit(f'missing in {a.src}: {", ".join(missing)} (node tools/tts/fetch-models.mjs supertonic-3)')

    if a.out.exists():
        shutil.rmtree(a.out)
    (a.out / 'onnx').mkdir(parents=True)
    (a.out / 'voice_styles').mkdir()
    for n in COPIED:
        shutil.copyfile(a.src / n, a.out / 'onnx' / n)
    for p in PRESETS:
        shutil.copyfile(a.src / f'{p}.json', a.out / 'voice_styles' / f'{p}.json')
    shutil.copyfile(a.src / 'LICENSE', a.out / 'LICENSE')
    shutil.copyfile(a.src / 'ORIGINAL_README.md', a.out / 'ORIGINAL_README.md')
    print('quantizing vector_estimator ...', flush=True)
    quantize(a.src / 'vector_estimator.onnx', a.out / 'onnx/vector_estimator.int8.onnx')
    if a.vocoder:
        print('quantizing vocoder ...', flush=True)
        quantize(a.src / 'vocoder.onnx', a.out / 'onnx/vocoder.int8.onnx')
    else:
        shutil.copyfile(a.src / 'vocoder.onnx', a.out / 'onnx/vocoder.onnx')

    files = []
    for path in sorted(p for p in a.out.rglob('*') if p.is_file() and p.name not in ('README.md', 'SHA256SUMS')):
        files.append((path.relative_to(a.out).as_posix(), path.stat().st_size, sha256(path)))
    (a.out / 'SHA256SUMS').write_text(''.join(f'{d}  {n}\n' for n, _, d in files))
    (a.out / 'README.md').write_text(card(files, a.repo, a.vocoder))
    for n, size, d in files:
        print(f'{size:>11}  {d[:16]}  {n}')
    print(f'total {sum(s for _, s, _ in files) / 1e6:.1f} MB -> {a.out}')


if __name__ == '__main__':
    main()
