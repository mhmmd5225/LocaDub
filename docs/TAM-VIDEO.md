# Tam video için ses akışının tamamını elde etme (İŞ A0)

Tarih: 2026-11-10 · Bağlam: `docs/V1-PLAN.md` §3, "Tüm videoyu hazırla" · Kapsam: araştırma ve ölçüm. Bu iş kod değiştirmez.

## 0. Sonuç (özet)

| Soru | Cevap | Dayanak |
|---|---|---|
| Eklenti, web oynatıcının ses akışının tamamını basit aralık istekleriyle (b1) indirebilir mi? | **Büyük olasılıkla hayır.** `web` istemcisinin player yanıtında adaptif biçimlerin URL'si yok, yalnız SABR var. Ayrıca PO token gerekiyor. | yt-dlp #12482, PO Token Guide (§3). Gerçek cihazda **doğrulanamadı** (§4). |
| SABR oturumunu taklit etmek (b2-SABR) teknik olarak mümkün mü? | Mümkün görünüyor (açık kaynak `googlevideo` kütüphanesi var), ama kırılgan. Ayrıca mağaza politikası açısından "indirici" sayılma riski yüksek. | §2, §5 |
| Gizli ikinci oynatıcı (b3) | Çalışabilir, ama yalnız oynatma hızında (≈1–2×) iner. Bant genişliği iki katına çıkar, görüntülenme ve reklam yan etkileri var. **Tahmin, denenmedi.** | §2 |
| Öneri | v1.0'da **(c)**: tam kipte çeviri ve TTS tümüyle hazırlanır, ayırma oynatmanın önünden gider. Ek olarak yakalanan paketler OPFS'e yazılır: ikinci izlemede (ya da geri sarmada) ayırma tümüyle hazır olur. b1 yalnız §4'teki 5 dakikalık cihaz denemesi olumlu çıkarsa denenir. | §6 |

## 1. Bugünkü yakalama yolu (koddan)

### 1.1 Ne yakalanıyor
- `content/main-world.js` sayfa dünyasında (MAIN, `document_start`, `all_frames`) çalışır (`manifest.json` `content_scripts[0]`).
- `MediaSource.prototype.addSourceBuffer` sarılır. Yalnız `audio/*` MIME'lı SourceBuffer'lar kaydedilir (`main-world.js:108-121`).
- `SourceBuffer.prototype.appendBuffer` sarılır. Asıl çağrı **önce** yapılır, ardından eklenen baytların kopyası alınır (`u8.slice()`). Asıl çağrı hata verirse kopya alınmaz (`main-world.js:122-128`, `82-94`). Her kayıt şunları içerir: veri, `timestampOffset` ve ilklendirme olup olmadığı (`isInit`, EBML `1A45DFA3` ya da `ftyp`/`moov`, `main-world.js:57-62`).
- `abort`, `changeType` ve `URL.createObjectURL(MediaSource)` da izlenir. Bu sayede blob URL'si ile `video.src` eşleştirilebilir (`main-world.js:129-155`). En fazla 3 MediaSource tutulur (`main-world.js:71`).
- Sınırlar: abone varken kaynak başına `SEP_CAP = 32 MB` (opus ≈ 16 KB/sn, yani ≈ 30 dk). Abone yokken `SEP_IDLE_CAP = 6 MB`. Sınır aşılınca en eski girdiler atılır, ama son ilklendirme segmenti saklanır (`main-world.js:47-48`, `87-92`).
- İçerik betiği abone olunca (`sep-subscribe`) tamponun tamamı baştan gönderilir (`sepReplay`). Sonrası canlı akar ve aktarılabilir ArrayBuffer olarak `postMessage` ile iletilir (`main-world.js:96-104`, `243-246`).

