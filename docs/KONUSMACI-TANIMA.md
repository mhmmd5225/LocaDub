# Konuşmacı tanıma ile kadın/erkek sesi: ölçüm

Otomatik kadın/erkek sesi eskiden cümle başına perde (F0) ortancasına bakıyordu; gerçek videolarda aynı konuşan kadın ile erkek sesi arasında
geçiyordu. Yeni yöntem (`extension/engines/spk`, `extension/content/gender.js` `SpeakerClusters`): her cümlenin sesinden konuşmacı
vektörü (WeSpeaker ResNet34-LM, 26 MB, CC-BY-4.0; ONNX: `csukuangfj/speaker-embedding-models`), çevrimiçi kümeleme, küme başına cinsiyet.
Ses kaynağı: ses ayırma açıksa ayrılmış temiz konuşma (`separation.speechAt`, cümle çalmadan önce), değilse orijinal ses.

**Karar:** otomatik kadın/erkek yalnız ses ayırma çalışırken etkindir (ayırma yokken tek ses).

## Ölçüm

Veri: `node tools/spk-data.mjs --libri <LibriSpeech kökü>`; ölçüm: `node tools/spk-eval.mjs --dialogues 80 --seed 1`.
80 diyalog, 1501 cümle; kaynak: `tts` (eklentinin kendi sesleri), `libri` (LibriSpeech, gerçek insan konuşması), `all` (ikisi).
Müzik sentetik (akor, bas, davul, kadın perdesi aralığında melodi: perde ölçümü için en zor durum).

Sütunlar:
- `cins.çalınan`: dublajda duyulan sesin cinsiyet doğruluğu (cümle çalarken bilinenle)
- `cins.son`: cümle bittikten sonraki karar
- `cins.kişi`: konuşmacı başına doğruluk
- `tutarlılık`: aynı gerçek konuşmacının cümlelerinin en sık sesi alma payı
- `değişim`: aynı konuşmacının ardışık cümlelerinde ses değişme oranı
- `saflık`: küme saflığı; `karışık`: karışık cinsiyetli küme sayısı; `küme/kişi`: küme sayısı / gerçek konuşmacı sayısı

```
koşul                          kaynak  yöntem               cins.çalınan cins.son  cins.kişi  tutarlılık küme.tut  değişim  saflık  karışık küme/kişi
temiz (ayırma: speechAt)       all     eski                       74.8%     92.3%     74.9%      81.1%        —    27.2%       —       — —
temiz (ayırma: speechAt)       all     yeni (perde+sınıf.)        96.3%     97.1%     95.5%      92.6%    95.2%    10.1%   95.2%       4 0.95
temiz (ayırma: speechAt)       tts     eski                       77.1%     95.5%     78.9%      81.6%        —    27.8%       —       — —
temiz (ayırma: speechAt)       tts     yeni (perde+sınıf.)        94.8%     96.3%     94.4%      88.9%    91.8%    17.1%   92.2%       2 0.88
temiz (ayırma: speechAt)       libri   eski                       72.4%     89.0%     70.8%      80.6%        —    26.6%       —       — —
temiz (ayırma: speechAt)       libri   yeni (perde+sınıf.)        97.7%     97.9%     96.6%      96.4%    98.7%     3.0%   98.0%       2 1.02
ayırma kalıntısı −20 dB        all     eski                       75.5%     92.6%     74.3%      81.3%        —    26.9%       —       — —
ayırma kalıntısı −20 dB        all     yeni (perde+sınıf.)        96.7%     97.3%     95.5%      93.5%    96.5%     8.8%   96.1%       3 0.99
ayırma kalıntısı −20 dB        libri   yeni (perde+sınıf.)        98.3%     98.3%     96.6%      96.4%    98.9%     2.7%   99.1%       1 1.02
müzik −10 dB (ayırma yok)      all     eski                       74.1%     90.5%     74.9%      80.7%        —    25.9%       —       — —
müzik −10 dB (ayırma yok)      all     yeni (perde+sınıf.)        75.5%     96.7%     73.7%      61.4%    96.5%    56.3%   96.3%       3 1.02
müzik −6 dB (ayırma yok)       all     eski                       70.4%     83.5%     69.3%      79.4%        —    24.4%       —       — —
müzik −6 dB (ayırma yok)       all     yeni (perde+sınıf.)        74.6%     95.2%     74.3%      60.3%    95.9%    56.5%   96.7%       3 1.06
müzik 0 dB (ayırma yok)        all     eski                       49.8%     50.0%     49.2%      98.0%        —     2.0%       —       — —
müzik 0 dB (ayırma yok)        all     yeni (perde+sınıf.)        51.9%     51.6%     50.3%      58.4%    96.0%    57.9%   97.9%       1 1.08
```

(Tablo özetlenmiştir: yalnız eski yöntem ile "perde+sınıflandırıcı" yeni yöntem, `all` ve ayırma açıkken `tts` / `libri`.
Tüm satırlar için `tools/spk-eval.mjs` çalıştırılır.)

