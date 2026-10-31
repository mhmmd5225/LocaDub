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
- `resample.js` — çok fazlı Kaiser pencereli sinc (48 ↔ 44.1 kHz, 30 sn ~160 ms); `StreamResampler`: aynı formül
  mutlak örnek ızgarasında, parça parça (ardışık push'lar tek `resample()` ile örneği örneğine aynı).
- `separator.js` — `createSeparator({ model, backend, onProgress, overlap, batch, denoise })` →
  `{ load(), process(left, right, sampleRate, o?), backend, model, batch, contextSec, chunkSec, stepSec, stats,
  resetStream(), dispose() }`; `joinOverlap()`. `o = { startSample, final?, reset?, isCancelled? }` akış kipidir
  (aşağıda). `batch` verilmezse WebGPU'da 4, WASM'da 1; WebGPU'da batch 4 oturumu kurulamazsa önce batch 1 denenir.
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

### Akış kipi (sürekli pencere ızgarası)

İçerik betiği eskiden 12 sn'lik işleri iki yanda 1 sn bağlamla gönderiyordu; ayırıcı her çağrıda pencereleri
yeniden diziyor ve iki ucu ≈ 3 sn sıfırla dolguluyordu: 12 sn ses için 6 pencere (≈ 3× ses süresi model işi), üstüne
iki çağrının birleşme yerinde ızgara farkı. Akış kipinde (`process(L, R, sr, { startSample })`, `startSample` = girdinin
ilk örneğinin mutlak dizini, medya zamanı · sampleRate) pencereler **mutlak** model ızgarasında (44.1 kHz,
k · adım) durur; ayırıcı bekleyen ağırlıklı toplamları (+ ağırlık toplamlarını), sonraki pencerenin girdisini ve iki
durumlu yeniden örnekleyiciyi tutar. Her çağrı yalnızca **kesinleşen** aralığı döndürür (o örneği örten bütün
pencereler bitti): `{ left, right, startSample, windows, reset, final }`.

- Ardışık çağrıların çıktısı aynı girdinin tek çağrısınınkiyle **örneği örneğine aynıdır** (sahte modelle birim testi:
  fark 0; gerçek modelle tarayıcıda: aşağıda). Dikiş yok, bağlam yok, model işi ≈ 1 / (1 − overlap) = 2× ses süresi.
- Gecikme: çıktı girdinin (pencere − adım) … pencere (2.96–5.92 sn) gerisindedir; içerik tarafı bunu bilip girdiyi
  pencere sonlarına hizalı gönderir (her iş tam `batch` katı pencere çalıştırır, son grup boş kalmaz).
- Kesinti (startSample bitişik değil, örnek hızı değişti, `reset`) akışı sıfırlar: yeni akışın başında öncesi sıfır
  sayılır; içerik tarafı ilk `contextSec`'i kırpar ve önceki parçayla 50 ms çapraz geçişle ekler (eski yol).
- `final`: girdi sonrası sıfır sayılıp kalan her şey kesinleşir (video sonu ya da önceden ayrılmış parçaya varış;
  sağ bağlam 1 sn), akış biter.
- Eski tek parça kipi (startSample yok) aynen duruyor (bench, testler).

## İşçi sözleşmesi (`worker.js`)

```
→ { type:'load', id, model?:'auto'|<id>, backend?:'webgpu'|'wasm'|'auto', threads?, overlap?, batch? }
← { type:'progress', id, loaded, total }*                        (indirme sırasında)
← { type:'loaded', id, backend, model, contextSec, chunkSec, stepSec, batch, overlap, streaming:true }
     | { type:'error', id, message }                             (chunkSec = model penceresi 5.92 sn)
→ { type:'process', id, left:Float32Array, right?:Float32Array, sampleRate, startSample?, final?, reset? }
← { type:'result', id, left, right, ms, backend, windows, startSample?, reset?, final? }  (transfer)
     | { type:'error', id, message }                             (iptal: message 'cancelled')
→ { type:'cancel', ids }        sıradaki işler hiç başlamaz, süren iş pencere grupları arasında durur (akış sıfırlanır)
→ { type:'dispose', id? }                                        ← { type:'disposed', id }
```

İstekler sırayla işlenir; içerik tarafı iki işi art arda gönderir, ikincisi birincinin hemen ardından başlar. `threads` varsayılanı: crossOriginIsolated ise çekirdeklerin yarısı (en çok 4), değilse 1;
ilk yüklemede sabitlenir. `client.js` çok iş parçacıklı yükleme indirme bittikten 90 sn sonra hâlâ bitmediyse işçiyi
tek iş parçacığıyla yeniden başlatır (TTS'teki ort 1.22 askısı).

## İçerik tarafı: boru hattı ve bekletme (`content/separation.js`, `content/sep-core.js`)

- **Planlama** (`planStream`): oynatma konumundan sonraki ayrılmamış ilk nokta akışın kesinleşecek sonuysa akış
  sürer (girdi = gönderilmiş girdinin sonundan, tam pencereler), değilse yeni akış (1 sn sol bağlamla). Parça:
  WebGPU'da ≈ 24 sn (8 pencere = 2 × batch 4), WASM'da ≈ 12 sn; yeni akışın ilk parçası 8 sn (hızlı başlangıç, rtf
  erken ölçülür). Sonraki ayrılmış parçaya ya da video sonuna varınca `final` iş.
- **Boru hattı**: aynı anda 2 iş. Her işin çözmesi hemen başlar, gönderimi bir önceki işin gönderiminden sonradır
  (akış sırası korunur). Atlamada artık gereksiz işler `cancel` ile bırakılır (24 sn'lik işler yeni konumu
  bekletmesin). rtf = işçinin işlem süresi / gönderilen girdi süresi (üstel ortalama).
- **Bekletme** (`HoldGate`, kalite sabit: model/örtüşme düşürülmez, yetişmezse beklenir). Ayrılmış ses parça parça
  gelir; bir sonuç beklenirken hazır süre parça · rtf kadar düşer ("dip").
  - Başta: gereken = rtf < 1 biliniyorsa min(prebufferSec, 2 + dip + 1), değilse prebufferSec. Gereken dolunca hemen
    sürer. prebufferSec dolduğunda rtf < 1 ve iş sürüyorsa gereken dolana dek (en çok 60 sn fazladan) bekler; rtf
    bilinmiyor ya da ≥ 1 ise olağan kurala geçer (bekletme sürme eşiğine dek sürer — oynatıp birkaç saniye sonra
    yeniden durmak yerine).
  - Oynarken ayırma darboğazsa: hazır < 2 sn → beklet; sürme eşiği rtf < 0.9 iken max(8, 2 + dip + 1), rtf ≥ 0.9
    iken **30 sn** (kalan süreyle sınırlı): bekleme seyrek ama uzun. Girdi darboğazında (YouTube indirmedi)
    bekletilmez.
- **Durum** (`state` olayı; panel ve tanılama bu adları kullanır): `status, backend, model, aheadSec, cachedRanges,
  progress, rtf, message` + `etaSec` (bekletme sürüyorsa tahmini kalan sn: bekletmede ayrılmış ses 1/rtf sn/sn
  büyür → (needSec − aheadSec) · rtf; yoksa null), `needSec` (sürme hedefi), `holds` (başlangıç sonrası oynatma
  bekletmesi sayısı), `holdMs` (toplam bekletilen ms, başlangıç dahil), `batch`, `chunkSec` (iş başına ses),
  `streaming`.
- **`speechAt(t0, t1)`** → `{ left, right, sampleRate } | null`: medya zamanı [t0, t1) için temiz konuşma = ayırmaya
  gönderilmiş orijinal PCM − ayrılmış eşlik. İkisi o aralığın tamamında yoksa null (ek çözme yapılmaz). Konuşan
  tanıma cümle çalmadan önce ölçebilsin diye: ayrılmış ses genelde oynatma konumunun ≥ 15 sn ilerisindedir. Bellek:
  orijinal geride 5 sn, ileride işlenecek pencere kadar (≈ 1 dk @ 48 kHz stereo ≈ 23 MB).

### "Aktif olduktan birkaç saniye sonra yeniden bekliyor" (v0.5.0, kök neden)

1. Sürme eşiği (8 sn) bir sonucun dibinden küçüktü: tek iş uçuştayken 12 sn'lik bir sonuç 12 · rtf + çözme/aktarım
   sürede geliyordu; rtf ≈ 1'de 8 sn hazırla sürülen video bir sonraki sonuçtan önce 2 sn'nin altına düşüp yeniden
   duruyordu ("ses ayırma geride kaldı", araya orijinal sesli "hazırlanıyor"). Artık eşik dibi kapsıyor ya da
   rtf ≥ 0.9'da 30 sn.
2. `HoldGate.initial` tek bir karede `pending` yanlış olunca (YouTube bir sonraki ses parçasını henüz eklememiş,
   planlayıcı acil değilken tam parçayı bekliyor) ön tampon dolmadan bitiyor, video 8–12 sn hazırla sürüyordu. Artık
   girdi boşluğu başlangıç evresini bitirmiyor.
3. Başlangıç süresi model yükleme/ısınmayı da sayıyordu; süre dolunca hazır az olsa da sürüyordu. Artık rtf < 1
   biliniyorsa gereken hazır süre dolana dek beklenir.
`app.js`'teki `_tickHold` ile etkileşimde hata bulunmadı: iki bekletme birbirinin videosunu sürdürmüyor
(`otherHold` / `separation.holding`). Düğmenin "hazırlanıyor"a dönmesi ayrıca `prepStatus` (TTS ileri bakışı)
kaynaklı olabilir; o ayırmadan bağımsızdır.

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

Not: yukarıdaki RTF'ler ses saniyesine düşen ideal (2×) pencere işiyle hesaplandı. v0.5.0'ın içerik tarafı ise 12 sn
+ 2·1 sn bağlamla 6 pencere / 12 sn (≈ 3×) çalıştırıyor, tek iş uçuşta olduğu için çözme/aktarım/STFT arasında GPU
boşta kalıyordu.

### Akış kipi: ölçülen kazanç

**Model işi** (ses saniyesi başına pencere, overlap 0.5, adım 2.96 sn):

| yol | pencere / ses sn | model işi / ses süresi |
|---|---|---|
| v0.5.0 (12 sn + 2·1 sn bağlam, her çağrı yeniden dizilir) | 0.500 | 2.96× |
| akış, kararlı durum | 0.338 (= 1/adım) | 2.0× |
| akış, 36 sn'lik ölçüm (akış başı + `final` dahil) | 0.389 | 2.3× |

**Gerçek model, tarayıcı WASM (bu konteyner, GPU yok)**: Kim Vocal 2, 4 iş parçacığı, 36 sn stereo 48 kHz, 12 sn'lik
işler (`SEP_REAL=1 xvfb-run -a node tests/extension/e2e/sep-worker.e2e.cjs --stream-seconds 36`):

| yol | pencere | işlem | duvar RTF |
|---|---|---|---|
| eski (12 + 2·1 sn bağlam) | 18 | 339.6 sn | 9.44 |
| akış (iki iş art arda) | 14 | 267.1 sn | 7.42 |

Hızlanma 1.29× (pencere) / 1.27× (duvar); uzun oturumda kararlı durum oranına (1.48×) yaklaşır. **Eşitlik**:
12 sn'lik parçalarla işlenen akışın çıktısı tek akış çağrısınınkiyle **birebir aynı** (SNR ∞, fark 0); sahte
modelle birim testinde de (48 ve 44.1 kHz, farklı batch, rastgele parça sınırları) fark 0. Bu konteyner bu ölçümde
önceki ölçümden yavaştı (aynı 12 sn tek çağrı RTF 9.46 ↔ önceden 5.0; paylaşılan CPU), oranlar karşılaştırılabilir.
WASM'da tek CPU kaynağı olduğundan boru hattı ek hız getirmez; WebGPU'da çözme + aktarım + STFT model çalışırken yapılır.

**Batch**: WebGPU'da varsayılan 4 (`load({ batch })` ile değiştirilebilir; çıktı pencere başına, gruplamadan bağımsız
— testle denetlendi). 2/4/8 bu konteynerde ölçülemedi (GPU yok); 4, M4'ün bellek payı ile çekirdek doluluğu arasında
güvenli bir varsayım. Oturum batch 4 ile kurulamazsa batch 1 denenir, o da olmazsa WASM.

**Mac mini M4 için beklenti (TAHMİN, ölçülmedi)**: kullanıcı raporu v0.5.0'da etkin rtf ≈ 1 (ayırma yetişmiyor)
gösteriyor. Aynı kaliteyle: pencere işi 1/1.48, iş arası GPU boşluğu kalkar (2 iş uçuşta), batch 4 ile çekirdek
doluluğu artar (tahmini %10–30). Beklenen rtf ≈ 0.5–0.7 → başlangıçta gereken ön tampon ≈ 2 + 24·rtf + 1 ≈ 15–20 sn
(prebufferSec ile sınırlı), sonra durma yok. rtf yine ≥ 0.9 çıkarsa durmalar 30 sn hedefle seyrek olur (rtf 0.95'te
≈ 9 dk'da bir ~27 sn; rtf 1.3'te ≈ 2 dk'da bir ~36 sn) ve panelde `etaSec` ile kalan süre görünür.

**Bekletme (e2e, sahte ayırıcı, `tests/extension/e2e/separation.e2e.cjs`)**: rtf 0.7 → 20 sn ön tamponla başladı,
35 sn oynatmada hiç durmadı (holds 0); rtf 1.3 → başta 30 sn hazır olana dek bekledi (eta ≈ 28 sn bildirildi),
sonraki 75 sn'de durma yok.

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
node tools/sep-bench.mjs --model kim-vocal-2 --stream        # akış kipi: pencere/sn, RTF, tek çağrıya SNR
node tools/sep-bench.mjs --music muzik.wav --out /tmp/sep    # kendi müziğinle; WAV'ları dinlemek için
node --test tests/extension/sep.test.mjs
xvfb-run -a node tests/extension/e2e/sep-worker.e2e.cjs --seconds 30 --model kim-vocal-2
SEP_REAL=1 xvfb-run -a node tests/extension/e2e/sep-worker.e2e.cjs --stream-seconds 36   # akış ↔ eski yol
xvfb-run -a node tests/extension/e2e/separation.e2e.cjs     # bekletme senaryoları (SEP_E2E_QUICK=1: kısa)
```
