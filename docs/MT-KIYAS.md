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
- **Asıl fırsat:** OPUS-MT noktalamasız/küçük harfli girdide 3.2 chrF kaybediyor (52.0 → 48.8). YouTube'un otomatik
  altyazıları tam bu biçimde olduğu için, çeviriden önce noktalama ve büyük harf geri kazandırmak (küçük bir model ya da
  kural) en ucuz kalite artışı olabilir. Bir sonraki adım olarak önerilir.

Yeniden üretmek: `cd tests/mt && ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install && node ../../tools/mt/download-test-models.mjs int8-slim && pip install sacrebleu && node compare.mjs --n 60`
