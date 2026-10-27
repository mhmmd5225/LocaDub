# YT TR Dub — YouTube Türkçe Dublaj (Chrome MV3)

İngilizce altyazısı (manuel ya da otomatik) olan YouTube videolarını **tarayıcıda, yerel olarak**
Türkçeye çevirir ve seslendirir. Modeller ilk kullanımda bir kez indirilir; sonrasında internetsiz
çalışır. Metin ve ses hiçbir sunucuya gönderilmez.

## Kurulum

1. Chrome'da `chrome://extensions` adresini açın (Chrome 116+, Chrome Translator için 138+).
2. Sağ üstten **Geliştirici modu**nu açın.
3. **Paketlenmemiş öğe yükle** ile bu `extension/` klasörünü seçin.

Derleme adımı yoktur: düz ES module JavaScript.

## Kullanım

1. Eklenti simgesine tıklayın. Modeller indirilmemişse **Modelleri indir** düğmesi ayarlar sayfasını açar.
2. Ayarlar sayfasında (**Tüm ayarlar ve modeller**) **Seçili modelleri indir**'e ya da tek tek modellerin
   **İndir** düğmesine basın. Boyut önceden gösterilir; indirme onayınızla başlar. Chrome yerleşik
   çevirmeni için **Dil paketini hazırla** düğmesine basın (EN→TR paketi kullanıcı tıklamasıyla iner).
3. Bir YouTube videosu açın ve oynatıcı çubuğundaki **TR** düğmesine (ya da açılır penceredeki anahtara)
   basın. Düğme durumu gösterir: Dublaj kapalı / Hazırlanıyor / Dublaj aktif / Dikkat / Hata.

**Açılır pencere:** aç/kapa, durum kartı, seslendirme seçimi, dublaj ve orijinal ses seviyesi.

**Ayarlar sayfası** (`options/`): Genel (Türkçe altyazı, önceden hazırlama süresi, test motoru),
Ses (konuşma hızı, dublaj ses seviyesi, orijinal ses), Modeller (her model için İndir / Sil / Kullan,
ilerleme), Depolama, Durum.

Ayarlar (`chrome.storage.local`):

| Ayar | Açıklama |
|---|---|
| Dublaj açık | TR düğmesiyle aynı |
| Çeviri motoru / Ses | `listBackends()` / `listVoices()` listeleri; "Sistem sesi" = `chrome.tts` (Türkçe ses gerekir) |
| Konuşma hızı | Temel TTS hızı (0.8–2.0). Cümle sığmazsa hız otomatik artırılır (toplam ≤ 1.6) |
| Dublaj ses seviyesi | TTS kazancı (%0–200); YouTube'un ses düğmesiyle çarpılır |
| Orijinal ses | Türkçe konuşma sırasında orijinal sesin seviyesi (ducking) |
| Sözlük | Çeviri düzeltmeleri (altyazı + ses) ve okunuşlar (yalnızca ses): `kaynak => hedef` satırları, tam sözcük, Türkçe büyük/küçük harf duyarsız, `*` ekleri korur (`common/glossary.js`). Ham çeviri saklanır, sözlük kullanımda uygulanır |
| Konuşmacılara farklı ses | Altyazıda `>>` ile işaretli konuşmacı değişimlerinde iki ses sırayla konuşur (`speakerVoices`, `voice2`; varsayılan ikinci ses birincinin karşıt cinsiyetlisi) |
| Türkçe altyazı | Oynatıcı üzerinde overlay |
| Önceden hazırlama | Videonun ne kadar ilerisinin önceden çevrilip seslendirileceği (10–120 sn) |
| Yeni sürümleri denetle | Günde iki kez `https://localdub.mhmmd.app/version.json` okunur (yalnızca bu dosya); kurulu sürümden yeniyse açılır pencerede "Yeni sürüm" şeridi (İndir / Nasıl? / Sonra) |
| Test motoru | `engines/_mock/` ile uçtan uca test: "[TR] …" metni + bip sesi, indirme yok |

## Mimari

```
content/main-world.js (MAIN)  ytInitialPlayerResponse / player API, timedtext URL yakalama (pot)
        │ window.postMessage
content/app.js (izole)        altyazı → cümleler → ileri-bakış (≈30 sn) → senkron çalma, overlay, TR düğmesi
        │ chrome.runtime.sendMessage
background.js (SW)            offscreen oluşturma/yeniden kullanma, yönlendirme, ilerleme yayını, chrome.tts
        │ { target:'offscreen', …, settings }
offscreen.js                  engines/mt/index.js + engines/tts/index.js (dinamik import), iş kuyruğu, iptal
        └ engines/common/model-cache.js  (Cache Storage, akışlı indirme + ilerleme)
```

