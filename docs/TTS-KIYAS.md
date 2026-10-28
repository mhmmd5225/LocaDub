# Ses kıyası: mevcut sesler ve Supertonic 3 (Ekim 2026)

`tests/tts/compare.mjs` ile. 14 Türkçe cümle (7 düz, 4 soru, 3 ünlem; sayılı/kısaltmalı olanlar dâhil) her sesle eklentinin
kendi sentez çekirdeğinden (`extension/engines/tts/core.js`, onnxruntime-node, **tek iş parçacığı**) geçirildi.
Ölçütler:

- **RTF**: hesap süresi / ses süresi (Node CPU; tarayıcı WASM için aşağıdaki ayrı tabloya bakın).
- **WER / CER**: Whisper large-v3-turbo (`faster-whisper`, int8) dökümüne göre sözcük/harf hata oranı; yalnızca sayı ve
  kısaltma içermeyen 10 cümlede (Whisper'ın "14.30" gibi yazımı hata sayılmasın diye). `tests/tts/wer.py`.
- **F0 sapma / aralık**: YIN perde izleyicisiyle (`tests/tts/prosody.mjs`) cümle içi perdenin standart sapması ve
  %5–%95 aralığı, yarım ton (yt). Ezginin ne kadar hareket ettiğini, yani "tek düze" olup olmadığını ölçer.
- **soru / ünlem sonu**: son %20 sesli çerçevenin gövdeye göre perdesi (yt).
- **seviye**: kapılı RMS (sessizlik ve duraklamalar hariç), dBFS; ± cümleler arası standart sapma.

Tek ölçüm, tek makine (4 çekirdek); sayılar oran fikri verir, mutlak değil. Bir iki sözcük farkı WER'de ≈ %1 eder.

## 1. Değişiklikten önce (tüm sesler)

| Ses | RTF | WER % | CER % | F0 sapma (yt) | F0 aralık (yt) | soru sonu (yt) | ünlem sonu (yt) | seviye dBFS |
|---|---|---|---|---|---|---|---|---|
| Antalia Mini | 0.088 | 2.1 | 0.2 | 2.04 | 6.76 | −2.43 | −2.40 | −18.9 (± 0.3) |
| Ahenk Cep | 0.117 | 3.2 | 0.9 | 3.58 | 11.47 | −1.63 | −2.83 | −20.2 (± 0.4) |
| EMA Lightning | 0.096 | 2.1 | 0.2 | 2.72 | 8.91 | −2.40 | −1.45 | −24.7 (± 1.4) |
| Supertonic F1 | 0.398 | 2.1 | 0.2 | 3.16 | 9.63 | −1.81 | −4.03 | −24.1 (± 0.5) |
| Supertonic F2 | 0.420 | 2.1 | 0.2 | 3.69 | 11.45 | −5.27 | −0.49 | −24.4 (± 0.9) |
| Supertonic F3 | 0.377 | 2.1 | 0.2 | **3.89** | **12.02** | −4.47 | −4.33 | −25.1 (± 0.7) |
| Supertonic F4 | 0.409 | 4.2 | 2.0 | 2.07 | 6.60 | 0.30 | −2.32 | −24.2 (± 0.5) |
| Supertonic F5 | 0.404 | 2.1 | 0.3 | 2.78 | 8.87 | −2.44 | −2.28 | −23.4 (± 0.5) |
| Supertonic M1 | 0.399 | 4.2 | 0.5 | **3.87** | 11.44 | −3.79 | 2.46 | −24.2 (± 0.5) |
| Supertonic M2 | 0.430 | 3.2 | 0.8 | 2.20 | 6.83 | −3.48 | 0.36 | −23.0 (± 0.6) |
| Supertonic M3 | 0.423 | 2.1 | 0.2 | 2.67 | 8.03 | −3.40 | 1.46 | −23.5 (± 0.5) |
| Supertonic M4 | 0.398 | **0.0** | **0.0** | 3.05 | 9.89 | −3.12 | −2.95 | −23.5 (± 0.5) |
| Supertonic M5 | 0.385 | 4.2 | 0.3 | 2.71 | 8.80 | −2.94 | −2.10 | −23.7 (± 0.3) |
| Antalia, Canlı | 0.091 | 3.2 | 0.3 | 2.02 | 6.69 | −2.36 | −2.35 | −18.7 (± 0.3) |
| Ahenk, Canlı | 0.126 | 2.1 | 0.2 | 3.63 | 11.75 | −1.35 | −3.90 | −19.8 (± 0.6) |
| Supertonic F1, 16 adım | 0.768 | 4.2 | 0.5 | 3.15 | 9.66 | −3.14 | −4.23 | −23.9 (± 0.4) |

(Supertonic bu turda 8 gürültü giderme adımıyla. Hataların çoğu Whisper'dan: "hoşça kalın" → "hoşçakalın", bir kez
"Altyazı M.K." uydurması; sonraki turda "hoşça kal" yazımı eşitlendi.)

### Antalia'nın üslup düğmeleri ezgiyi değiştirmiyor

Antalia'da üslup yalnızca örnekleme sıcaklığını ve CFG'yi değiştirebiliyor. 10 cümle × 2 tohum:

| sıcaklık | CFG | F0 sapma (yt) |
|---|---|---|
| 0.6 (Doğal) | 2.0 | 2.00 |
| 0.9 | 2.0 | 1.97 |
| 0.6 | 3.0 | 1.90 |
| 0.9 | 3.0 | 1.92 |
| 0.6 | 1.5 | 2.05 |

Hepsi ≈ 2 yt: Antalia'nın tekdüzeliği bir ayarla düzelmiyor, modelin kendisinden. Ahenk Cep (3.6) ve Supertonic'in
F2/F3/M1 sesleri (3.7–3.9) belirgin biçimde daha hareketli bir ezgiyle konuşuyor.

### Soru sonu

Neredeyse bütün seslerde soru cümlesi sonunda perde **düşüyor**. Bu Türkçe için yanlış değildir: "mi" soru eki
taşıyan sorularda vurgu ekten önceki heceye yükselir, ek ve cümle sonu düşer; "neden / nasıl" sorularında da sonda iniş
olağandır. Bu yüzden önerilen "soru sonuna yapay perde rampası" **eklenmedi**: doğal olmayan bir yükseliş getirirdi.
Soru (?) ve ünlem (!) işaretlerinin modellere ulaştığı doğrulandı (üç modelin de sözlüğünde var; testte sabit).

## 2. Değişiklikten sonra

Cümle başına tohum, bağlaç virgülü ve ses seviyesi dengesi açık; Supertonic Hızlı = 5 adım.

| Ses | RTF | WER % | CER % | F0 sapma (yt) | F0 aralık (yt) | seviye dBFS |
|---|---|---|---|---|---|---|
| Antalia Mini | 0.086 | 0.0 | 0.0 | 1.92 | 6.57 | **−20.0 (± 0.0)** |
| Ahenk Cep | 0.113 | 0.0 | 0.0 | 3.40 | 10.91 | **−20.0 (± 0.0)** |
| EMA Lightning | 0.100 | 1.1 | 0.2 | 3.12 | 9.52 | **−20.0 (± 0.0)** |
| Supertonic F1 (5 adım) | 0.281 | 2.1 | 0.6 | 2.86 | 8.97 | −20.0 (± 0.0) |
| Supertonic F3 (5 adım) | 0.262 | 0.0 | 0.0 | 3.85 | 12.21 | −20.0 (± 0.0) |
| Supertonic M1 (5 adım) | 0.271 | 0.0 | 0.0 | 3.42 | 10.34 | −20.0 (± 0.0) |
| Supertonic M4 (5 adım) | 0.263 | 0.0 | 0.0 | 2.84 | 8.84 | −20.0 (± 0.0) |
| Supertonic F1 (8 adım) | 0.399 | 2.1 | 0.3 | 2.89 | 9.16 | −20.0 (± 0.0) |
| Supertonic M4 (8 adım) | 0.384 | 0.0 | 0.0 | 2.95 | 9.28 | −20.0 (± 0.0) |

- **Ses seviyesi:** sesler arası 6.2 dB fark (EMA/Supertonic −25, Antalia −19) ve EMA'nın cümleden cümleye ±1.4 dB oynaması
  kalktı. Konuşmacılar farklı seslerle konuşurken artık seviye sıçraması yok.
- **Tohum:** ortalama F0 sapmasını kayda değer değiştirmiyor (Antalia 2.04 → 1.92, EMA 2.72 → 3.12; tek ölçüm gürültüsü
  içinde). Kazancı ortalamada değil, art arda gelen cümlelerin aynı gürültüden başlayıp benzer ezgiyle konuşmamasında.
- **Supertonic 5 adım** 8 adımla aynı anlaşılırlıkta ve ≈ %30 hızlı: Hızlı = 5, Yüksek = 8.

## 3. Tarayıcı hızı (Chromium, onnxruntime-web 1.22 WASM)

`tests/tts/browser/index.html?local=1&auto=1` (Playwright, başsız Chromium, 4 çekirdek, cross-origin isolated), 5 cümle
≈ 24 sn ses. Dublajın yetişmesi için RTF < 1 şart; önceden hazırlama payı ve aynı anda çalışan çeviri düşünülünce
≤ 0.5 rahat sayılır.

| Ses | İş parçacığı | RTF |
|---|---|---|
| Antalia Mini | 1 | 0.30–0.34 |
| Ahenk Cep | 1 | 0.36 |
| EMA Lightning | 1 | 0.27 |
| Supertonic F1, 5 adım | 1 | **1.22** |
| Supertonic F1, 5 adım | 3 (bu makinede kendiliğinden: çekirdek − 1) | 0.80 |
| Supertonic F1, 5 adım | 4 | 0.57 |
| Supertonic M4, 8 adım | 3 | 1.10 |
| Supertonic F1, 5 adım, 8-bit vector_estimator (eklentide yok) | 1 / 4 | 0.93 / 0.38 |

Node'da 0.28 olan Supertonic tarayıcı WASM'inde 4 kat yavaş (konvolüsyon ağırlıklı, 99 M parametre); küçük sesler
yalnızca ~3 kat. WebGPU bu test ortamında yoktu, ölçülmedi.

## Sonuç ve kararlar

- **Supertonic 3 deneysel ses olarak eklendi, varsayılan değil.** Tonlaması en canlı sesler onda (F3, M1, F2) ve
  anlaşılırlığı mevcut seslerle aynı; 10 ses (5 kadın, 5 erkek) konuşmacılara farklı ses için ek indirme gerektirmez.
  Ama tek iş parçacığında gerçek zamandan yavaş (karar kapısı RTF ≤ 0.5 tek iş parçacığında geçilemedi), bu yüzden:
  - yalnızca Supertonic yüklenirken worker en çok 4 iş parçacığıyla açılır (çekirdek − 1); çok iş parçacıklı yükleme
    90 sn'de bitmezse tek iş parçacığına düşer (ort 1.22'de bazı Chromium sürümlerinde görülen asılı kalma);
  - Hızlı kalite 5 adım; Yüksek (8 adım) 4 çekirdekli makinede yetişmez, 8+ çekirdek önerilir;
  - indirme ≈ 398 MB (resmî fp32 dosyalar, değiştirilmeden).
