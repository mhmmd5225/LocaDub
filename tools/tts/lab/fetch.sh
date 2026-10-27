#!/usr/bin/env bash
# Laboratuvar modellerini HuggingFace'ten .models/ altına indirir (gitignore'da).
#   bash fetch.sh [supertonic ema okur pocket]
set -euo pipefail
cd "$(dirname "$0")"
M=.models
get() { # repo rev dosya hedef-klasör
  local repo=$1 rev=$2 f=$3 dir=$4
  mkdir -p "$M/$dir/$(dirname "$f")"
  [ -s "$M/$dir/$f" ] || curl -fL --retry 3 -sS -o "$M/$dir/$f" "https://huggingface.co/$repo/resolve/$rev/$f"
  echo "$dir/$f $(stat -c %s "$M/$dir/$f")"
}
sel=("$@")
[ ${#sel[@]} -eq 0 ] && sel=(supertonic ema okur pocket)
for s in "${sel[@]}"; do
  case $s in
  supertonic)
    for f in onnx/duration_predictor.onnx onnx/text_encoder.onnx onnx/vector_estimator.onnx onnx/vocoder.onnx onnx/tts.json onnx/unicode_indexer.json \
      voice_styles/M1.json voice_styles/M2.json voice_styles/M3.json voice_styles/M4.json voice_styles/M5.json \
      voice_styles/F1.json voice_styles/F2.json voice_styles/F3.json voice_styles/F4.json voice_styles/F5.json LICENSE; do
      get Supertone/supertonic-3 3cadd1ee6394adea1bd021217a0e650ede09a323 "$f" supertonic3
    done ;;
  ema)
    for f in meta.json text.onnx sound.onnx decoder.onnx fp16/sound.onnx LICENSE; do
      get ozcancelik/ema-lightning-onnx 13c431db0356b2f7fafb1247cd823ec0d777c820 "$f" ema
    done ;;
  okur)
    for f in onnx/config.json onnx/decoder.8f42fa31155e.onnx onnx/sample.3c2a91ee5faa.onnx onnx/text.6a21984ac693.onnx; do
      get ahakan/okur-tts 0c1ae1a9c5e7bcaa46bdff732bc7182c9ae7bd70 "$f" okur
    done ;;
  pocket)
    for f in config.yaml model.safetensors tokenizer.model voices/female_1.wav voices/female_2.wav voices/female_3.wav \
      voices/male_1.wav voices/male_2.wav voices/male_3.wav README.md; do
      get wite-tech/pocket-tts-turkish fcbd37c74dc127be846face0ff36062e9a939f7b "$f" pocket
    done ;;
  esac
done