- **Altyazı**: `captionTracks` içinden İngilizce manuel parça, yoksa otomatik (`kind:'asr'`), yoksa
  çevrilebilir parça `tlang=en`. `&fmt=json3` ile çekilir. YouTube boş yanıt verirse (yeni `pot` belirteci)
  oynatıcının kendi timedtext isteği yakalanır; gerekirse altyazı modülü bir anlığına açılıp kapatılır.
- **Çeviri önbelleği** (`common/transcript-store.js`): cümleler ve çeviriler `chrome.storage.local`'da
  (`tr:<videoId>:<motor>`, son 50 video). Aynı video yeniden açılınca altyazı çekilmez, çeviri beklenmez.
  15 sn'de bir ve sekme kapanırken yazılır; Ayarlar → Depolama'dan temizlenir.
- **Cümleler** (`content/captions.js`): noktalama, > 700 ms duraklama, konuşmacı değişimi (`>>`; cümleye
  `speaker: 1` olarak taşınır, her işarette 0 ↔ 1),
  en fazla ~12 sn (mümkünse virgülde bölünür). Parça içi cümle sonları zamana orantılı bölünür.
- **Zamanlama** (`content/timing.js`): cümle süresi = sonraki cümleye kadar (en fazla bitiş + 0.8 sn).
  Sentez hızı tahmini süreye göre seçilir (≤ 1.6), kalan taşma `<audio>.playbackRate` ile (perde korunur)
  giderilir; yine sığmazsa sıradaki cümle bekler (en fazla 1.2–4 sn gecikme, sonra atlanır).
- **Ses**: `<audio>` → `MediaElementSource` → `GainNode`. Orijinal ses, video için Web Audio kazancıyla
  kısılır (MSE/`blob:` kaynakta; olmazsa `video.volume`). Duraklatma, ileri sarma, hız değişimi ve
  reklamlar izlenir.
- **PCM aktarımı**: offscreen Float32 → Int16 LE → base64 (`{ pcmBase64, sampleRate, format:'s16le' }`);
  içerik betiği WAV `blob:` URL'si üretir.
- **Mesajlar**: `mt.translate`, `tts.synthesize`, `engine.init`, `engine.status`
  (+ `crossOriginIsolated`, `webgpu`), `engine.list`, `jobs.cancel`, `models.clear`; ilerleme
  `engine.progress { engine, loaded, total, done?, error? }`; sistem sesi `tts.system.speak|stop|pause|resume|voices`.
- **İzolasyon**: manifest COOP `same-origin` + COEP `require-corp` → offscreen `crossOriginIsolated`,
  WASM çoklu iş parçacığı açık. Model indirmeleri `mode:'cors'`, `credentials:'omit'`.
- Model indirmesi yalnızca kullanıcı popup'ta onay verdikten sonra yapılır (`modelsApproved`).

## Testler

```
node --test tests/extension/
```

Saf modüller (`content/captions.js`, `content/timing.js`, `common/pcm.js`, `common/settings.js`,
`common/transcript-store.js`, `common/glossary.js`),
`engines/common/model-cache.js` (sahte Cache Storage/fetch ile) ve sahte motorlar sınanır.

Uçtan uca (gerçek Chromium + eklenti, sahte YouTube sayfası, test motoru; Playwright ve ffmpeg gerekir):

```
xvfb-run -a node tests/extension/e2e/transcript-cache.e2e.cjs
xvfb-run -a node tests/extension/e2e/speaker-voices.e2e.cjs
xvfb-run -a node tests/extension/e2e/glossary.e2e.cjs
xvfb-run -a node tests/extension/e2e/update-banner.e2e.cjs
```

**Sürüm yayınlama:** `manifest.json` → `version` artırılıp `main`'e birleştirilince site yeni ZIP'i ve
`version.json`'ı yayınlar; kurulu eklentiler 12 saat içinde şeridi gösterir.

## Bilinen sınırlamalar

- Yalnızca `www.youtube.com/watch` (Shorts, canlı yayın, gömülü oynatıcı desteklenmez).
- YouTube arayüz/timedtext değişiklikleri altyazı alma yolunu bozabilir.
- Uzun model indirmelerinde service worker yeniden başlarsa ilk istek zaman aşımına uğrayabilir;
  indirme offscreen'de sürer, bitince içerik betiği yeniden bağlanır.