- **Sonraki adım (önerilen):** vector_estimator'ın 8-bit kopyası (`onnxruntime.quantization.quantize_dynamic`, MatMul +
  Conv, QUInt8) 257 MB'tan 65 MB'a iniyor ve 4 iş parçacığında RTF 0.57 → 0.38. Paket ≈ 210 MB'a düşer. Kopyanın
  bir HuggingFace deposunda barındırılması gerekir (OpenRAIL-M türev dağıtımına izin verir, kullanım kısıtları aynen
  aktarılmalı); anlaşılırlığı tam setle ayrıca ölçülmeli.
- **Elenenler:** Chatterbox Multilingual (≥ 1.2 GB, otoregresif, gerçek zamanlı değil), Piper dfki ve MMS-TTS (ticari
  olmayan lisans), Okur (kartına göre EMA Lightning'den düşük UTMOS/WER, tek ses), Pocket TTS Türkçe ince ayarları
  (ONNX yok; ses klonlama için ileride bakılabilir), Kokoro/Kitten (Türkçe yok).
- **Tüm sesler için:** ses seviyesi dengesi, cümle başına tohum ve uzun yan cümlelerde bağlaç öncesi virgül (modeller
  duraklamayı ve yeni ezgi yayını yalnızca noktalamadan alıyor).

## Yeniden üretmek

```
cd tests/tts && ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install
node ../../tools/tts/fetch-models.mjs                 # ≈ 490 MB, Supertonic dâhil
node compare.mjs --tag base                           # WAV'lar + results.json: out/compare/base/
python3 -m venv .venv && .venv/bin/pip install faster-whisper
.venv/bin/python wer.py out/compare/base
node compare.mjs --summary out/compare/base
node ../../tools/tts/serve.mjs                        # tarayıcı: /tests/tts/browser/index.html?voice=supertonic-3:F1&local=1&auto=1
```
