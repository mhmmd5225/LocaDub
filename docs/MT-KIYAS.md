# Çeviri kıyası: OPUS-MT ve TranslateGemma 4B (Ekim 2026)

`tests/mt/compare.mjs` ile. Veri: WMT18 haber testi EN→TR, 4–25 sözcüklü ilk 60 cümle, tek referans çeviri.
Her cümle iki biçimde çevrildi: **metin** (özgün) ve **asr** (küçük harf, noktalamasız; YouTube otomatik
altyazısına benzer). Puanlar sacrebleu 2.6 (chrF2, BLEU 13a). Hız bu makinenin CPU'sunda (4 iş parçacığı,
onnxruntime-node) ölçüldü; tarayıcıdaki WASM/WebGPU hızını yansıtmaz, yalnızca oran fikri verir.

| Sistem | İndirme | Girdi | chrF | BLEU | ms/cümle (CPU) |
|---|---|---|---|---|---|
| OPUS-MT tc-big (int8-slim) | ≈ 300 MB | metin | **52.0** | **17.4** | 1144 |
| OPUS-MT tc-big (int8-slim) | | asr | **48.8** | **12.7** | 1052 |
| TranslateGemma 4B (q4) | ≈ 3.1 GB, WebGPU | metin | 46.1 | 8.8 | 11862 |
| TranslateGemma 4B (q4) | | asr | 47.4 | 9.5 | 11987 |

## Sonuç

- **TranslateGemma eklentiye eklenmiyor** (yol haritası A2 düştü): Her iki girdide de OPUS-MT'den düşük puan alıyor,
  10 kat büyük, ~10 kat yavaş ve WebGPU gerektiriyor.
- TranslateGemma daha serbest çeviriyor. Bazı cümlelerde OPUS-MT'nin bozuk çıktısından daha akıcı ("milyarlarca büyük
  ve kayalık meteor bulunuyor; bunların çarpışması ciddi sonuçlara yol açabilir"), bazılarında anlamı kaydırıyor
  ("Acil haber", "duyurmaya başladık"). Tek referanslı chrF serbest çeviriyi bir miktar cezalandırır; fark yine de
  kararı değiştirecek büyüklükte değil.
- **Asıl fırsat:** OPUS-MT noktalamasız/küçük harfli girdide kalite kaybediyor. YouTube'un otomatik altyazıları tam bu
  biçimde olduğu için çeviriden önce noktalama ve büyük harf geri kazandırıldı; aşağıya bakın.

## Otomatik altyazıda noktalama geri kazanımı (200 cümle, OPUS-MT)

`node compare.mjs --n 200 --systems opus --restore rules,model,model-int8`. "Özgün metin" üst sınırdır; "otomatik altyazı"
girdisi küçük harfli ve noktalamasızdır. Geri kazanım çeviriden önce İngilizce metne uygulanır.

| Girdi | chrF | BLEU | geri kazanım ms/cümle (CPU) |
|---|---|---|---|
| Özgün metin (üst sınır) | 54.9 | 22.8 | — |
| Otomatik altyazı biçimi | 51.1 | 15.6 | — |
| + kurallar (`i`→`I`, cümle başı, nokta) | 51.1 | 15.6 | 0 |
| + model, fp32 (210 MB) | **53.1** | **17.9** | 9 |
| + model, int8 (53 MB) | **53.1** | **18.1** | 6 |

- Model, 3.8 chrF'lik kaybın 2.0'ını (≈ %53) geri alıyor. Kurallar hiçbir kazanç sağlamıyor, eklentiye girmedi.
- fp32 ve int8 kalitede aynı; eklenti özgün fp32 dosyayı kullanıyor (210 MB, isteğe bağlı, yazarın HuggingFace deposundan).
  int8 (53 MB) barındırılırsa indirme 4 kat küçülür; ileride düşünülebilir.
- Model: `1-800-BAD-CODE/punctuation_fullstop_truecase_english` (Apache-2.0). Çözüm mantığı `extension/engines/mt/punct.js`.
- Kapsam dışı kaldı, sonraki iş: modelin cümle sınırı çıktısıyla daha iyi cümle bölme.

Yeniden üretmek: `cd tests/mt && ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install && node ../../tools/mt/download-test-models.mjs int8-slim && pip install sacrebleu && node compare.mjs --n 60`.
Noktalama için ayrıca `.models/punct-en/` altına `punct_cap_seg_en.onnx` ve `spe_32k_lc_en.model` dosyalarını HuggingFace'ten indirin
(int8 için `onnxruntime.quantization.quantize_dynamic` ile `punct_cap_seg_en.int8.onnx` üretin).
