# Chrome Web Mağazası — gönderim notları

Mağaza kaydı ve gönderim, geliştirici hesabı sahibince (https://chrome.google.com/webstore/devconsole) yapılır.
Bu dosya formdaki alanlar için hazır metinleri ve gerekçeleri içerir.

## Paket

Mağaza, `manifest.json` dosyası ZIP'in kökünde olan bir paket ister. Sitedeki `LocaDub.zip` elle kurulum içindir
(içinde `LocaDub/` klasörü var); mağaza için ayrı paket üretin:

```
cd extension && zip -r -X ../locadub-store.zip . -x '*.DS_Store' && cd ..
```

Her gönderimde `manifest.json` → `version` artırılmalıdır.

## Mağaza kaydı

**Ad:** LocaDub — YouTube Türkçe Dublaj
**Kategori:** Erişilebilirlik (alternatif: Araçlar)
**Dil:** Türkçe

**Kısa açıklama (≤ 132 karakter, manifest ile aynı):**
İngilizce YouTube videolarını bilgisayarınızda Türkçeye çevirir ve seslendirir. Metin ve ses hiçbir sunucuya gitmez.

**Ayrıntılı açıklama:**

> LocaDub, İngilizce altyazılı YouTube videolarını izlerken Türkçe dinlemenizi sağlar. Videonun altyazısını
> Türkçeye çevirir, Türkçe seslendirir ve videoyla eş zamanlı oynatır; konuşma sırasında orijinal ses kısılır.
>
> • Tamamen yerel: çeviri ve seslendirme bilgisayarınızda, tarayıcınızın içinde yapılır. Hesap, abonelik, API anahtarı yok.
> • Modeller bir kez indirilir (onayınızla), sonra internetsiz çalışır.
> • Çeviri: Chrome'un cihaz üzerindeki çevirmeni ya da OPUS-MT. Ses: Antalia Mini (erkek), Ahenk Cep (kadın) ya da sistem sesi.
> • Konuşmacı değişince farklı ses, kişisel sözlük (çeviri düzeltmeleri ve okunuşlar), Türkçe altyazı.
> • Normal videolar, Shorts ve sitelere gömülü YouTube oynatıcıları.
> • Açık kaynak: https://github.com/mhmmd5225/LocaDub
>
> Üretilen Türkçe ses yapay zekâ ile sentezlenir.

**English summary (isteğe bağlı ikinci dil):**
LocaDub translates English YouTube videos into Turkish and dubs them with Turkish speech — entirely on your computer.
Captions are translated and spoken locally (OPUS-MT / Chrome's on-device translator, on-device Turkish TTS); no text
or audio leaves the browser.

**Gizlilik politikası adresi:** https://localdub.mhmmd.app/gizlilik.html
**Ana sayfa:** https://localdub.mhmmd.app
**Destek:** https://github.com/mhmmd5225/LocaDub/issues

**Görseller (hazırlanacak):** 128×128 simge (`extension/icons/icon-128.png`), en az bir 1280×800 ekran görüntüsü
(oynatıcıda TR düğmesi + Türkçe altyazı; açılır pencere; ayarlar → indirme), isteğe bağlı 440×280 tanıtım görseli.

## Gizlilik sekmesi

**Tek amaç (single purpose):**
YouTube videolarının İngilizce altyazısını Türkçeye çevirip Türkçe seslendirmek ve videoyla eş zamanlı oynatmak.

**İzin gerekçeleri:**

| İzin | Gerekçe |
|---|---|
| `offscreen` | Çeviri ve ses modelleri (ONNX/WebAssembly) bir offscreen belgesinde çalışır; service worker'da çalıştırılamazlar. |
| `storage` | Ayarlar, kişisel sözlük ve son izlenen videoların çeviri önbelleği yerel olarak saklanır. |
| `unlimitedStorage` | İndirilen modeller (25–330 MB) ve çeviri önbelleği tarayıcı kotasına takılmadan yerel olarak saklanır. |
| `tts` | Kullanıcı "Sistem sesi"ni seçerse Türkçe metin işletim sisteminin/Chrome'un sesiyle okunur. |
| `alarms` | Günde iki kez yeni sürüm denetimi (kullanıcı kapatabilir). |
| Host: `www.youtube.com`, `www.youtube-nocookie.com` | İçerik betiği oynatıcıya TR düğmesini ve Türkçe altyazıyı ekler, videonun altyazısını alır ve sesi videoyla eşler. |
| Host: `huggingface.co` ve indirme alt alan adları (`*.huggingface.co`, `*.hf.co`, `cdn-lfs.huggingface.co`, `cas-bridge.xethub.hf.co`) | Çeviri, ses ve (isteğe bağlı) noktalama modellerinin dosyaları (yalnızca veri; kod değil) kullanıcı onayıyla bir kez buradan indirilir. |
| Host: `localdub.mhmmd.app` | Yeni sürüm denetimi için `version.json` okunur. |

**Uzak kod:** Hayır. Tüm JavaScript ve WebAssembly pakette gelir; indirilen dosyalar yalnızca model ağırlıkları ve
sözlük verileridir (ONNX, JSON).

**Veri kullanımı beyanı:** Hiçbir kullanıcı verisi toplanmaz ya da aktarılmaz. Formda hiçbir veri türü işaretlenmez;
üç onay kutusu (veriler satılmaz, amaç dışı kullanılmaz, kredi değerlendirmesi için kullanılmaz) işaretlenir.

## Gönderim öncesi kontrol listesi

- [ ] `manifest.json` → `version` artırıldı; `node --test tests/extension/*.test.mjs` ve uçtan uca testler geçiyor
- [ ] Temiz bir Chrome profiline `locadub-store.zip` içeriği "Paketlenmemiş öğe" olarak yüklenip gerçek bir videoda denendi
- [ ] Gizlilik politikası sayfası yayında ve güncel
- [ ] Ekran görüntüleri güncel arayüzü gösteriyor
