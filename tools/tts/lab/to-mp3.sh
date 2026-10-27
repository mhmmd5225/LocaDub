#!/usr/bin/env bash
# Seçili adayların WAV çıktısını kör dinleme için mp3'e çevirir: 24 kHz, mono, ~64 kbps, ses düzeyi eşitlenmiş
# (ffmpeg loudnorm, tüm adaylar aynı hedefe çekilir ki yüksek ses "daha iyi" diye algılanmasın).
#   bash to-mp3.sh [aday ...]   (varsayılan: select.json içindeki adaylar)
set -euo pipefail
cd "$(dirname "$0")"
BR=${BITRATE:-64k}
cands=("$@")
[ ${#cands[@]} -eq 0 ] && mapfile -t cands < <(node -e "console.log(JSON.parse(require('fs').readFileSync('select.json','utf8')).candidates.map(c=>c.id).join('\n'))")
for c in "${cands[@]}"; do
  mkdir -p "out/mp3/$c"
  for w in out/"$c"/*.wav; do
    n=$(basename "$w" .wav)
    ffmpeg -v error -y -i "$w" -af "loudnorm=I=-20:TP=-2:LRA=7" -ar 24000 -ac 1 -b:a "$BR" "out/mp3/$c/$n.mp3"
  done
done
du -sh out/mp3
