# LocaDub — YouTube Türkçe Dublaj (Chrome MV3)

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
2. Ayarlar sayfasında **İndirme** menüsünde **Seçili modelleri indir**'e ya da tek tek modellerin
   **İndir** düğmesine basın. Boyut önceden gösterilir; indirme onayınızla başlar. Chrome yerleşik
   çevirmeni için **AI Model** menüsündeki **Dil paketini hazırla** düğmesine basın (EN→TR paketi kullanıcı tıklamasıyla iner).
3. Bir YouTube videosu açın ve oynatıcı çubuğundaki **TR** düğmesine (ya da açılır penceredeki anahtara)
   basın. Düğme durumu gösterir: Dublaj kapalı / Hazırlanıyor / Dublaj aktif / Dikkat / Hata.

**Oynatıcı paneli** (`content/panel.js`, `panel.css`; tasarım belirteçleri `common/theme.css`): TR düğmesinin yanında,
kontrol çubuğunun hemen üstündeki hap (Shorts'ta yüzen TR düğmesinin altında; dublaj kapalıyken yok) canlı durumu
gösterir — hazırlık aşaması, video bekletilirken ince ilerleme çubuğu, bir dublaj
cümlesi çalarken **şu an konuşan ses** (ad + kadın/erkek rengi + dublaj sesinden seviye dalgası) ve videodan ölçülen
konuşan (♀/♂, araç ipucunda Hz). YouTube kontrolleriyle birlikte gizlenir (hazırlık, uyarı ve bekletmede görünür kalır);
hap görünürken Türkçe altyazı hapın üstüne itilir. Tıklayınca hapın üstünde açılan cam panel: **Durum** (altyazılar, çeviri motoru, ses motoru, ses ayırma, önbellek — model indirme
yüzdesi ve ne kadar ilerisinin hazır olduğu), **Sesler** (otomatik kadın/erkek anahtarı; kadın ve erkek favori sesi,
üslup Doğal/Canlı/Sakin, perde −3…+3, ▶ Dinle; anahtar kapalıyken tek ses satırı), **Karışım** (dublaj sesi, orijinal
ses, gerçek dublaj = ses ayırma, Türkçe altyazı) ve **Tüm ayarlar** bağlantısı. Değişiklikler hemen uygulanır (hazır
sesler yeni ses/tonla yeniden üretilir). Esc kapatır; panel içindeki tuşlar YouTube kısayollarına ulaşmaz. Küçük
(mini/gömülü) oynatıcıda hap yalnızca simge, panel oynatıcıyı kaplar. Panel varken eski sol üst durum kutusu gizlenir
(iletisi panelde görünür).

**Açılır pencere:** üstte seslendirme seçici ve dublaj anahtarı (seçici anahtarın solunda), altında durum kartı ile dublaj ve orijinal ses seviyesi. Dublaj her tarayıcı açılışında kapalı başlar.

**Ses seçimi:** Antalia Mini (erkek, varsayılan), Ahenk Cep ve EMA Lightning (kadın) birer küçük model (23–35 MB);
**Supertonic 3** (deneysel) 10 hazır sesli tek pakettir (≈ 210 MB 8-bit kopya, 5 kadın + 5 erkek, en canlı tonlama; tarayıcıda
4 iş parçacığı ister). Seslendirme menüsündeki **Dinle** düğmesi seçili ses ve üslupla kısa bir örnek çalar.
Karşılaştırma: [docs/TTS-KIYAS.md](../docs/TTS-KIYAS.md).

**Ayarlar sayfası** (`options/`): kaydırmasız, dört menü (`#indirme`, `#seslendirme`, `#ai-model`, `#diger`; eski
`#modeller`, `#ses`, `#genel`, `#sozluk`, `#depolama`, `#durum` bağlantıları eşlenir; sol/sağ ok tuşlarıyla gezilir).
**İndirme**: OPUS-MT, Antalia, Ahenk ve noktalama modeli için İndir / Sil, toplu indirme, model ve çeviri önbelleğini
temizleme. **Seslendirme**: ses seçimi, konuşma hızı, dublaj ve orijinal ses seviyesi, konuşmacılara farklı ses.
**AI Model**: çeviri motoru (Otomatik / OPUS-MT / Chrome çevirmeni), noktalama düzeltme. **Diğer**: Türkçe altyazı,
sürüm denetimi, önceden hazırlama süresi, ilk cümleye kadar bekletme, sözlük, **Tanılama bilgisini kopyala** (sürümler, ayarlar, motorlar,
indirilen modeller ve son 10 hata; video adresi, altyazı ve çeviri metni girmez — `common/diagnostics.js`), varsayılana
döndürme. Motor/model hatası olursa menü çubuğunun altında bir şerit görünür. Test motoru yalnızca `options.html#gelistirici`
ya da `?dev=1` ile (veya motor zaten test modundaysa) "Diğer" menüsünde görünür.

Ayarlar (`chrome.storage.local`):

| Ayar | Açıklama |
|---|---|
| Dublaj açık | TR düğmesiyle aynı |
| Çeviri motoru / Ses | `listBackends()` / `listVoices()` listeleri; "Sistem sesi" = `chrome.tts` (Türkçe ses gerekir) |
| Konuşma hızı | Temel TTS hızı (0.8–2.0). Cümle sığmazsa hız otomatik artırılır (toplam ≤ 1.6) |
| Üslup | Doğal / Canlı / Sakin (`style`, varsayılan Doğal). **İnce ayardır, robot hissini ortadan kaldırmaz.** Ahenk Cep'te stil gömmesi (neutral / cheerful / calm), Antalia Mini'de örnekleme sıcaklığı; ikisinde de küçük bir hız çarpanı ve perde payı. Tablo tek yerde: `engines/tts/styles.js` (değerler başlangıç tahminidir, dinleyerek ayarlanacak). Sistem sesinde kullanılamaz |
| Perde | Gelişmiş: −3…+3 yarım ton (`pitch`, adım 0.5); üslubun perdesine eklenir, toplam ±4 ile sınırlı. Süre değişmez; biçimlenti de kaydığı için küçük değerler önerilir |
| Kalite | Gelişmiş: Hızlı (varsayılan) / Yüksek (`quality`): flow adımı 8 → 16, yaklaşık +0.1 UTMOS (Ahenk model kartı), sentez yaklaşık 1.2–1.9 kat uzun sürer (RTF tablosu: engines/tts/README.md). Supertonic'te gürültü giderme adımı 5 → 8. Sistem sesinde kullanılamaz |
| Ses karıştırma | Gelişmiş, yalnızca Supertonic: seçili sese aynı paketten ikinci bir sesin rengi katılır (`voiceBlend: { with: 'M1', amount: 0–0.9 }`, %0 = kapalı) |
| Dublaj ses seviyesi | TTS kazancı (%0–200); YouTube'un ses düğmesiyle çarpılır. Motor her cümleyi önce ortak seviyeye (−20 dBFS) getirir, sesler ve konuşmacılar arasında seviye sıçraması olmaz |
| Orijinal ses | Türkçe konuşma sırasında orijinal sesin seviyesi (ducking) |
| Sözlük | Çeviri düzeltmeleri (altyazı + ses) ve okunuşlar (yalnızca ses): `kaynak => hedef` satırları, tam sözcük, Türkçe büyük/küçük harf duyarsız, `*` ekleri korur (`common/glossary.js`). Ham çeviri saklanır, sözlük kullanımda uygulanır |
| Kadın ve erkek sesini otomatik seç | Varsayılan açık (`genderVoices`). Videonun kendi sesinden konuşanın perdesi ölçülür (Web Audio analizörü, yerel; `content/gender.js`): < 155 Hz erkek, > 170 Hz kadın, arası belirsiz. Kadın konuşurken kadın, erkek konuşurken erkek sesi kullanılır; konuşan değişince henüz çalınmamış cümleler doğru sesle yeniden hazırlanır. Analizör konuşma bandına (70 Hz – 1 kHz) süzülür. Çalan cümlenin ilk ≈ 0.5 sn'si belirgin bir cinsiyet gösterirse (< 140 / > 185 Hz) karar hemen verilir (erken karar), sonraki cümleler o cümle bitmeden doğru sesle hazırlanır; tam ölçüm cümle bitince. Gecikme eklenmez: videonun ve yeni bir konuşmacının ilk cümlesi yine varsayılan sesle başlayabilir. Müzik: ≥ 300 ms sabit kalan perdeler (tutulan nota) atılır, aralıkta iki cinsiyet bandı da kalabalıksa ölçüm belirsiz sayılır ve ses değişmez; yalnız müzik ölçülmez. Konuşmadan yüksek müzikte yanılma olabilir. Konuşmacı sırası (`>>`) varsa her sıranın cinsiyeti ayrı tutulur |
| Favori ses ve ton | Seslendirme menüsünde ses kartındaki ★ (Supertonic'te hazır ses seçicinin yanında): o ses, o anki üslup ve perdeyle kendi cinsiyetinin favorisi olur (`favFemale`, `favMale` = `{ voice, style, pitch }`); aynı cinsiyetin eskisinin yerine geçer, yeniden basınca kalkar. Otomatik kadın/erkek seçiminde öncelik favoride (sonra birinci ses, sonra kendiliğinden seçilen); favori sesle okunan cümle favorinin tonuyla okunur. Favori ses seçiliyken üslup/perde değişikliği favoriye de yazılır |
| Konuşmacılara farklı ses | Otomatik cinsiyet açıkken "aynı cinsiyetten konuşmacılara da farklı ses": aynı cinsiyetten iki konuşmacı sırayla konuşursa o cinsiyetin ikinci sesi kullanılır. Kapalıyken altyazıda `>>` ile işaretli konuşmacı değişimlerinde 2–4 ses sırayla konuşur (`speakerVoices`, `speakerCount`, `voice2`–`voice4`). Seçilmeyen ses kendiliğinden gelir: önce karşıt cinsiyet, sonra aynı cinsiyetten başka bir ses; Supertonic'te aynı paketin sesleri (ek indirme yok). Altyazı kimin konuştuğunu söylemez, yalnızca değiştiğini: iki kişide 2 ses doğru eşleşir, 3–4 ses grup videoları içindir. Cümlede konuşmacı sayacı saklanır (`speaker`, mod 12), ses = sayaç mod `speakerCount` |
| Türkçe altyazı | Oynatıcı üzerinde overlay |
| Önceden hazırlama | Videonun ne kadar ilerisinin önceden çevrilip seslendirileceği (10–120 sn) |
| İlk cümle hazır olana kadar videoyu beklet | Varsayılan açık (`holdStart`). Dublaj açılınca video, yakındaki (8 sn) ilk cümlenin sesi hazır olana kadar duraklatılır, sonra kendiliğinden sürer (en fazla 25 sn; Oynat'a basınca beklemeden devam eder, reklamda bekletilmez). Böylece motorlar yüklenirken baştaki cümleler atlanmaz |
| Yeni sürümleri denetle | Günde iki kez `https://localdub.mhmmd.app/version.json` okunur (yalnızca bu dosya); kurulu sürümden yeniyse açılır pencerede "Yeni sürüm" şeridi (İndir / Nasıl? / Sonra) |
| Otomatik altyazıda noktalama | İsteğe bağlı model (Ayarlar → İndirme, 210 MB, HuggingFace): YouTube'un otomatik (küçük harfli, noktasız) altyazısına çeviriden önce noktalama ve büyük harf ekler; kıyasta chrF 51.1 → 53.1 (`engines/mt/punct.js`, `restore-engine.js`; `docs/MT-KIYAS.md`). Elle yazılmış altyazıya dokunmaz; indirme bitince kendiliğinden açılır |
| Test motoru | `engines/_mock/` ile uçtan uca test: "[TR] …" metni + bip sesi, indirme yok |

## Mimari

```
content/main-world.js (MAIN)  ytInitialPlayerResponse / player API, timedtext URL yakalama (pot)
        │ window.postMessage
content/app.js (izole)        altyazı → cümleler → ileri-bakış (≈30 sn) → senkron çalma, overlay, TR düğmesi
content/panel.js              oynatıcı paneli: durum hapı + cam panel (app.js `panel.update({ session: _panelState() })`)
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
- **Başlangıç**: altyazı ve iki motor aynı anda istenir; her motor hazır olur olmaz kendi döngüsü başlar. Çeviri ve
  seslendirme ayrı döngülerde paralel çalışır, ikisi de oynatma konumuna en yakın cümleden başlar (ilk çeviri grubu 2,
  yakın cümleler 3, uzaktakiler 8 cümle). Hazırlık süreleri (altyazı, çeviri/ses motoru, ilk çeviri, ilk ses, bekletme)
  konsola (`[yt-tr-dub] hazırlık: …`) ve tanılama raporuna ("Başlangıç süreleri", son 5) yazılır. Ölçüm:
  `xvfb-run -a node tests/extension/e2e/startup.bench.cjs` (2 çekirdek için önüne `taskset -c 0,1`). Gerçek motorlarla,
  modeller önbellekte, tarayıcı yeni açılmış (0.4.0 öncesi → sonrası, ortanca): 4 çekirdek 13.7–17.5 → 10.5 sn, 2 çekirdek
  16.7 → 13.1 sn; dublaj artık videonun 13–17. saniyesinden değil 0.2. saniyesinden başlıyor (bekletme). Kalan sürenin
  çoğu OPUS-MT oturumunun kurulması (≈ 8–10 sn; Chrome çevirmeni kullanılabiliyorsa bu adım yok).
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
xvfb-run -a node tests/extension/e2e/diagnostics.e2e.cjs
xvfb-run -a node tests/extension/e2e/shorts-embed.e2e.cjs
xvfb-run -a node tests/extension/e2e/hold-start.e2e.cjs
xvfb-run -a node tests/extension/e2e/gender-voices.e2e.cjs
xvfb-run -a node tests/extension/e2e/player-panel.e2e.cjs  # ekran görüntüleri: tests/extension/e2e/out/
xvfb-run -a node tests/extension/e2e/asr-punct.e2e.cjs   # tests/mt/.models/punct-en/ yoksa atlanır
```

**Sürüm yayınlama:** `manifest.json` → `version` artırılıp `main`'e birleştirilince site yeni ZIP'i ve
`version.json`'ı yayınlar; kurulu eklentiler 12 saat içinde şeridi gösterir.

## Bilinen sınırlamalar

- Desteklenen sayfalar: `www.youtube.com/watch`, Shorts (`/shorts/…`; TR düğmesi oynatıcının sağ üstünde yüzer) ve
  başka sitelerdeki gömülü oynatıcı (`youtube.com/embed/…`, `youtube-nocookie.com/embed/…`) — `common/page.js`.
  Canlı yayın ve `m.youtube.com` desteklenmez.
- YouTube arayüz/timedtext değişiklikleri altyazı alma yolunu bozabilir.
- Uzun model indirmelerinde service worker yeniden başlarsa ilk istek zaman aşımına uğrayabilir;
  indirme offscreen'de sürer, bitince içerik betiği yeniden bağlanır.
