# Performans ve stabilite raporu (0.5.2)

Bu rapor ölçülenleri, tahmin edilenleri ve koddan çıkan stabilite bulgularını ayırır. Yol haritası: `docs/YOL-HARITASI.md`.

## Durum özeti
- 0.5.2 yayında (GitHub Pages). Kod ≈ 12.9 bin satır: content 5.8k, MT 1.9k, TTS 1.9k, ses ayırma 1.2k, konuşmacı 0.5k, ayarlar 1.5k, popup 0.4k.
- Test: 160 birim testi (2.6k satır), 15 e2e; hepsi geçiyor.
- M4'ten gelen tanılama raporunda **hata yok**. Ses ayırma sonucu çok iyi; ancak gerçek zamana yetişemeyebiliyor ve ara sıra
  "hazırlanıyor"a dönebiliyordu. 0.5.1'de üç neden düzeltildi (devam eşiği, YouTube girdi boşluğu, model yükleme süresinin sayılması).

## Ölçülenler
| Alan | Ölçüm | Kaynak |
|---|---|---|
| Başlangıç (M4, gerçek rapor) | aktif 4.5 / 6.0 / 12.6 sn; ilk çeviri 0.8–3.2 sn; ilk ses 4.4–12.6 sn; video 4.4–11.4 sn bekletildi | kullanıcı tanılama raporu |
| Ses ayırma, Kim Vocal 2, WASM (4 çekirdek, konteyner) | RTF 3.8–4.3 (gerçek zamandan ≈ 4× yavaş) | `docs/SES-AYIRMA.md` |
| Akış kipi kazancı | model işi ≈ 3× → 2× ses süresi (≈ 1.5× daha az pencere); çıktı birebir aynı (SNR ∞) | `docs/SES-AYIRMA.md` |
| Konuşmacı gömme | ≈ 110 ms / 3 sn'lik cümle (tek iş parçacığı) | `tools/spk-eval.mjs` |
| Cinsiyet isabeti (ayırma açık, gerçek konuşma) | %97.7; tutarlılık %96.4; ses değişimi %3 | `docs/KONUSMACI-TANIMA.md` |
| İndirilenler | MT 286 MB, Supertonic 200 MB, Antalia 22, Ahenk 17, EMA 33, ayırma 67 (hafif 30), konuşmacı 26 → toplam ≈ 650 MB | rapor + katalog |

## Tahmin edilenler (ölçülmedi, cihazda doğrulanmalı)
- WebGPU ayırma hızı: RTX 5060 ≈ 0.05–0.1 RTF, M4 ≈ 0.2–0.4 RTF. M4'te yetişemediği gözlendi; tahmin iyimser.
- WebGPU `batch` = 4 varsayımı; 1/2/4/8 hiç ölçülmedi.
- AAC (mp4) sesli videolar, gerçek YouTube sekmesinde `diag.separation` raporu, Windows/RTX davranışı.

## Stabilite bulguları (koddan)
1. **Sessiz hata yutma:** ≈ 50 adet `catch {}` (main-world 8, app 6, player 5, background 4, separation 4, panel 4, range-cache 4, offscreen 3…).
   Bir kısmı zararsız (`revokeObjectURL`), ama motor/ağ/ses yollarında hata görünmez; "Son hatalar" bölümü boş kalır.
2. **Boşta CPU:** `app.js` her 100 ms tick, `separation.js` her 100 ms tick, `_samplePitch` her 50 ms (konuşmacı yolu açıkken erken döner ama
   zamanlayıcı sürer), 15 sn'de bir kalıcı yazma. Sekme gizliyken de aynı.
3. **Bellek sınırları var ama ölçülmüyor:** MAIN-world kopya 32 MB/kaynak (≈ 30 dk opus); PacketStore 300 sn geri; ayrılmış **ve orijinal** PCM 15 sn geri
   (konuşmacı tanıma için ikisi de tutulur; ölçüm, sahte ayırıcı: 67 sn PCM ≈ 26 MB → ≈ 0.38 MB/sn); cümle sesleri 90 sn geri / 120 sn ileri. Raporda bellek bilgisi yok.
4. **Güncelleme denetimi bozuk:** eklenti `https://localdub.mhmmd.app/version.json`'a bakıyor; orası 0.2.1'de takılı (Netlify kredi / DNS).
   Kurulu eklentiler 0.5.x güncelleme şeridini göremez. Yedek adres yok.
