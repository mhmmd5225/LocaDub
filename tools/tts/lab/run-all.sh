#!/usr/bin/env bash
# Tüm adayları sırayla üretir (ölçümlerin birbirini bozmaması için paralel çalıştırılmaz).
#   bash run-all.sh [günlük-klasörü]
# Önkoşul: bash fetch.sh ; npm install (ONNXRUNTIME_NODE_INSTALL_CUDA=skip) ; pip: normalizer-tr ; venv-pocket (README).
set -uo pipefail
cd "$(dirname "$0")"
LOG=${1:-out/logs}
mkdir -p "$LOG" out
node synth-baseline.mjs --threads 4 > "$LOG/baseline4.log" 2>&1
node synth-baseline.mjs --threads 1 > "$LOG/baseline1.log" 2>&1
node synth-supertonic.mjs --threads 4 > "$LOG/supertonic4.log" 2>&1
node synth-supertonic.mjs --threads 1 --voices M1,F1 > "$LOG/supertonic1.log" 2>&1
node synth-ema.mjs --threads 4 > "$LOG/ema4.log" 2>&1
node synth-ema.mjs --threads 1 > "$LOG/ema1.log" 2>&1
python3 synth_okur.py --threads 4 > "$LOG/okur4.log" 2>&1
python3 synth_okur.py --threads 1 > "$LOG/okur1.log" 2>&1
if [ -x .venv-pocket/bin/python ]; then
  .venv-pocket/bin/python synth_pocket.py --threads 4 > "$LOG/pocket4.log" 2>&1
  .venv-pocket/bin/python synth_pocket.py --threads 1 --voices male_1,female_1 > "$LOG/pocket1.log" 2>&1
fi
