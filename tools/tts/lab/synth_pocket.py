#!/usr/bin/env python3
"""Pocket TTS Turkish (wite-tech/pocket-tts-turkish, CC-BY-4.0, ~110M) Türkçe sentezi, Python + PyTorch CPU.
Resmi ONNX yoktur; bu yüzden 'pocket-tts-turkish' paketi (Apache-2.0) ve 'pocket-tts' (Kyutai) kullanılır.

  python3 -m venv .venv-pocket && .venv-pocket/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
  .venv-pocket/bin/pip install pocket-tts-turkish
  .venv-pocket/bin/python synth_pocket.py [--threads 4] [--voices male_1,female_1,...]
"""
import argparse
import json
import time
import wave
from pathlib import Path

import numpy as np
import torch

ap = argparse.ArgumentParser()
ap.add_argument("--threads", type=int, default=4)
ap.add_argument("--voices", default="male_1,male_2,female_1,female_2")
ap.add_argument("--limit", type=int, default=0)
args = ap.parse_args()
torch.set_num_threads(args.threads)

from pocket_tts_turkish import TurkishTTS  # noqa: E402

HERE = Path(__file__).resolve().parent
tts = TurkishTTS.from_pretrained(HERE / ".models" / "pocket", device="cpu")
RATE = tts.sample_rate
sentences = json.loads((HERE / "sentences.json").read_text(encoding="utf-8"))
if args.limit:
    sentences = sentences[: args.limit]


def write_wav(path, pcm):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((np.clip(pcm, -1, 1) * 32767).round().astype("<i2").tobytes())


for voice in args.voices.split(","):
    out = HERE / "out" / f"pocket-{voice}"
    out.mkdir(parents=True, exist_ok=True)
    tts.generate("Merhaba.", voice=voice)  # ısınma (ses durumu hazırlanır)
    rows, aud, cmp_ = [], 0.0, 0.0
    for s in sentences:
        t0 = time.perf_counter()
        pcm = np.asarray(tts.generate(s["text"], voice=voice), dtype=np.float32)
        compute = time.perf_counter() - t0
        seconds = len(pcm) / RATE
        write_wav(out / f"{s['id']:02d}.wav", pcm)
        rows.append({"id": s["id"], "seconds": seconds, "compute": compute, "rtf": compute / seconds})
        aud += seconds
        cmp_ += compute
        print(f"[pocket-{voice}] {s['id']} {seconds:.2f} s ses, {compute:.2f} s hesap, RTF {compute / seconds:.3f}", flush=True)
    stats = {"id": f"pocket-{voice}", "model": "https://huggingface.co/wite-tech/pocket-tts-turkish", "license": "CC-BY-4.0",
             "voice": voice, "threads": args.threads, "sampleRate": RATE, "totalAudio": aud, "totalCompute": cmp_,
             "rtf": cmp_ / aud, "rows": rows}
    (out / f"stats-t{args.threads}.json").write_text(json.dumps(stats, indent=2))
    print(f"== pocket-{voice}: {aud:.1f} s ses / {cmp_:.1f} s hesap = RTF {cmp_ / aud:.3f} (iş parçacığı {args.threads}, {RATE} Hz)")