### 1.2 Biçimler ve demux
- `content/sep-demux.js:1-5`, `411-415`. Desteklenen iki biçim:
  - WebM/EBML: `audio/webm; codecs="opus"`. Ayrıştırılan öğeler: EBML başlığı, Segment/Info/Tracks ve Cluster > SimpleBlock/BlockGroup. Ekleme baytları herhangi bir sınırda bölünebilir. Vorbis ve AAC kodek kimlikleri de tanınır (`sep-demux.js:191`).
  - Parçalı MP4: `audio/mp4; codecs="mp4a.40.x"`. Ayrıştırılan kutular: ftyp/moov (ilklendirme) ve moof (tfdt, trun) + mdat (`sep-demux.js:291-400`).
- Şifreli içerik (`ContentEncodings`/`enca`) algılanır ve "Şifreli (DRM) ses" hatası verilir (`sep-demux.js:190`, `separation.js:483`).
- Çıktı: medya zamanlı kodlanmış paketler `{t, dur, data, cfg}` (`sep-demux.js:5`). Bunlar `PacketStore`'a eklenir (`separation.js:434-458`, `sep-core.js:70`). Sonra WebCodecs `AudioDecoder` ile çözülür ve ayırma işçisine gider (`separation.js:1-15`).
- Önemli çıkarım: **demux katmanı kaynaktan bağımsız.** Hangi yoldan gelirse gelsin (MSE kopyası, OPFS, indirme) aynı WebM/MP4 baytları `createDemuxer(mime).push()` ile işlenebilir. Bu yüzden A5'in alıcı tarafı hazır.

### 1.3 Neden yalnız 30–120 sn
Oynatıcı ancak tamponlamak istediği kadarını indirir. Kopya da yalnız `appendBuffer`'a gelen kadardır. `SEP_CAP` bellek tavanıdır, darboğaz değildir (`V1-PLAN.md` §3 "Yakalama").

### 1.4 Player yanıtı nasıl okunuyor (captions)
- `main-world.js:159-172` `playerResponse()` önce `movie_player.getPlayerResponse()`'u dener, olmazsa `window.ytInitialPlayerResponse`'u okur. `summarize()` içinden yalnız `videoDetails` ve `captions` alanları içerik betiğine gönderilir (`main-world.js:174-192`). İçerik betiği bunu `callMain('get-player-response')` ile ister (`content/app.js:396`).
- **Aynı yoldan `streamingData` okunabilir.** `summarize()`'a `streamingData.adaptiveFormats` (itag, mimeType, `url`/`signatureCipher` var mı, contentLength) ve `serverAbrStreamingUrl` var mı bilgisi eklemek yeterli. Kodda bugün bu alan okunmuyor.
- Altyazıdaki benzer durum: YouTube timedtext isteklerinde de `pot` (PO token) kullanıyor. Eklenti bu belirteci üretmiyor. Bunun yerine oynatıcıya isteği yaptırıp URL'yi fetch/XHR kancasıyla yakalıyor (`main-world.js:15-39`, `196-230`). Bu desen ses için de tek gerçekçi yolu gösteriyor: **belirteci oynatıcıdan ödünç almak**, kendin üretmemek.

## 2. Yollar

