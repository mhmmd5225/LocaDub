#!/usr/bin/env python3
"""Intelligibility of compare.mjs output: Whisper transcribes every WAV marked `wer` in results.json, the transcript
is compared with the input text (Turkish lowercase, punctuation and circumflexes removed) and per-file word/char
edit counts are written to wer.json next to it.

  python3 -m venv .venv && .venv/bin/pip install faster-whisper
  .venv/bin/python wer.py out/compare/base [--model large-v3-turbo]

Audio is decoded with the standard library (faster-whisper's PyAV decoder is not needed) and resampled to 16 kHz.
"""
import json
import re
import sys
import wave
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel


def load(path):
    with wave.open(str(path)) as w:
        sr = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    n = int(len(x) * 16000 / sr)
    return np.interp(np.arange(n) * sr / 16000, np.arange(len(x)), x).astype(np.float32)


def norm(s):
    s = s.replace('I', 'ı').replace('İ', 'i').lower()
    s = s.translate(str.maketrans('âîû', 'aiu')).replace('hoşça kal', 'hoşçakal')
    s = re.sub(r"[^\w\s]", ' ', s)
    return ' '.join(s.split())


def edits(a, b):
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def main():
    d = Path(sys.argv[1])
    model = sys.argv[sys.argv.index('--model') + 1] if '--model' in sys.argv else 'large-v3-turbo'
    rows = json.loads((d / 'results.json').read_text())['rows']
    m = WhisperModel(model, device='cpu', compute_type='int8')
    out = {}
    for r in rows:
        if not r.get('wer'):
            continue
        segs, _ = m.transcribe(load(d / r['file']), language='tr', beam_size=5, condition_on_previous_text=False)
        hyp = ' '.join(s.text for s in segs).strip()
        ref_n, hyp_n = norm(r['text']), norm(hyp)
        out[r['file']] = {
            'hyp': hyp,
            'words': len(ref_n.split()),
            'wordErrors': edits(ref_n.split(), hyp_n.split()),
            'chars': len(ref_n),
            'charErrors': edits(ref_n, hyp_n),
        }
        print(r['file'], out[r['file']]['wordErrors'], hyp, flush=True)
    (d / 'wer.json').write_text(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
