# Ses kıyası: cihaz-içi Türkçe TTS adayları (Ekim 2026)

Amaç: Antalia Mini ve Ahenk Cep robotik duyuluyor. Daha insansı ücretsiz cihaz-içi Türkçe ses var mı, bedeli ne?
Karar kulakla verilir; bu belge sesleri üretir, hızı ve boyutu ölçer, otomatik bir kalite tahmini ekler ve kör dinleme
sayfasını hazırlar. **Bu belge hiçbir sesin ChatGPT kalitesine denk olduğunu iddia etmez ve öznel kalite hükmü vermez.**

Araçlar: [`tools/tts/lab/`](../tools/tts/lab/README.md). Ses dosyaları depoda yoktur.
Kör dinleme sayfası (özel): https://claude.ai/artifact/Vfumh1QGBfYyUhAGL4FK3R

## Yöntem

- 20 Türkçe cümle (`tools/tts/lab/sentences.json`): kısa, orta, uzun (25+ sözcük), soru, ünlem, sayı/tarih/para,
  İngilizce özel ad (YouTube, iPhone, SpaceX), kısa tepki, sohbet, haber ve öğretici tonu.
- Aynı cümleler, aynı makine (4 çekirdek CPU), `onnxruntime-node` 1.22 CPU (Pocket için PyTorch 2.14 CPU).
  RTF = sentez süresi / ses süresi, ısınma çağrısından sonra 20 cümlenin toplamı. Düşük iyidir; 1.0 gerçek zamanlıdır.
- UTMOS22 (strong learner, `mosnets/utmos`) Okur deposunun `scripts/utmos_score.py` betiğiyle koşuldu. Model
  İngilizce/Japonca eğitimli; **Türkçede yalnızca kaba bir ölçüttür**, adaylar arası küçük farklar anlamsızdır.
  Sağlama: Okur'un kendi raporu (Freya-TR-Eval) Okur 2.93 ve EMA Lightning 3.29 diyor; burada 2.88 ve 3.28 çıktı.
- Metin ön ucu adaya göre değişir. Antalia, Ahenk, EMA ve Supertonic eklentinin `normalizeText` çıktısını alır
  (ör. "YouTube" -> "Yutub", "iPhone" -> "ayfon"). Okur ve Pocket kendi ön uçlarını kullanır. Özel ad ve sayı
  okumalarındaki farkın bir kısmı ses değil ön uç farkıdır.

## Sonuç tablosu

| Aday | Sürüm / kaynak | Lisans | İndirilen boyut | Çıkış Hz | RTF 4 iş p. | RTF 1 iş p. | UTMOS22 |
|---|---|---|---|---|---|---|---|
| Antalia Mini (mevcut) | `cloud0day3/antalia-mini` @2c24b40 | Apache-2.0 | 23,4 MB | 48000 | 0,162 | 0,183 | 3,20 ± 0,13 |
| Ahenk Cep, neutral (mevcut) | `ozgurguler/ahenk-cep-tr` @345c4cb, 8 adım | CC-BY-4.0 | 17,4 MB | 48000 | 0,138 | 0,238 | 3,15 ± 0,13 |
| Ahenk Cep, calm | aynı | CC-BY-4.0 | 17,4 MB | 48000 | 0,135 | 0,230 | 3,20 ± 0,14 |
| Ahenk Cep, cheerful | aynı | CC-BY-4.0 | 17,4 MB | 48000 | 0,122 | 0,237 | 2,90 ± 0,15 |
| EMA Lightning | `ozcancelik/ema-lightning-onnx` @13c431d (fp32) | Apache-2.0 | 35,0 MB | 48000 | 0,098 | 0,173 | 3,28 ± 0,12 |
| Okur v1.0 | `ahakan/okur-tts` @0c1ae1a | CC BY 4.0 (ağırlık), Apache-2.0 (kod) | 23,2 MB | 48000 | 0,089 | 0,172 | 2,88 ± 0,12 |
| Supertonic 3, F1 | `Supertone/supertonic-3` @3cadd1e, 8 adım | OpenRAIL-M | 398 MB (+0,3 MB/ses) | 44100 | 0,368 | 0,647 | 4,20 ± 0,06 |
| Supertonic 3, F3 | aynı | OpenRAIL-M | aynı | 44100 | 0,366 | – | 4,12 ± 0,06 |
| Supertonic 3, M4 | aynı | OpenRAIL-M | aynı | 44100 | 0,391 | – | 4,04 ± 0,08 |
| Supertonic 3, M1 | aynı | OpenRAIL-M | aynı | 44100 | 0,437 | 0,649 | 3,96 ± 0,11 |
| Supertonic 3, F2 / F4 / F5 | aynı | OpenRAIL-M | aynı | 44100 | 0,374 / 0,405 / 0,383 | – | 4,01 / 3,98 / 3,98 |
| Supertonic 3, M2 / M3 / M5 | aynı | OpenRAIL-M | aynı | 44100 | 0,611 (*) / 0,392 / 0,358 | – | 3,89 / 3,77 / 3,92 |
| Pocket TTS Turkish, female_1 | `wite-tech/pocket-tts-turkish` @fcbd37c | CC-BY-4.0 | 438 MB | 24000 | 0,852 | 0,874 | 3,55 ± 0,16 |
| Pocket TTS Turkish, female_2 | aynı | CC-BY-4.0 | 438 MB | 24000 | 0,864 | – | 3,36 ± 0,13 |
| Pocket TTS Turkish, male_2 | aynı | CC-BY-4.0 | 438 MB | 24000 | 0,851 | – | 2,92 ± 0,16 |
| Pocket TTS Turkish, male_1 | aynı | CC-BY-4.0 | 438 MB | 24000 | 0,838 | 0,877 | 2,70 ± 0,12 |

