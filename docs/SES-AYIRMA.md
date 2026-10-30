# Ses ayırma (konuşmayı çıkar, müzik + efekti koru)

"Gerçek dublaj" için videonun orijinal sesinden konuşma çıkarılır, kalan müzik + efektin (eşlik) üzerine Türkçe ses
konur. Bu belge yalnızca ayırma motorunu (`extension/engines/sep/`) anlatır; ses yakalama ve senkron başka modülün işi.

## Seçilen model: Kim Vocal 2 (UVR MDX-Net)

| | |
|---|---|
| Model | `Kim_Vocal_2.onnx` — MDX-Net (TFC-TDF U-Net) vokal modeli, Kimberley Jensen; Ultimate Vocal Remover (UVR) ile dağıtılır |
| Lisans | MIT (UVR, modelleri MIT ile dağıtır ve atıf ister; atıf `extension/THIRD_PARTY_NOTICES.md`'de) |
| İndirme | `huggingface.co/Politrees/UVR_resources` @ `929e057b81aa49bc2e6490bef8671f47b2c120f6` (MIT etiketli ayna), 66 759 214 bayt, sha256 `ce74ef3b…9c8b` |
| Giriş/çıkış | `input`/`output` `[B, 4, 3072, 256]` float32: L.re, L.im, R.re, R.im spektrogramı (opset 13) |
| STFT | 44.1 kHz, n_fft 7680, hop 1024, periyodik Hann, `center=True` (yansıtmalı dolgu), ilk 3072 bin (0–17.6 kHz); en alt 3 bin sıfırlanır |
| Pencere | dim_t 256 kare = 261 120 örnek = 5.92 sn |
| Çıktı | vokal spektrogramı; eşlik = karışım − 1.009 · vokal (UVR'nin `compensate` değeri) |
| İşlem | 379 GMAC / pencere (Conv, ConvTranspose, MatMul, BatchNorm, Relu — hepsi ORT-web WebGPU'da var) |

Parametreler UVR'nin `model_data.json`'undan (dosyanın son 10 MB'ının md5'i: `970b3f94…`) alındı ve dosya açılarak
doğrulandı (giriş boyutu, dim_f). STFT'nin torch.stft ile aynılığı numpy referansıyla, onnxruntime-web WASM sonucunun
onnxruntime-node ile aynılığı tarayıcıda (SNR 144 dB) denetlendi.

### Neden bu model

- **Kalite**: aşağıdaki ölçümde gerçek müzikte en yüksek SDR'lı iki modelden biri ve en düşük konuşma kalıntısı.
  Vokal modeli konuşmayı bir "vokal" olarak yakalar; eşliği karışımdan çıkararak buluruz, böylece müziğin 17.6 kHz
  üstü de korunur.
- **WebGPU uyumu**: grafik yalnızca 8 temel işlemden oluşuyor (~180 düğüm); dinamik şekil, kontrol akışı, karmaşık
  sayı yok. STFT/ISTFT JS'te.
- **Hız**: sabit maliyet; bir 5.92 sn'lik pencere 379 GMAC.
- **Lisans**: MIT, indirilip önbelleğe alınabilir.

### Katalogdaki diğer modeller (`models.js`)

| id | dosya | n_fft / dim_f | compensate | kaynak | not |
|---|---|---|---|---|---|
| `kim-vocal-2` (varsayılan) | Kim_Vocal_2.onnx 66.8 MB | 7680 / 3072 | 1.009 | vokal | |
| `voc-ft` | UVR-MDX-NET-Voc_FT.onnx 66.8 MB | 7680 / 3072 | 1.021 | vokal | Kim Vocal 2 ile eşdeğer |
| `mdxnet-lite` | UVR_MDXNET_1_9703.onnx 29.7 MB | 6144 / 2048 | 1.03 | vokal | 112 GMAC (3.4× az), GPU'suz yedek |
| `inst-hq-3` | UVR-MDX-NET-Inst_HQ_3.onnx 66.8 MB | 6144 / 3072 | 1.022 | enstrümantal | eşliği doğrudan verir |
| `inst-hq-5` | UVR-MDX-NET-Inst_HQ_5.onnx 59.1 MB | 5120 / 2560 | 1.01 | enstrümantal | |

`model: 'auto'` (işçinin varsayılanı): WebGPU varsa `kim-vocal-2`, yoksa `mdxnet-lite`.

### Değerlendirilen alternatifler

- **TIGER-DnR** (Apache-2.0, `audiojs/tiger-dnr` int8 ONNX, 7.3 MB): sinema sesi için eğitilmiş (diyalog / müzik /
  efekt), konu olarak en uygun model. Ama 38 800 düğümlük grafik (ReduceMean 8 388, CumSum, Resize…), mono, 12 sn'lik
  pencereler 4 sn adımla (her saniye 3 kez işlenir). Ölçüm: tek 12 sn mono pencere 4 çekirdek onnxruntime-node'da
  **65 sn** → stereo gerçek zamanın ~30 katı; WebGPU'da da bu kadar çok küçük çekirdekle gerçek zaman beklenmez.
  Elendi; ileride daha verimli bir DnR dışa aktarımı çıkarsa katalog yapısı (`arch`) ikinci mimariyi alabilir.
- **HTDemucs ONNX** (MIT; `StemSplitio/*`, `monteslu/htdemucs-web-onnx` 21 parçalı WebGPU dışa aktarımı): kalite iyi
  ama grafik büyük (dikkat katmanları, STFT'nin kendi içinde olduğu dışa aktarımlar ORT-web'de sorunlu), 4 kaynak
  üretip üçünü atmak gerekiyor; ~285 MB. MDX-Net vokal modelleri konuşma için yeterince iyi ve çok daha basit.
- **MDX23C / BS/Mel-RoFormer**: daha yüksek SDR ama ONNX dışa aktarımları yaygın değil, RoFormer'lar çok ağır.
- **Inst HQ 3/5** (enstrümantal): ölçümde Kim Vocal 2'nin biraz gerisinde, sessiz bölümlerde müziği daha çok
  bozuyor (33–34 dB'e karşı 37.6 dB).

## Uygulama (`extension/engines/sep/`)

- `models.js` — katalog (HF deposu, sabit revizyon, boyut, sha256, STFT parametreleri, lisans).
- `stft.js` — karışık tabanlı (2/3/4/5) Stockham FFT; n_fft'ler 2'nin kuvveti değil (7680 = 2⁹·3·5). İki kanal tek
  karmaşık FFT'ye paketlenir. STFT→ISTFT gidiş-dönüş hatası ~1.5e-8. Bir 5.92 sn'lik pencerenin STFT + ISTFT'si
  ~150 ms (JS, tek çekirdek); WebGPU'da model çalışırken bir sonraki pencerenin STFT'si hazırlanır.
- `resample.js` — çok fazlı Kaiser pencereli sinc (48 ↔ 44.1 kHz, 30 sn ~160 ms).
- `separator.js` — `createSeparator({ model, backend, onProgress, overlap, batch, denoise })` →
  `{ load(), process(left, right, sampleRate), backend, model, contextSec, chunkSec, dispose() }`; `joinOverlap()`.
- `worker.js` — işçi sözleşmesi (aşağıda); `client.js` — Promise istemcisi + 90 sn çok iş parçacığı bekçisi.
- `extension/engines/_mock/sep.js` — aynı sözleşmeli sahte işçi (çıktı = giriş × 0.5).

### İç parçalama

Giriş 44.1 kHz'e çevrilir, iki ucu `(1 − overlap) · 5.92 sn` sıfırla dolgulanır, 5.92 sn'lik pencerelere
`overlap` (varsayılan 0.5) örtüşmeyle bölünür; her pencerenin çıktısı Hann ağırlığıyla toplanıp ağırlık toplamına
bölünür. Pencere kenarlarındaki STFT bozulması bu ağırlıkla bastırılır, çağrı içinde dikiş duyulmaz. `overlap 0.25`
işlemi 1.5× azaltır (kalite biraz düşer); `denoise` (UVR: model(x) ile −model(−x) ortalaması) işlemi 2× artırır.

### Çağrılar arası birleşme (`contextSec`)

Model, bir çağrının kenarında bağlamı (geleceği/geçmişi) göremez. Ardışık çağrılar **2 · contextSec** (1 sn → 2 sn)
örtüşmeli ve `joinOverlap(prev, next, overlapSamples, FADE_SEC·sr)` ile örtüşmenin ortasından 50 ms çapraz geçişle
birleştirilmelidir:

```
çağrı k   : [ ………… yeni ses ………… | son 2·C ]
çağrı k+1 :                        [ son 2·C | ………… yeni ses ………… ]
birleşim  : prev[.. ortası] ↔ next[ortası ..]   (C = contextSec = 1 sn)
```

Bir çağrının son `contextSec` saniyesi bir sonraki çağrı gelene kadar kesin sayılmaz (ek gecikme 1 sn).

Ölçüm (Kim Vocal 2, 16 sn gerçek müzik + konuşma, tek çağrıya göre SNR; "dikiş" = birleşme noktası ±0.1 sn,
"çevre" = ±3 sn):

| bağlam | 0 (düz ekleme) | 0.25 sn | 0.5 sn | 1 sn | 1.5 sn |
|---|---|---|---|---|---|
| dikiş | 27.6 dB | 29.3 dB | 39.9 dB | 37.0 dB | 31.3 dB |
| çevre | 30.4 dB | 34.8 dB | 35.2 dB | 32.2 dB | 32.3 dB |

≥ 0.5 sn bağlamla dikiş çevresinden kötü değil. "Çevre" değerinin ~30–35 dB'de kalması modelin kendi ızgara
duyarlılığı: tek çağrının çıktısı da iç pencerelerin nereye düştüğüne bağlı (aynı ses farklı başlangıçla verilince
çıktı bu kadar değişir). Bu fark eşliğin kendi hatasının (SDR ~18 dB) 12+ dB altında, duyulmaz.

## İşçi sözleşmesi (`worker.js`)

```
→ { type:'load', id, model?:'auto'|<id>, backend?:'webgpu'|'wasm'|'auto', threads?, overlap?, batch? }
← { type:'progress', id, loaded, total }*                        (indirme sırasında)
← { type:'loaded', id, backend, model, contextSec, chunkSec }  | { type:'error', id, message }
→ { type:'process', id, left:Float32Array, right?:Float32Array, sampleRate }   (buffer'ları transfer edin)
← { type:'result', id, left, right, ms, backend }   (transfer)  | { type:'error', id, message }
→ { type:'dispose', id? }                                        ← { type:'disposed', id }
```

İstekler sırayla işlenir. `threads` varsayılanı: crossOriginIsolated ise çekirdeklerin yarısı (en çok 4), değilse 1;
ilk yüklemede sabitlenir. `client.js` çok iş parçacıklı yükleme indirme bittikten 90 sn sonra hâlâ bitmediyse işçiyi
tek iş parçacığıyla yeniden başlatır (TTS'teki ort 1.22 askısı).

## Ölçümler

Karışım: `tests/extension/fixtures/*.wav` konuşmaları (16 kHz → 48 kHz, merkezde) + müzik, konuşmalı bölümlerde
0 dB konuşma/müzik oranı, 48 kHz stereo. SDR = 10·log10(|müzik|² / |eşlik − müzik|²); kalıntı = eşlikteki konuşma
bileşeninin girişe oranı; "sessiz" = konuşmasız bölümlerde müziğin bozulması. İşlem yapılmamış karışım: SDR ≈ 1.6 dB.

**Gerçek müzik** (MUSDB18 7 sn önizlemelerinin 5 test parçasının vokalsiz eşliği, `--music`; yerel ölçüm, depoya
eklenmedi), 30 sn:

| model | SDR | kalıntı | sessiz bölüm | RTF (onnxruntime-node, 4 çekirdek CPU) |
|---|---|---|---|---|
| kim-vocal-2 | **18.14 dB** | **−33.5 dB** | **37.6 dB** | 1.10 |
| voc-ft | 18.15 dB | −32.3 dB | 37.6 dB | 0.99 |
| inst-hq-3 | 17.90 dB | −32.5 dB | 33.6 dB | 1.07 |
| inst-hq-5 | 18.07 dB | −32.3 dB | 32.2 dB | 0.83 |
| mdxnet-lite | 16.79 dB | −34.0 dB | 35.3 dB | 0.41 |

**Sentetik müzik** (betiğin kendi davul/bas/akor/arpeji, depodan yeniden üretilebilir), 20–30 sn: kim-vocal-2
SDR 19.5–19.8 dB, kalıntı −37/−38 dB; voc-ft 19.55; inst-hq-3 19.19; inst-hq-5 19.18; mdxnet-lite 18.0 dB.

**Hız — tarayıcı WASM (bu konteyner, GPU yok)**: Chromium, module Worker, onnxruntime-web 1.22 WASM, 4 iş parçacığı,
crossOriginIsolated, 30 sn stereo 48 kHz (`tests/extension/e2e/sep-worker.e2e.cjs`):

| model | işlem | RTF |
|---|---|---|
| kim-vocal-2 | 114.9 sn | **3.83** (gerçek zamanlı değil) |
| mdxnet-lite | 39.2 sn | **1.31** (overlap 0.25 ile ≈ 0.87 beklenir) |

Model yükleme (önbellekten, ısınma çalıştırması dahil) 6–16 sn. 12 sn'lik çağrıda kenar dolgusu yüzünden RTF daha
kötü (kim-vocal-2: 5.0); WASM'da uzun çağrılar tercih edilmeli.

**Hız — WebGPU (TAHMİN, ölçülmedi)**: bir pencere 379 GMAC ≈ 0.76 TFLOP; overlap 0.5'te ses saniyesi başına
~0.26 TFLOP gerekir. ORT-web WebGPU'nun fp32 evrişimlerde tepe gücün ~%15–30'unu kullandığı varsayımıyla:

| donanım (fp32 tepe) | pencere başına | RTF (overlap 0.5) | RTF (overlap 0.25) |
|---|---|---|---|
| RTX 5060 (~19 TFLOPS) | ~0.15–0.3 sn | ~0.05–0.1 | ~0.03–0.07 |
| Mac mini M4, 10 çekirdek GPU (~4.3 TFLOPS) | ~0.6–1.2 sn | ~0.2–0.4 | ~0.13–0.27 |

WebGPU yolu bu konteynerde doğrulanamadı: GPU yok, SwiftShader'lı yazılım WebGPU'sunda 6 sn'lik bir çağrı 15 dakikada
bitmedi (yavaşlık mı askı mı ayırt edilemedi). Bunlar tahmindir; gerçek değer `xvfb-run -a node tests/extension/e2e/sep-worker.e2e.cjs --webgpu` ile (GPU'lu bir
makinede, `--use-webgpu-adapter=swiftshader` bayrağı kaldırılarak) ölçülmeli. JS tarafı (STFT/ISTFT, yeniden
örnekleme) pencere başına ~0.15 sn ve WebGPU çalışırken paralel hazırlanır.

## Bilinen sınırlar

- Vokal modelleri müzikteki **şarkı sözlerini de** konuşma gibi çıkarır (şarkılı sahnede eşlik enstrümantale döner).
- Modeller müzik verisiyle eğitildi; kalabalık uğultusu, tezahürat, çocuk sesi, konuşmaya benzeyen efektler kısmen
  "vokal" sayılabilir. Sinema sesi için eğitilmiş (DnR) bir model daha doğru olurdu ama tarayıcıda gerçek zamanlı
  çalışanı yok (bkz. TIGER).
- Kim Vocal 2 17.6 kHz üstünü işlemez: eşlikte o bantta konuşmanın tıslamaları ("s", "ş") az miktar kalır.
- Yankı/oda sesi kısmen kalır (vokal modelleri kuru vokali hedefler).
- WASM'da varsayılan model gerçek zamanlı değil; GPU'suz makinede `mdxnet-lite` + `overlap 0.25` ya da önden
  (oynatmanın ilerisinde) işlem gerekir.
- Bellek (tahmin, ölçülmedi): model oturumu ~150–300 MB (67 MB fp32 ağırlık + ara tensörler), pencere başına 2 × 12.6 MB tensör; 30 sn'lik bir
  çağrı ek ~40 MB JS belleği kullanır.
- Ölçümler sentetik ve MUSDB müziğiyle; gerçek film/vlog efektleriyle nesnel ölçüm yapılmadı.

## Yeniden üretme

```
cd tests/tts && ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci && cd ../..
node tools/sep-bench.mjs --model all --seconds 30            # modelleri tests/extension/.models/sep'e indirir
node tools/sep-bench.mjs --model kim-vocal-2 --seam          # çağrılar arası birleşme
node tools/sep-bench.mjs --music muzik.wav --out /tmp/sep    # kendi müziğinle; WAV'ları dinlemek için
node --test tests/extension/sep.test.mjs
xvfb-run -a node tests/extension/e2e/sep-worker.e2e.cjs --seconds 30 --model kim-vocal-2
```