## Okuma

- Ayırma açık, gerçek insan konuşması (`libri`, temiz): yeni yöntem doğru cinsiyet %97.7, tutarlılık %96.4, ses değişimi %3;
  eski yöntem %72.4 / %80.6 / %26.6. Hedefler (tutarlılık ≥ %95, cinsiyet ≥ %90) tutuyor.
- Sentetik sesler (`tts`): tutarlılık %88.9, hedefin altında; sentetik sesler birbirine ve perde sınırına yakın.
- Ayırma kapalı (müzik altında orijinal ses): değerlendirmedeki "çalınan" ses, cümle çalarken önceki cümlenin kümesinden tahmin edilir
  (erken karar yok), bu yüzden tutarlılık ≈ %60'a düşer; bu yüzden ayırma yokken otomatik kadın/erkek kapalıdır.
- Müzik 0 dB'de hiçbir yöntem çalışmaz (cinsiyet ≈ %50).

## Konuşmacıya benzeyen ses (0.5.6)

Her konuşmacı kümesine, ortanca perdesine en yakın **indirilmiş** ses atanır (`common/voice-match.js`); gerekirse en çok
±2 yarım tonluk perde ayarıyla. Atama küme ≈ 3 sn ötümlü konuşma (60 perde çerçevesi) topladıktan sonra bir kez yapılır ve
video boyunca değişmez; aynı cinsiyetten ikinci konuşmacıya, neredeyse aynı yakınlıkta başka bir aday varsa farklı ses verilir.
Bir cinsiyette ikiden az aday varsa o cinsiyette eski kural (cinsiyet sesi, favori) geçerlidir. Ayar: `matchVoices` (varsayılan açık).

Seslerin perde profili (`engines/tts/voices.js` `f0`) ve seçimin ölçümü: `node tools/voice-match.mjs` (veri: `tools/spk-data.mjs`).
80 LibriSpeech konuşmacısı, seçim ilk 7 cümleyle, ölçüm kalan 7 cümleyle (perde farkı, yarım ton):

| Yöntem | Ortanca fark | ≤ 1 yarım ton | ≤ 2 yarım ton |
|---|---|---|---|
| Varsayılan cinsiyet sesi (Ahenk / Antalia) | 2.0 | %25 | %55 |
| Benzeyen ses (13 ses: küçük sesler + Supertonic) | 1.0 | %55 | %84 |

**Neden perde, neden konuşmacı vektörü değil:** İlk denemede seçim konuşmacı tanıma vektörünün (WeSpeaker) benzerliğiyle
yapıldı; ölçüde varsayılandan çok iyi görünüyordu (kosinüs 0.04 → 0.22) ama dinleme testinde kulakla uyuşmadı (kadın konuşmacıya
perdesi daha uzak bir ses, ince sesli erkeğe daha kalın bir ses seçti). Kimlik vektörü perdeye büyük ölçüde duyarsızdır; kulağın
"benziyor" dediği şey en çok perde ve parlaklıktır. Parlaklık (spektral merkez) ayrılmış seste müzik kalıntısından etkilendiği için
yalnız perde kullanılır.

**Ses kopyalama (voice cloning) denendi, eklenmedi.** Aynı veride (4 hedef konuşmacı, 8 Türkçe cümle; benzerlik WeSpeaker,
anlaşılırlık Whisper CER; işlemci 4 çekirdek):

| Yöntem | Benzerlik (tavan 0.90) | CER | Süre / ses süresi | İndirme |
|---|---|---|---|---|
| kNN-VC (WavLM + HiFi-GAN), 30 sn örnek, fp32 | 0.45 | %0.9 | 0.25 | 451 MB |
| kNN-VC, 30 sn örnek, 8-bit | 0.35 | %2.2 | 0.89 | 124 MB |
| kNN-VC, 10 sn örnek, 8-bit | 0.32 | %23.7 | 1.01 | 124 MB |
| Chatterbox ses dönüştürme, 10 sn örnek | 0.47 | %0.4 | 3.2 | 1.08 GB |
| Chatterbox çok dilli TTS (Türkçe), 10 sn örnek | 0.51 | %7.9 | 3.9 | 1.4 GB |

Dinleme testinde: kNN-VC "yaklaşık %25 benziyor"; Chatterbox ses dönüştürme sesin rengini taşıyor ama tonlama kaynak TTS'inki
kadar düz; Chatterbox Türkçe TTS yabancı aksanlı (ONNX sürümünün sözlüğünde ş/ğ/İ yok, birleşik işaretlere ayrılarak çalıştırıldı).
Büyük indirme ve (Windows'ta sürücü çökmesi yaşanmış) GPU yükü karşılığında kazanç yetersiz bulundu. Orijinal konuşmacının
tonlamasını taşımak ayrı ve daha zor bir sorundur (konuşma İngilizce, dublaj Türkçe).
