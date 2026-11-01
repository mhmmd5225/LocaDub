# Üçüncü Taraf Bildirimleri

Bu eklenti aşağıdaki üçüncü taraf yazılımları ve modelleri içerir veya kullanır.

## Paketlenmiş yazılımlar

### onnxruntime-web 1.22.0 — `lib/ort/`

- Kaynak: https://github.com/microsoft/onnxruntime (npm: `onnxruntime-web@1.22.0`)
- Lisans: MIT
- Dosyalar: `ort.wasm.min.mjs`, `ort.webgpu.min.mjs`, `ort-wasm-simd-threaded.mjs`,
  `ort-wasm-simd-threaded.wasm`, `ort-wasm-simd-threaded.jsep.mjs`, `ort-wasm-simd-threaded.jsep.wasm`

```
MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

onnxruntime-web, kendi bağımlılıklarının bildirimlerini
https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt adresinde yayımlar.

## Çeviri motoru (`engines/mt/`)

### Kod — harfiyen (MIT)

- Kaynak: https://github.com/ozcancelik/harfiyen — Copyright (c) Ozcan Celik, MIT Lisansı.
- `spm.js`, `marian.js`, `worker.js` bu projeden uyarlanmıştır (atıflar dosya başlarında).
  MIT lisans metni yukarıdaki onnxruntime-web bölümündekiyle aynıdır; telif satırı
  "Copyright (c) Ozcan Celik" olarak geçerlidir.

### Model — opus-mt-tc-big-en-tr (CC-BY 4.0)

- Model: Helsinki-NLP/opus-mt-tc-big-en-tr — Tatoeba-Challenge / OPUS-MT, Helsinki Üniversitesi.
  https://huggingface.co/Helsinki-NLP/opus-mt-tc-big-en-tr
- ONNX dönüşümü: https://huggingface.co/onnx-community/opus-mt-tc-big-en-tr
  (commit `ce128ea834a090aca240e4e113e7756e06cc78e0`)
- Lisans: Creative Commons Attribution 4.0 (https://creativecommons.org/licenses/by/4.0/).
  Model ağırlıkları eklentiye paketlenmez; ilk kullanımda HuggingFace'ten indirilir.
  Eklenti, decoder'ın yinelenen fp32 embedding tablosunu kendi uint8 kopyasından yeniden kurar
  (değişiklik bildirimi).
- İsteğe bağlı: Chrome yerleşik Translator API (Google, cihaz üzerinde) — ayrı lisans gerektirmez.

### İsteğe bağlı model — noktalama ve büyük harf (Apache-2.0)

- Model: 1-800-BAD-CODE/punctuation_fullstop_truecase_english (`punct_cap_seg_en.onnx`, `spe_32k_lc_en.model`) —
  Apache-2.0. https://huggingface.co/1-800-BAD-CODE/punctuation_fullstop_truecase_english
  (sürüm `b26fd1c40e88678859048898218ea4edcc24c84a`). Eklentiye paketlenmez; kullanıcı ayarlar sayfasından isterse indirir.
- `punct.js`, modelin çıktısını (noktalama, büyük harf, cümle sınırı etiketleri) metne dönüştüren mantığı, yazarın
  `punctuators` paketinin (v0.0.7) çıktı çözümünü izleyerek JavaScript'te yeniden yazar. Paketin dağıtımında lisans
  bilgisi yer almıyor; paket koduna bağlı değildir, ancak çözüm adımları aynıdır. Yazarın lisans bilgisi netleşirse bu satır güncellenmelidir.

## Seslendirme motoru (`engines/tts/`)

### Kod

- **harfiyen** — https://github.com/ozcancelik/harfiyen — MIT, Copyright (c) 2026 Özcan Çelik
  (commit `981902ceaef804fdb7a4edb782078c766e3b53c2`). `trnorm/*.js` (src/tts/trnorm),
  `ahenk.js` (src/tts/ahenk.ts + ema.ts portu), `ema.js` (src/tts/ema.ts portu), `dsp.js` trimSilence, `antalia.js` yapısı.
- **trnorm / Ahenk demo** — https://github.com/ozguradmin/ahenk-turkish-tts — Apache-2.0.
- **Antalia-2 Mini web demo** — https://huggingface.co/spaces/cloud0day3/antalia-mini
  (`js/tts.js`, `js/frontend.js` @ `2c24b406`) — Apache-2.0, Copyright 2026 PatientDesk AI.
  `frontend-data.json.gz`, CMU Pronouncing Dictionary verisini içerir (BSD-2-Clause).
- **Supertonic web örneği** — https://github.com/supertone-inc/supertonic (`web/helper.js`) — MIT, Copyright (c) 2025
  Supertone Inc. `supertonic.js` bu dosyanın metin ön işlemesini, parçalayıcısını ve grafik çağrılarını JavaScript'e
  uyarlar (düz typed array'ler, tohumlu gürültü, hazır ses karıştırma eklendi).

### Ses modelleri (eklentiye paketlenmez, ilk kullanımda HuggingFace'ten indirilir)

- **Antalia-2 Mini** (varsayılan, erkek) — https://huggingface.co/cloud0day3/antalia-mini — Apache-2.0.
- **Ahenk Cep** (kadın) — https://huggingface.co/ozgurguler/ahenk-cep-tr — CC BY 4.0, ozgurguler;
  EMA Lightning (Apache-2.0) türevi, Alania verileri (CC BY 4.0, PatientDesk AI).
  Atıf: "Ses: Ahenk Cep (ozgurguler), CC BY 4.0". Üretilen ses yapaydır (yapay zekâ ile sentezlenmiştir).
- **EMA Lightning** (kadın) — ağırlıklar https://huggingface.co/canberkkkkkk/ema-lightning, ONNX dışa aktarımı
  https://huggingface.co/ozcancelik/ema-lightning-onnx (`13c431d`) — Apache-2.0. Üretilen ses yapaydır.
- **Supertonic 3** (deneysel, 10 hazır ses: F1–F5 kadın, M1–M5 erkek) — https://huggingface.co/Supertone/supertonic-3
  (commit `3cadd1ee6394adea1bd021217a0e650ede09a323`) — BigScience OpenRAIL-M, Supertone Inc. Lisans, modelin
  kullanımına sınırlamalar koyar (Ek A: yasa dışı kullanım, başkasını taklit ederek yanıltma, rıza dışı kişisel veri vb.
  yasak); bu sınırlamalar eklentinin kullanıcıları için de geçerlidir. Model eklentiye paketlenmez;
  ses karıştırma yalnızca hazır stil vektörlerini çalışma anında harmanlar. Üretilen ses yapaydır.
  Eklentinin indirdiği kopya: https://huggingface.co/teknikkent/supertonic-3-int8 (commit
  `605d35c25d57eca4749939b85f16a24aa83e4561`) — aynı lisans; **değiştirildi:** `vector_estimator` dinamik 8-bit
  nicemlendi (`tools/tts/quantize-supertonic.py`), diğer dosyalar resmî dosyaların aynısı. Depo lisansı, özgün model
  kartını, değişiklik bildirimini ve kullanım kısıtlarını içerir.

## Ses ayırma motoru (`engines/sep/`)

Kod (STFT/ISTFT, yeniden örnekleme, parçalama) bu projeye özgüdür; MDX-Net ön/son işlemesi (STFT düzeni, en alt
3 binin sıfırlanması, `compensate` katsayıları) Ultimate Vocal Remover'ın davranışını izler.

### Ayırma modelleri (eklentiye paketlenmez, ilk kullanımda HuggingFace'ten indirilir)

- **Kim Vocal 2** (varsayılan) — MDX-Net vokal modeli, Kimberley Jensen; Ultimate Vocal Remover (UVR) ile dağıtılır.
- **UVR-MDX-NET Voc FT**, **UVR-MDX-NET Inst HQ 3**, **UVR-MDX-NET Inst HQ 5** — UVR ekibi (Anjok07, aufr33).
- Mimari: MDX-Net / TFC-TDF-U-Net, KUIELab (Minseok Kim vd., MIT).
- Lisans: MIT — UVR (https://github.com/Anjok07/ultimatevocalremovergui) modellerini MIT lisansıyla dağıtır ve
  modelleri kullanan uygulamalardan UVR'ye ve geliştiricilerine atıf ister. Atıf: "Ses ayırma: Ultimate Vocal
  Remover (UVR) MDX-Net modelleri — Anjok07, aufr33, Kimberley Jensen; MIT".
- Eklentinin indirdiği kopya: https://huggingface.co/Politrees/UVR_resources (commit
  `929e057b81aa49bc2e6490bef8671f47b2c120f6`, MIT etiketli ayna), dosyalar değiştirilmeden; sha256 değerleri
  `engines/sep/models.js` içinde.

## Konuşmacı tanıma motoru (`engines/spk/`)

Kod (Kaldi uyumlu fbank, kümeleme, cinsiyet kararı) bu projeye özgüdür; fbank Kaldi'nin `compute-fbank-feats`
varsayılanlarını izler ve kaldi-native-fbank (Apache-2.0) değerleriyle sınanır (`tests/extension/spk.test.mjs`).

### Konuşmacı modeli (eklentiye paketlenmez, ilk kullanımda HuggingFace'ten indirilir)

- **WeSpeaker ResNet34-LM (VoxCeleb)** — WeSpeaker projesi (https://github.com/wenet-e2e/wespeaker, kod Apache-2.0).
  Lisans: **CC-BY 4.0** — WeSpeaker'ın önceden eğitilmiş modelleri eğitim verisinin lisansını izler; VoxCeleb modelleri
  VoxCeleb'in Creative Commons Attribution 4.0 lisansıyla dağıtılır (https://mm.kaist.ac.kr/datasets/voxceleb/).
  Atıf: "Konuşmacı tanıma: WeSpeaker ResNet34-LM, VoxCeleb (Nagrani vd.) ile eğitilmiş — CC-BY 4.0".
- Eklentinin indirdiği kopya: sherpa-onnx projesinin ONNX dışa aktarımı,
  https://huggingface.co/csukuangfj/speaker-embedding-models (commit `0743f301363dec56491a490f6d6cbc9d67f9a3bf`,
  `wespeaker_en_voxceleb_resnet34_LM.onnx`), değiştirilmeden; boyut ve sha256 `engines/spk/models.js` içinde.
- Katalogdaki diğer seçenek (yalnız ölçüm aracı kullanır): 3D-Speaker ERes2Net VoxCeleb (Apache-2.0, ModelScope
  `iic/speech_eres2net_sv_en_voxceleb_16k`).

### Cinsiyet katmanı — `engines/spk/gender-wespeaker-r34.json`

Konuşmacı vektöründen kadın/erkek puanı veren 257 sayılık doğrusal katman; bu projede `tools/spk-eval.mjs
--train-gender` ile **LibriSpeech test-clean** (V. Panayotov vd., CC-BY 4.0, https://www.openslr.org/12) konuşmacılarının
cümlelerinden ve sentetik müzikle karıştırılmış kopyalarından eğitildi. Atıf: "LibriSpeech ASR corpus, CC-BY 4.0".

## Referans proje

- harfiyen — https://github.com/ozcancelik/harfiyen (MIT). Kod alındıysa ilgili motor
  bölümünde telif satırıyla birlikte belirtilir.