5. **Servis işçisi / offscreen yeniden başlaması:** belgelerde "ilk istek zaman aşımına uğrayabilir" notu var; otomatik test yok.
6. **Kararsız test → gerçek hata (0.5.3'te düzeltildi):** `speaker-voices` e2e'si yük altında takılıyordu; neden, başlangıç bekletmesinden sonra
   gelen gecikmeli `play` olayının bekletmeyi bitirip videoyu duraklatılmış bırakmasıydı (kullanıcı için de geçerli).
7. **Soak testi yok:** art arda seek, reklam, SPA gezinmesi, oynatma hızı değişimi dizilerinde bellek/olay sızıntısı otomatik denenmiyor.
8. **Bilinen sınırlar:** reklam sonrası ayırma baştan; 1x dışı hızda ayırma kapalı; DRM / canlı yayın desteklenmiyor; sentetik seslerde
   konuşmacı tutarlılığı %89; ayırma kapalıyken otomatik kadın/erkek kapalı.

## GPU güvenliği bulgusu (0.5.4, kullanıcı raporu: RTX 5060 / Windows)
**Belirti:** Hız testi sırasında ekran gidiyor (sürücü sıfırlanıyor), ses işleme sırasında sistem yavaşlıyor, GPU sürekli meşgul, oynatma takılıyor.
**Nedenler:**
1. WebGPU'da varsayılan toplu boyut 4 ve Hız testinde 8: GPU'da hiç ölçülmemiş varsayımlardı. Tek model çağrısı çok uzun sürerse Windows
   ≈ 2 sn'de sürücüyü sıfırlar (TDR) ya da GPU belleği dolar. Her pencere ≈ 379 GMAC; toplu 8 → ≈ 3 TMAC tek çağrıda.
2. Model çağrıları arka arkaya tam hızda çalışıyordu: GPU %100 meşgul, tarayıcının sayfa/video çizimi aynı GPU'yu bekliyor (takılma).
**Düzeltme:** WebGPU varsayılan toplu boyut 1; Hız testi 1 → 2 → 4 sırasıyla ve yalnız tahmini tek GPU işi < 0.8 sn ise; çökme koruması
(yarım kalan deneme bir sonraki testte sınır olur); ayırmada **GPU hız sınırı** (bekletmede ≥ 4×, oynarken tampon rahatsa ≈ 1.7× gerçek zaman yeter;
yetişmek gerekirse tam hız). Rapora: ana iş parçacığı takılmaları (>50 ms) ve GPU hız sınırı beklemesi.
**Doğrulanmadı:** bu konteynerde GPU yok; etki RTX 5060 / M4'te kullanıcı tarafından doğrulanmalı (Hız testi + videoda takılma + rapor).

## Diğer videolar ve boşta kaynak kullanımı (0.5.4)
Kullanıcı sorusu: "diğer videoları oynatırken performans düşüşü için geliştirme yaptın mı?" — o güne kadar hayır. Koddan bulunanlar ve düzeltmeler:
1. **Ses yakalama kancası her YouTube videosunda** (dublaj kapalıyken de) ses parçalarını kopyalıyordu (kaynak başına 32 MB'a kadar bellek).
   → Dublaj/ayırma kapalıyken (abone yok) tampon 6 MB ≈ son 6 dk ile sınırlı (`content/main-world.js` `SEP_IDLE_CAP`); abone olunca 32 MB.
2. **Motorlar hiç boşaltılmıyordu:** çeviri (OPUS-MT ≈ 286 MB), seslendirme (WebGPU oturumu) ve konuşmacı modeli bir kez yüklenince dublaj kapatılsa
   ya da başka videoya geçilse de bellekte ve ekran kartı belleğinde kalıyordu.
   → Son motor isteğinden 3 dk sonra boşaltılır (`common/idle.js`, `offscreen.js`); canlı dublaj oynarken dakikada bir `engine.keepalive`
   gönderir; durum/liste sorguları etkinlik sayılmaz; sonraki istek (ya da oynatınca `_rewarm`) motoru yeniden yükler.
3. Zamanlayıcılar (100 ms tick, 50 ms perde): arka plan sekmelerinde Chrome zaten yavaşlatıyor; ölçülmedi, bu turda dokunulmadı (T6).
**Doğrulanmadı:** bellek/CPU kazancı gerçek cihazda ölçülmedi; yakalama sınırı ayrıca e2e ile sınanmadı (mantık basit). Ölçüm için rapordaki `[Bellek]` ve Hız testi.

## Öncelik (kişisel kullanım, sağlamlık)
**Önce ölç** (Hız testi + zaman kırılımı), **sonra görünür kıl** (hata günlüğü, bellek), **sonra düzelt** (boşta CPU, güncelleme adresi, kalite ayarı,
batch otomasyonu). Mağaza hazırlığı en sona.

## Ek: Hız testi çıktısı nasıl okunur
Ayarlar → Diğer → Hız testi → "Sonucu kopyala" tek metin verir (aynı satırlar Tanılama raporunda `[Hız testi]` altında). Satırlar:
- **ortam / ekran kartı / işlemci:** platform, Chrome ve eklenti sürümü; WebGPU adaptörü (ekran kartı tercihine göre); çekirdek, bellek (tarayıcı en çok "≥8 GB" söyler), crossOriginIsolated (WASM iş parçacıkları için gerekli).
- **toplu N: X rtf (Y× gerçek zaman) · pencere A ms · GPU işi B ms:** rtf = işlem süresi / ses süresi (< 1 gerçek zamandan hızlı; ilk parça ısınma, sayılmaz). Pencere = ölçülen iş / model penceresi; GPU işi = pencere × toplu = tek GPU çağrısının süresi. Windows'ta bu ≈ 2 sn'yi geçerse sürücü sıfırlanır (TDR); test 0.8 sn'yi aşacak toplu boyutu denemez ("denenmedi" satırı).
- **hız sınırı 0.6: X rtf · bekleme Y sn:** en hızlı güvenli toplu boyutta, videoda oynarken kullanılan sınırla (SEP.pacePlay); X ≈ 0.60 ise GPU sınıra yetişiyor, bekleme GPU'nun boş bırakıldığı toplam süre (2 ölçülen parça, 16 sn ses).
- **hafif model: X rtf · model …:** hızlı kalite (`quality: 'fast'`) toplu 1'de; tam modelle farkı cihaz profilinde kalite/hız seçimi için.
- **seslendirme + TTS aygıtı:** seçili sesin rtf'si ve çalıştığı aygıt (arka plan motoru bugün yalnız WASM; iş parçacığı sayısı yalıtım ve çekirdeğe bağlı).
- Hız sınırı ve hafif model yalnız WebGPU'da ölçülür; çökme koruması bunları da kapsar (yarım kalan deneme bir sonraki testte o toplu boyutu ve üstünü kapatır).