| Yol | Nasıl çalışır | Engeller | Risk |
|---|---|---|---|
| **b1** adaptiveFormats URL + aralık | Player yanıtındaki ses biçiminin (ör. itag 251 opus) `url`'si alınır, `&range=a-b` ile parça parça indirilir, sonra demux edilir. | (1) `web` istemcisinde adaptif URL'ler **kaldırıldı, yalnız SABR var** (yt-dlp #12482; Şubat–Nisan 2025, hâlâ açık). (2) URL olsa bile `signatureCipher` + `n` dönüşümü için oynatıcı JS'sini çözmek gerekir. yt-dlp bunu ayrı bir JS motoruyla (yt-dlp-ejs) yapıyor. (3) `web` GVS istekleri PO token istiyor. Token yoksa 403 ya da IP/hesap engeli gelebilir (PO Token Guide). (4) CORS: MAIN dünyasından yapılan istek youtube.com kökenli olur. Oynatıcı googlevideo'ya zaten bu kökenden gidiyor, bu yüzden muhtemelen izinli (**tahmin**). Arka plandan istek için `https://*.googlevideo.com/*` host izni gerekir. Manifest'te bu izin yok (`manifest.json` `host_permissions`). | Yüksek: büyük olasılıkla hiç çalışmaz. Çalışsa da imza, `n` ve token değiştikçe kırılır. |
| **b2** sayfanın isteklerini gözlemek + daha çok tamponlatmak | MAIN'de fetch yanıtları `clone()` ile okunur (SABR'da `application/vnd.yt-ump` gövdesi, `googlevideo` kütüphanesi bunu ayrıştırır). İleri tampon büyütülür. | Gözlem tek başına bugünkü `appendBuffer` kopyasından **fazla veri vermez**: aynı baytlardır. Tamponu büyütmek için sunucu davranışını değiştirmek gerekir. SABR'da istemci oynatma durumunu (konum, tampon) bildirir, sunucu ne kadar göndereceğine kendisi karar verir (PipePipe SABR belgesi). Oynatıcının iç tampon ayarları belgelenmemiş (**doğrulanamadı**). **b2-SABR**: oynatıcının kendi SABR isteğinden `serverAbrStreamingUrl`, ustreamer config ve PO token kopyalanır, eklenti yalnız ses için ikinci bir SABR oturumu yürütür (LuanRT/googlevideo `SabrStream` bunu yapıyor). | Teknik olarak en olası "tam ses" yolu. Ama protokol tersine mühendislikle çözülmüş ve sık değişiyor. Mağaza açısından "YouTube indirme" sayılır (§5). İlk sürüm için önerilmez. |
| **b3** gizli ikinci oynatıcı | Sayfaya görünmez bir `youtube-nocookie.com/embed/<id>` iframe eklenir. Sessiz ve en yüksek hızda (API sınırı 2×) oynatılır. `main-world.js` bu çerçeveye de girdiği için (`all_frames`, embed eşleşmesi) appendBuffer kopyası oradan alınır. | İndirme hızı oynatma hızına bağlıdır: 60 dk video için 2×'te ≈ 30 dk (**tahmin**). Video verisi de iner, bant genişliği iki katına çıkar. Bazı videolarda gömme kapalı ("Playback on other websites has been disabled", yt-dlp #12482 yorumları). Embed'de reklam ve görüntülenme sayımı olabilir. Arka plan sekmesinde kısılma olabilir. `<video>.playbackRate` 16'ya zorlanırsa MSE akışının ne yapacağı **denenmedi**. | Orta–yüksek: kullanıcıya görünmeyen bir yan oynatma olur. Mağaza ve YouTube ToS açısından gri alan. Kazanç sınırlı. |
| **c** yedek | Tam kipte çeviri ve TTS videonun tamamı için önceden hazırlanır. Ayırma, oynatmanın önünden (bugünkü gibi) gider. | Yok: bugünkü kodla uyumlu. | Düşük. Arayüz "ayırma oynatırken hazırlanır" diyecek (`V1-PLAN.md` §3 (c)). |
| **c+** yedek + kalıcı yakalama | (c)'ye ek olarak MAIN'den gelen ses baytları tam kipte OPFS'e akıtılır, böylece `SEP_CAP` bellekte kalmaz. İlk izlemede biriken ses ikinci izlemede ya da geri sarmada tümüyle ayrılır. Boşta GPU varsa yakalanmış ama henüz ayrılmamış her yer de işlenir. | OPFS kotası. MSE'ye eklenen kalite değişebilir (itag değişimi, `changeType`), demux bunu zaten karşılıyor (`separation.js:445-449`). | Düşük. Yeni ağ isteği ya da izin gerekmez. |

## 3. Web'den toplanan güncel bilgiler

