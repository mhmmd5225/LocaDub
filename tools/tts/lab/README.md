# Ses laboratuvarı

Türkçe cihaz-içi TTS adaylarını aynı 20 cümleyle sentezleyen, hızını (RTF) ve UTMOS22 puanını ölçen ve kör dinleme
sayfası üreten araçlar. Eklentiden (`extension/`) bağımsızdır; yalnızca eklentinin motorunu ve normalleştiricisini
salt-okunur içe aktarır. Sonuçlar ve yorum: [`docs/SES-KIYAS.md`](../../../docs/SES-KIYAS.md).

Üretilen her şey (`out/`, `.models/`, `.vendor/`, `node_modules/`, `.venv-pocket/`) `.gitignore`'dadır; ses dosyası depoya girmez.

## Yeniden üretme

```bash
cd tools/tts/lab

# 1) Modeller (HuggingFace, sabit sürümlerle) ve taban çizgisi sesleri
bash fetch.sh                                   # supertonic ema okur pocket  (~900 MB)
node ../fetch-models.mjs --dir .models/baseline # Antalia Mini + Ahenk Cep
git clone --depth 1 https://github.com/ahmethakanbesel/okur-tts .vendor/okur-tts   # Okur metin ön ucu + utmos_score.py

# 2) Bağımlılıklar
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install
pip install --user --break-system-packages "normalizer-tr>=0.4,<0.5" numpy onnxruntime     # Okur ön ucu
python3 -m venv .venv-pocket
.venv-pocket/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
.venv-pocket/bin/pip install pocket-tts-turkish                                              # Pocket TTS Turkish

# 3) Sentez + RTF (adaylar sırayla; paralel çalıştırmayın, RTF bozulur)
bash run-all.sh
#   tek tek: node synth-baseline.mjs --threads 4 | node synth-supertonic.mjs | node synth-ema.mjs
#            python3 synth_okur.py | .venv-pocket/bin/python synth_pocket.py     (hepsi --threads N, --limit N alır)

# 4) UTMOS22 (Python 3.10 ayrı ortam; Okur deposunun denetimli yükleyicisi)
uv venv --python 3.10 /tmp/venv-utmos
uv pip install --python /tmp/venv-utmos/bin/python torch torchaudio --index-url https://download.pytorch.org/whl/cpu
uv pip install --python /tmp/venv-utmos/bin/python "numpy<2" soundfile utmos
/tmp/venv-utmos/bin/python -I .vendor/okur-tts/scripts/utmos_score.py out     # out/utmos.json

# 5) Kör dinleme sayfası
bash to-mp3.sh                                  # select.json'daki adaylar, 24 kHz mono 64 kbps, ses düzeyi eşitli
node build-listen.mjs                           # out/dinleme.html (tek dosya)
node report-table.mjs                           # rapor tablosu
```

## Dosyalar

| Dosya | Görev |
|---|---|
| `sentences.json` | 20 test cümlesi (kısa, uzun, soru, sayı, İngilizce özel ad, haber, sohbet...) |
| `lib.mjs` | ortak döngü: ısınma, cümle başına süre, RTF, WAV yazımı |
| `synth-baseline.mjs` | Antalia Mini, Ahenk Cep (stil: manifest KOPYASINDA `neutral` yeniden adlandırılır, eklenti kodu değişmez) |
| `synth-supertonic.mjs` | Supertonic 3, 10 ses (M1-M5, F1-F5), Float32Array ile yeniden yazılmış çıkarım |
| `synth-ema.mjs` | EMA Lightning (Harfiyen `ema.ts` taşıması) |
| `synth_okur.py` | Okur v1.0 (kendi Python ön ucu, numpy zaman çizelgesi) |
| `synth_pocket.py` | Pocket TTS Turkish (PyTorch CPU) |
| `select.json` | kör sayfaya giren adaylar |
| `listen-template.html`, `build-listen.mjs` | sayfa şablonu ve üretici |

## Ölçüm notları

- RTF = sentez süresi / ses süresi; her aday için ısınma çağrısından sonra 20 cümlenin toplamı. `--threads 1` ve `4`.
- Ölçümler Node `onnxruntime-node` (yerel CPU çekirdekleri) ile yapıldı; eklentideki onnxruntime-web WASM tek iş
  parçacığında bundan yavaştır. WASM ölçümü yapılmadı.
- Metin ön ucu adaya göre değişir: Antalia/Ahenk/EMA/Supertonic eklentinin `normalizeText` çıktısını alır
  ("YouTube" -> "Yutub"), Okur ve Pocket kendi ön uçlarını kullanır. Özel ad/sayı farkları kısmen bundan gelir.
