#!/usr/bin/env python3
"""Okur v1.0 (ahakan/okur-tts, CC BY 4.0 / Apache-2.0) Türkçe sentezi: onnxruntime CPU, 3 grafik (text, sample, decoder).

Metin ön ucu (normalizer-tr + ondalık/çevre işaretleri) Okur deposunun Python ön ucudur (src/okur/frontend, yalnızca
`normalizer-tr` ister; torch gerekmez). Çıkarım döngüsü deponun `OnnxSynthesizer.say` yönteminin (export_web.py) ve
TypeScript çalışma zamanının (web/src/core) numpy karşılığıdır; zaman çizelgesi (timeline.py) numpy ile yeniden yazıldı.

  pip install --user --break-system-packages "normalizer-tr>=0.4,<0.5" numpy onnxruntime
  python3 synth_okur.py [--threads 4] [--limit N]
"""
import argparse
import json
import math
import re
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / ".vendor" / "okur-tts" / "src"))
from okur.frontend import Frontend, encode  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--threads", type=int, default=4)
ap.add_argument("--limit", type=int, default=0)
args = ap.parse_args()

MODEL = HERE / ".models" / "okur" / "onnx"
OUT = HERE / "out" / "okur"
OUT.mkdir(parents=True, exist_ok=True)
cfg = json.loads((MODEL / "config.json").read_text())
opts = ort.SessionOptions()
opts.intra_op_num_threads = args.threads
opts.inter_op_num_threads = 1
S = {k: ort.InferenceSession(str(MODEL / v), opts, providers=["CPUExecutionProvider"]) for k, v in cfg["files"].items()}
FE = Frontend()
RATE = cfg["sample_rate"]
STEPS, C = len(cfg["times"]), cfg["latent_dim"]


def gaussian_noise(seed, count):
    state = seed & 0xFFFFFFFF
    out = np.empty(count, dtype=np.float32)

    def uniform():
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        z = state
        z = ((z ^ (z >> 15)) * (z | 1)) & 0xFFFFFFFF
        z ^= (z + (((z ^ (z >> 7)) * (z | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((z ^ (z >> 14)) & 0xFFFFFFFF) / 4294967296.0

    for i in range(0, count, 2):
        u1, u2 = 1.0 - uniform(), uniform()
        r = math.sqrt(-2.0 * math.log(u1))
        out[i] = r * math.cos(2 * math.pi * u2)
        if i + 1 < count:
            out[i + 1] = r * math.sin(2 * math.pi * u2)
    return out


def words(letters):
    starts = [i for i, ch in enumerate(letters) if ch != " " and (i == 0 or letters[i - 1] == " ")] or [0]
    bounds = [0, *starts[1:], len(letters)]
    cw, wstart = [], []
    for w, (a, b) in enumerate(zip(bounds, bounds[1:])):
        cw += [w] * (b - a)
        wstart += [a] * (b - a)
    return np.array(cw, dtype=np.int64), np.array(wstart, dtype=np.int64), len(bounds) - 1


def timeline(letters, dur):
    cw, wstart, n_words = words(letters)
    per_word = np.zeros(n_words, dtype=np.float64)
    np.add.at(per_word, cw, dur.astype(np.float64))
    ends = np.round(np.cumsum(per_word)).astype(np.int64)
    counts = np.maximum(np.diff(ends, prepend=0), 0)
    fw = np.repeat(np.arange(n_words), counts)
    start = (np.cumsum(counts) - counts)[fw]
    fp = ((np.arange(fw.size) - start).astype(np.float64) / counts[fw].astype(np.float64)).astype(np.float32)
    return cw, wstart, fw.astype(np.int64), fp


def chunks(letters, limit=360):
    """web/src/core/chunks.ts: cümle sonlarından böl, çok kısa cümleleri öncekine yapıştır."""
    parts, start = [], 0
    for m in re.finditer(r"[.!?]+ ", letters):
        parts.append(letters[start:m.end()].strip())
        start = m.end()
    parts.append(letters[start:].strip())
    out = []
    for p in (x for x in parts if x):
        if out and len(out[-1]) + 1 + len(p) <= limit and len(out[-1]) < 40:
            out[-1] = f"{out[-1]} {p}"
        else:
            out.append(p)
    return out


def chunk_audio(letters, seed, speed=1.0):
    ids = np.array([encode(letters)], dtype=np.int64)
    h, dur = (np.asarray(x) for x in S["text"].run(None, {"ids": ids}))
    dur = dur / speed
    cw, wstart, fw, fp = timeline(letters, dur[0])
    noise = gaussian_noise(seed, STEPS * len(fw) * C).reshape(STEPS, 1, len(fw), C)
    (z,) = S["sample"].run(None, {"h": h, "dur": dur.astype(np.float32), "cw": cw[None], "wstart": wstart[None],
                                  "fw": fw[None], "fp": fp[None], "noise": noise})
    (audio,) = S["decoder"].run(None, {"z": z})
    return np.asarray(audio)[0]


def say(text):
    letters = FE(text)
    pcm, seed = [], 0
    for piece in chunks(letters):
        pcm.append(chunk_audio(piece, seed))
        pcm.append(np.zeros(int(0.2 * RATE), dtype=np.float32))
        seed += 1
    return np.concatenate(pcm[:-1]) if pcm else np.zeros(0, dtype=np.float32)


def write_wav(path, pcm):
    import wave

    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((np.clip(pcm, -1, 1) * 32767).round().astype("<i2").tobytes())


sentences = json.loads((HERE / "sentences.json").read_text(encoding="utf-8"))
if args.limit:
    sentences = sentences[: args.limit]
say("Merhaba.")  # ısınma
rows, aud, cmp_ = [], 0.0, 0.0
for s in sentences:
    t0 = time.perf_counter()
    pcm = say(s["text"])
    compute = time.perf_counter() - t0
    seconds = len(pcm) / RATE
    write_wav(OUT / f"{s['id']:02d}.wav", pcm)
    rows.append({"id": s["id"], "seconds": seconds, "compute": compute, "rtf": compute / seconds})
    aud += seconds
    cmp_ += compute
    print(f"[okur] {s['id']} {seconds:.2f} s ses, {compute:.2f} s hesap, RTF {compute / seconds:.3f}", flush=True)
stats = {"id": "okur", "model": "https://huggingface.co/ahakan/okur-tts", "license": "CC BY 4.0 (ağırlıklar) / Apache-2.0 (kod)",
         "voice": "tek ses", "threads": args.threads, "sampleRate": RATE, "totalAudio": aud, "totalCompute": cmp_,
         "rtf": cmp_ / aud, "rows": rows}
(OUT / f"stats-t{args.threads}.json").write_text(json.dumps(stats, indent=2))
print(f"== okur: {aud:.1f} s ses / {cmp_:.1f} s hesap = RTF {cmp_ / aud:.3f} (iş parçacığı {args.threads}, {RATE} Hz)")