(*) M2 ölçümü diğer Supertonic seslerinden belirgin yavaş çıktı; aynı grafikler, büyük olasılıkla makine gürültüsü.
Tekrarlanmadı.

Boyut: çıkarımda kullanılan ONNX/safetensors dosyalarının toplamı. EMA'nın fp16 `sound.onnx` dosyası (9,6 MB) indirildi
ama ölçülmedi; toplam boyutu yaklaşık 26 MB'a düşürür. Ses süreleri aday başına 84 ile 123 s arasındadır (Okur ve
Supertonic daha yavaş konuşuyor); RTF bu yüzden süre normalleştirilmiş bir ölçüdür.

## Ölçülebilir bulgular

- **Hız.** Okur, EMA ve Ahenk/Antalia 4 çekirdekte RTF 0,09 ile 0,16: gerçek zamanın 6 ile 11 katı hızlı.
  Supertonic 3 yaklaşık 0,37 ile 0,44 (2,5 ile 2,7 kat gerçek zaman), tek çekirdekte 0,65. Pocket TTS bu makinede
  0,84 ile 0,88 ve çekirdek sayısından neredeyse bağımsız (model kartı tek iş parçacığında ~5 kat gerçek zaman
  söylüyor; burada tutmadı, PyTorch CPU yolu bu ortamda yavaş olabilir).
- **Boyut.** Küçük grup 17 ile 35 MB. Supertonic 3 yaklaşık 400 MB (vector_estimator tek başına 257 MB), Pocket 438 MB.
  Eklentinin ilk indirme deneyimi için bu 15 ile 20 kat fark.
- **UTMOS22 (kaba, İngilizce eğitimli).** Supertonic 3 sesleri 3,77 ile 4,20; mevcut sesler 3,15 ile 3,20; Okur 2,88.
  Fark Supertonic lehine büyük ve güven aralıkları (±0,06 ile 0,14) örtüşmüyor. Ancak UTMOS Türkçe telaffuz,
  vurgu veya ritmin doğruluğunu bilmez; sıralamayı kulağın belirleyeceği konusu açık.
- **Ahenk stilleri.** `calm` ile `neutral` arasında UTMOS farkı gürültü düzeyinde (3,20 / 3,15); `cheerful` daha düşük (2,90).
- **Lisans.** Supertonic 3 OpenRAIL-M: kullanım kısıtları içerir, eklentiye almadan önce hukuki okuma gerekir.
  Pocket, Ahenk, Okur CC-BY (atıf gerekir). EMA ve Antalia Apache-2.0.

## Yapılamayanlar ve nedenleri

| Madde | Durum |
|---|---|
| onnxruntime-web WASM tek iş parçacığı RTF | Yapılamadı: zaman kutusu; tarayıcı koşturucusu kurulmadı. Node CPU rakamları WASM için alt sınırdır (tarayıcı daha yavaş). Mevcut `tests/tts/browser` ile ölçülebilir. |
| Pocket TTS ONNX | Resmî ONNX yok; PyTorch CPU ile üretildi. Eklentiye girmesi için ONNX dışa aktarımı gerekir, yapılmadı. |
| Chatterbox Multilingual | Yapılamadı: WebGPU/GPU gerekir, ~1,5 GB; denenmedi. |
| EMA fp16 ses ve RTF | İndirildi, ölçülmedi. |
| Supertonic uzun metin bölme | Resmî `chunkText` kullanılmadı; cümleler tek parçada verildi (hepsi 300 karakter altı). |
| Gürültü tohumu | Supertonic gürültüsü `Math.random`; her çalıştırmada ses biraz farklı. EMA/Okur tohumlu. |

## Kör dinleme sayfası

16 cümle (2, 9, 14 ve 18. cümleler 12 MB sınırı için çıkarıldı) x 12 ses: Antalia, Ahenk neutral ve calm, EMA, Okur,
Supertonic F1/F3/M1/M4, Pocket female_1/female_2/male_2. mp3, 24 kHz mono 64 kbps, ses düzeyi `loudnorm` ile eşitlendi.
Her cümlede sıra rastgele ve etiketsiz (Ses A, B, ...). Her ses için 1 ile 5 insansılık puanı ve "Robotik" işareti.
"Sonuçları göster" gerçek adları, ortalamaları, UTMOS/RTF/boyutu ve kopyalanabilir JSON'u açar.

## Eklentiye taşırken akılda tutulacaklar

- Kulak Supertonic'i (veya başka birini) açık farkla seçerse, maliyet ~400 MB indirme ve ~2,5 kat gerçek zaman hızıdır; dublajda
  cümle başına süre bütçesi (konuşma hızına uyum) için hız marjı Ahenk'e göre çok daha dar.
- Supertonic sesleri 44,1 kHz; eklenti hattı 48 kHz bekliyorsa `dsp.js` yeniden örnekleme gerekir.
- Hiçbir aday kodu eklentiye kopyalanmadı.

## Kaynaklar

- https://huggingface.co/Supertone/supertonic-3, https://github.com/supertone-inc/supertonic
- https://huggingface.co/ozcancelik/ema-lightning-onnx, https://github.com/ozcancelik/harfiyen (`src/tts/ema.ts`, MIT)
- https://huggingface.co/ahakan/okur-tts, https://github.com/ahmethakanbesel/okur-tts
- https://huggingface.co/wite-tech/pocket-tts-turkish (PyPI: `pocket-tts-turkish`, `pocket-tts`)
- https://huggingface.co/mosnets/utmos (UTMOS22), PyPI `utmos`

## Komutlar

Yeniden üretme komutlarının tamamı: [`tools/tts/lab/README.md`](../tools/tts/lab/README.md).