| Bulgu | Kaynak |
|---|---|
| `web` istemcisi "only has SABR formats": adaptiveFormats URL'leri kaldırıldı. yt-dlp "missing a url, YouTube is forcing SABR" uyarısı ekledi. Konu açık, SABR indirici PR'ı (#13515) da açık. Son hareket 21 Ağustos 2025'te. | https://github.com/yt-dlp/yt-dlp/issues/12482 |
| PO token tablosu: `web` için altyazı + GVS gerekli ve "SABR-only". `mweb`/`web_safari`/`tv_simply` için GVS gerekli. `web_embedded` ve `android_vr` için gerekli değil (kısıtlarla). Çoğu `web` token'ı video kimliğine bağlı. Token yoksa 403 ya da IP/hesap engeli. | https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide |
| 2026'da SABR-only deneyinin oturum bazında açıldığı yeni bildirimler var. | https://github.com/yt-dlp/yt-dlp/issues/16150 (yalnız arama özeti, sayfa açılmadı: **kısmen doğrulandı**) |
| SABR oturum tabanlıdır: istemci durumunu sürekli gönderir, sunucu medya parçası + sonraki istek talimatı döner. Bazı videolarda medya PO token olmadan verilmez. Token'ın imza sırrı sunucuda, çevrimdışı üretilemez. | https://priveetee.github.io/Docs-PipePipe/developer-guide/sabr-origins.html, https://priveetee.github.io/Docs-PipePipe/extractor/sabr.html |
| UMP/SABR için MIT lisanslı JS kütüphanesi: `UmpReader`, `SabrStream`, Shaka adaptörü. Girdi alanları: `serverAbrStreamingUrl`, `videoPlaybackUstreamerConfig`, `poToken`. | https://ytjs.dev/googlevideo/, https://ytjs.dev/googlevideo/api/exports/sabr-stream/interfaces/SabrStreamConfig, https://jsr.io/@luanrt/googlevideo |
| Bir kullanıcı betiği `serverAbrStreamingUrl`'yi silmenin artık oynatmayı bozduğunu yazıyor. Bu, web oynatıcının SABR'a bağımlı olduğuna dolaylı bir işaret. | https://greasyfork.org/ka/scripts/485020-ytbetter-enable-rewind-dvr/versions (**dolaylı**) |
| Chrome Web Store: "Do not encourage, facilitate, or enable the unauthorized access, download, or streaming of copyrighted content or media." | https://developer.chrome.com/docs/webstore/program-policies/policies |
| Gerçek ret örneği: "Facilitating unauthorized access to or download of copyrighted content or media, specifically, YouTube" (ret kodu "Blue Zinc"). Hangi özelliğin tetiklediği belirtilmemiş. | https://groups.google.com/a/chromium.org/g/chromium-extensions/c/K17UE-7Bjgs |

**Doğrulanamayanlar:** Web oynatıcının (masaüstü Chrome, oturum açık) 2026 Kasım itibarıyla **her** videoda SABR kullandığı. `getPlayerResponse()`'un `serverAbrStreamingUrl`/ustreamer alanlarının tam JSON yolu. googlevideo'nun youtube.com kökenine verdiği CORS başlıkları. Bunları §4'teki cihaz denemesi netleştirir.

## 4. Bu ortamdan deneme ve cihazda 5 dakikalık deneme

### 4.1 Bu ortamda ne denendi (çıktılar)
| Deneme | Sonuç |
|---|---|
| `curl https://www.youtube.com/watch?v=jNQXAC9IVRw` | `302` → `https://www.google.com/sorry/index?...` (bot doğrulaması) |
| `POST /youtubei/v1/player`, istemci `WEB` | `200`, `playabilityStatus: LOGIN_REQUIRED` "Sign in to confirm you're not a bot", `streamingData` yok |
| Aynı, `WEB_EMBEDDED_PLAYER` / `TVHTML5_SIMPLY_EMBEDDED_PLAYER` | `ERROR` "This video is unavailable" / "no longer supported" |
| Playwright Chromium (vekil üzerinden) watch sayfası | `429`, google.com/sorry; `ytInitialPlayerResponse` yok |
| `*.googlevideo.com` bağlantısı | Vekil: `502 connect_unreachable` |

**Sonuç: bu ortamdan YouTube'a gerçek erişim yok.** `url` / `signatureCipher` / SABR durumu ve aralık isteği burada **doğrulanamadı**. Plandaki "3 video" ölçümü yapılamadı.

### 4.2 Kullanıcının kendi Chrome'unda yapacağı deneme (≈5 dk, 3 video: biri kısa, biri 30 dk+, biri müzik klibi)
1. Bir videoyu açın ve oynatın. Eklentiyi kapatmak gerekmez. F12 → Console, sayfa bağlamı "top" seçili olsun.
2. Aşağıdaki kodu yapıştırın:
```js
(async () => {
  const pr = document.getElementById('movie_player')?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
  const sd = pr?.streamingData || {};
  const s = JSON.stringify(pr || {});
  console.log('SABR url:', !!sd.serverAbrStreamingUrl, '| ustreamer cfg:', s.includes('videoPlaybackUstreamerConfig'),
    '| adaptif:', (sd.adaptiveFormats || []).length);
  const aud = (sd.adaptiveFormats || []).filter((f) => /^audio/.test(f.mimeType));
  console.table(aud.map((f) => ({ itag: f.itag, mime: f.mimeType, url: !!f.url, cipher: !!(f.signatureCipher || f.cipher), bytes: f.contentLength })));
  const a = aud.find((f) => f.url);
  if (a) {
    try {
      const r = await fetch(a.url + '&range=0-65535');
      console.log('aralık isteği:', r.status, (await r.arrayBuffer()).byteLength, 'bayt');
    } catch (e) { console.log('aralık isteği hata:', e.message); }
  } else console.log('Doğrudan URL yok: b1 bu videoda yapılamaz.');
  const v = document.querySelector('video');
  if (v?.buffered.length) console.log('ileri tampon (sn):', (v.buffered.end(v.buffered.length - 1) - v.currentTime).toFixed(1));
})();
```
3. Network sekmesinde filtreye `videoplayback` yazın. İsteklerin yöntemine (GET mi POST mu), `Content-Type`'ına (`application/vnd.yt-ump` mu) ve URL'de `sabr=1` geçip geçmediğine bakın. Bir isteğin yanıt başlıklarında `access-control-allow-origin` değerini not edin.
4. İsteğe bağlı: sağ tık → "Stats for nerds" → "Buffer Health" değerini 1 dk boyunca izleyin (30–120 sn varsayımı için).
5. Sonuçları bu belgeye ekleyin (video süresi, oturum açık mı, çıktılar).

**Okuma kuralı:** 3 videonun hiçbirinde ses girdisinde `url` yoksa ya da aralık isteği 403 dönüyorsa **b1 kapanır**. `SABR url: true` ve `cipher` yoksa yt-dlp bulgusu cihazda da doğrulanmış olur.

## 5. Gizlilik ve mağaza politikası (dürüst not)

- **İzin:** İstek MAIN dünyasından (sayfanın kendi `fetch`'i) yapılırsa yeni host izni gerekmeyebilir (**tahmin**, §4.2 adım 3'teki CORS başlığına bağlı). Arka plan ya da offscreen belgesinden yapılırsa `https://*.googlevideo.com/*` izni gerekir. Bu izin kurulumda ve güncellemede "googlevideo.com'daki verilerinizi okuma ve değiştirme" uyarısı çıkarır. Güncellemede eklenti, kullanıcı onaylayana kadar devre dışı kalır.
- **gizlilik.html:** b1, b2 ya da b3 gelirse `site/gizlilik.html` ağ tablosuna (bugün huggingface.co satırının bulunduğu tablo, `gizlilik.html:76` civarı) şu satır eklenmeli: "**googlevideo.com (YouTube'un video sunucusu)** · Yalnız 'Tüm videoyu hazırla' açıkken; izlediğiniz videonun sesini bir kez daha, önceden indirmek için · YouTube oynatıcısının gönderdiği bilgilerin aynısı (çerezler, oturum belirteci); LocaDub kendi verisini eklemez." Ayrıca `gizlilik.html:62`deki "yalnızca bellekte tutulur" cümlesi c+ / A4 ile birlikte "diskte (OPFS) tutulur, X gün ya da Y GB sonra silinir" olarak güncellenmeli.
- **Chrome Web Mağazası:** Politika YouTube'u adıyla anmıyor, ama "unauthorized access, download, or streaming" yasağı var. Somut bir ret örneği "specifically, YouTube" ifadesiyle ret veriyor (§3). Eklentinin kendisi googlevideo'dan medya çekerse (b1/b2-SABR), sonuç diske kaydedilmese bile inceleyici bunu "indirici" sayabilir. **Risk yüksek** (tahmin, ama kaynaklı). İndirmeyi saklamak için gizlemek ya da yanıltıcı açıklama yazmak hem politika ihlalidir hem de yapılmamalıdır. b3 ağ isteği yapmasa da kullanıcıya görünmeyen oynatma ve görüntülenme yan etkisi nedeniyle gri alanda kalır. c ve c+ yalnız oynatıcının zaten çaldığı sesi işler: bugünkü "gerçek dublaj" ile aynı risk düzeyindedir.

## 6. Öneri ve sıra

1. **Hemen (A0 kapanışı):** §4.2 cihaz denemesi, 3 video. Başarısızlık ölçütü: 3 videoda da ses girdisinde `url` yok, ya da aralık isteği ≠ 206/200, ya da 64 KB'tan az bayt dönüyor. Beklenen sonuç bu ölçütün tutması (§3).
2. **v1.0 kapsamı = c + c+.**
   - A1–A3 değişmez: çeviri ve TTS tümüyle hazırlanır.
   - Arayüz ayırma için "oynatırken hazırlanır" der. İlk izlemede ayırma ilerlemesi oynatma konumu + `SEP.high` kadar gider.
   - **A5 yeniden tanımlanır.** Eski tanım: "Tam ses akışını indirme". Yeni tanım: "Yakalanan ses akışını OPFS'e akıt, tam kipte `SEP_CAP` bellekten kalksın, boşta yakalanmış ama ayrılmamış aralıkları işle". Kaynak tarafı `main-world.js:82-94`, alıcı tarafı `separation.js:434-458`'dir. Yeni ağ isteği yok, yeni izin yok. Kazanç: ikinci izleme, geri sarma ve aynı videoyu yeniden açma anında hazır olur.
   - **A4 korunur ve önemi artar.** Ayrılmış eşliği opus + OPFS'e yazmak artık hem bellek sorununu çözer hem de "bir kez ayır, hep çal" önbelleği olur. Anahtar: `videoId` + itag/ses kimliği + model sürümü.
3. **Yalnız 1. adım olumlu çıkarsa (beklenmez): b1 denemesi.** MAIN dünyasından, oynatıcının kullandığı biçimle aynı itag, `range` parçalarıyla, hız sınırlı (≤ 4× gerçek zaman) yapılır. Başarısızlık ölçütleri: 403/429, `n` kısıtlaması (≈ gerçek zaman hızına düşme) ya da 3 videodan birinde bile bozuk demux. Mağaza riski nedeniyle ayrı bir deneysel ayar arkasında tutulmalı, varsayılan kapalı olmalı.
4. **Önerilmeyenler:** b2-SABR (kırılgan, yüksek mağaza riski) ve b3 (kazancı sınırlı, gizli oynatma). İleride gerekirse b3 yalnız açık kullanıcı onayıyla ve görünür bir "ön dinleme" olarak düşünülebilir.

| İş | Önceki kapsam | Yeni kapsam |
|---|---|---|
| A4 | Ayrılmış eşlik → opus + OPFS, `PcmTimeline` disk kaynağı | Aynı. Ek olarak kalıcı anahtar ve kota (yeniden izleme önbelleği) |
| A5 | Tam ses akışını indir, ayırma kuyruğuna ver | Yakalanan MSE sesini OPFS'e akıt (`SEP_CAP` kalkar) + boşta geride kalan aralıkları ayır. İndirme yok |
| A3 | "Hazır olunca başlat" | Bu seçenek yalnız çeviri ve ses içindir. Ayırma ilk izlemede hazır olmayacağı için düğme metni bunu söylemeli |
