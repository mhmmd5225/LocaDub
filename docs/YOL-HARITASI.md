# Yol haritası (0.5.2 sonrası)

Hedef: **kişisel kullanım, sağlamlık** (Mac mini M4, RTX 5060 16 GB Windows). Zayıf cihazlar için ayarlanabilir ses ayırma kalitesi.
Rapor: `docs/PERFORMANS-RAPORU.md`. Görevler Sonnet 5.5'in tek tek yapabileceği boyutta; her biri ayrı commit.

## Çalışma kuralları (her görev için)
- Dal: `claude/adoring-dijkstra-2es6yp` (yoksa `origin/main`'den oluştur). Commit mesajı Türkçe; sonunda
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` ve `Claude-Session: <oturum bağlantısı>`.
- **Alt ajan yok.** Dosya yazarken `Write`/`Edit` kullan. Kabukta metin içinde ters tırnak varsa heredoc sınırlayıcısını tırnakla (`<<'EOF'`);
  tırnaksız heredoc kabuğun metindeki komutları çalıştırmasına yol açtı.
- Görev sonu: `node --test tests/extension/*.test.mjs` (dizin biçimi Node 22'de çalışmaz) + ilgili e2e
  (`xvfb-run -a node tests/extension/e2e/<ad>.e2e.cjs`). Tümü geçmeden commit yok.
- Kod stili: ES modül, 2 boşluk, çevredeki yoğunlukta kısa Türkçe yorum, Türkçe arayüz metni. Model kimliği dosyalara/commit'e yazılmaz.
- PR / birleştirme / site yüklemesi yalnız kullanıcı "yükle" derse. Her faz sonunda `extension/manifest.json` sürümü artırılır.

## FAZ 1 — Ölç ve görünür kıl (0.5.3)

### T1. "Hız testi" düğmesi (M) — **yapıldı** (Diğer sekmesi → Tanılama; `common/bench.js`)
- **Amaç:** M4/RTX'te gerçek WebGPU hızlarını ölçmek; `batch` seçimi için veri.
- **Dosyalar:** `extension/options/options.{html,js,css}` (AI Model sekmesi), `extension/background.js` (mesaj),
  `extension/offscreen.js` / `extension/sep/host.js` (ayırma işçisi sınaması), yeni `extension/common/bench.js` (saf yardımcılar).
- **Adımlar:**
  1. Düğme → `bench.run` mesajı; sonuçlar tablo + "Kopyala".
  2. Ayırma: 12 sn sentetik stereo ile `engines/sep/worker.js`'e `load { backend:'auto', batch }` ve `process`; `batch` ∈ {1, 2, 4, 8}
     (WebGPU'da; WASM'da yalnız 1). Isınma hariç 2 çalıştırma ortalaması → pencere/sn, RTF.
  3. TTS: sabit 3 cümleyi seçili sesle üret → sentez süresi / ses süresi, backend.
  4. MT: 8 cümle çeviri → cümle/sn.
  5. Sonuç Tanılama raporuna `[Hız testi]` bölümü olarak eklenebilir (`common/diagnostics.js`).
- **Kabul:** tüm sonuçlar < 90 sn; WebGPU yoksa "WebGPU yok" + WASM sonuçları; hatada kısmi sonuç + hata satırı.
- **Test:** `tests/extension/bench.test.mjs` (ortalama, rtf, biçim); `options-nav` e2e'de düğme ve mock sonuç tablosu.

### T2. Hata görünürlüğü (S–M)
- **Dosyalar:** yeni `extension/common/errlog.js` (`logError(scope, err)`; en çok 50 kayıt; aynı (scope, mesaj) 10 sn içinde tekrar yazılmaz;
  `chrome.storage.session`), `common/diagnostics.js` ("Son hatalar" kaynağı), ilgili dosyalar.
- **Adımlar:** `grep -rn "catch {" extension --include=*.js`. **Kural:** `revokeObjectURL`, `closeDocument`, DOM temizliği, `dispose` sessiz kalır;
  `fetch`, model yükleme, `AudioContext`, port/`postMessage`, ayırma/TTS/MT çağrıları `logError('<alan>', e)` çağırır. Kararı yorumda belirt.
- **Kabul:** raporda `alan: mesaj (n kez)`; e2e'de enjekte edilen hata görünür.
- **Test:** `errlog.test.mjs` (tekrar bastırma, 50 sınırı), `diagnostics.e2e`.

### T3. Bellek ve zaman kırılımı (S)
- **Dosyalar:** `content/separation.js` (paket baytı, PCM saniyesi, blob sayısı), `content/app.js` (cümle sesi / blob URL sayısı),
  `common/diagnostics.js` (`[Bellek]`: `performance.memory.usedJSHeapSize` varsa, paketler MB, PCM sn, blob adedi), `background.js` (`diag.separation` alanları).
- **Zaman kırılımı:** başlangıç satırına `ses motoru yükleme`, `ilk çeviri`, `ilk sentez` ayrımı (`content/timing.js`).
- **Kabul:** rapor `[Bellek]` ve ayrıntılı başlangıç satırı içerir. **Test:** `diagnostics.test.mjs`.

### T4. Güncelleme denetimine yedek adres (S) — yüksek değer
- **Dosyalar:** `extension/common/version.js`, `extension/manifest.json` (`host_permissions` + `https://mhmmd5225.github.io/*`), `update-banner.e2e.cjs`.
- **Adımlar:** adres listesi `[localdub.mhmmd.app, mhmmd5225.github.io/LocaDub]`; ikisini dene, **büyük sürümü** kullan; biri düşerse diğeriyle devam;
  indirme bağlantısı büyük sürümün geldiği adresin `LocaDub.zip`'i.
- **Kabul:** ilk adres 0.2.1, ikincisi 0.5.2 verirse şerit 0.5.2; ikisi de yoksa sessiz. **Test:** e2e iki yanıt senaryosu + sürüm karşılaştırma birim testi.

### T5. `speaker-voices` e2e kararsızlığı (S)
- 10 kez art arda çalıştır, zaman aşımına düşen adımı bul, sabit beklemeyi koşul beklemesine çevir. **Kabul:** 10/10 geçer.

## FAZ 2 — Kararlılık (0.5.4)

### T6. Boşta CPU azaltma (S–M)
- **Dosyalar:** `content/app.js`, `content/separation.js`.
- **Adımlar:** (1) `_pitchTimer` yalnız eski perde yolu etkinken (`_genderOn() && !_spkOn()`) kurulsun, durum değişince yeniden değerlendirilsin;
  (2) `document.hidden` ve video durmuşken `tick` 500 ms, görününce 100 ms (`visibilitychange`); (3) `PERSIST_MS` yazması yalnız değişiklik varsa.
- **Kabul:** gizli sekmede saniyedeki tick ≤ 2 (e2e sayaç); hold-start, separation, gender e2e geçer. Önce/sonra tick sayısını commit mesajına yaz.

### T7. Soak e2e: seek / reklam / gezinme (M)
- **Dosya:** yeni `tests/extension/e2e/soak.e2e.cjs` (`launch({ mse: true })`; bkz. `separation.e2e.cjs`).
- **Senaryo (≈ 90 sn):** 20 rastgele seek (sabit tohum), oynatma hızı 1 → 1.25 → 1, 2 sahte reklam (`ad-showing` sınıfı), 2 SPA gezinmesi (başka video kimliği).
  Her adımda: `pageerror` yok; sonunda ayırma `playing`/`buffering`; `blob:` URL sayısı başlangıçtan en çok +30; `iframe[src*="sep/host"]` ≤ 1.
- **Kabul:** 3 çalıştırmada geçer; bulunan sızıntılar aynı commit'te düzeltilir.

### T8. Offscreen / servis işçisi yeniden başlama dayanıklılığı (M)
- **Dosyalar:** `extension/background.js`, motor istek yolu (`sendBg` kullanımı `content/*`), yeni `tests/extension/e2e/offscreen-restart.e2e.cjs`.
- **Adımlar:** test `chrome.offscreen.closeDocument()` çağırır, ardından bir TTS/MT isteği gönderir; istek **bir kez otomatik yeniden denenir**
  (offscreen yeniden oluşturulur) ve başarılı olur. `NOT_APPROVED` dışındaki hatalarda 1 yeniden deneme.
- **Kabul:** e2e geçer; tanılamada "yeniden denendi" sayacı.

## FAZ 3 — Performans (0.6.0)

### T9. Ayarlanabilir ses ayırma kalitesi (M)
- Varsayılan **Yüksek**; Dengeli / Hızlı kullanıcı seçimiyle.
- **Dosyalar:** `common/settings.js` (`separationQuality: 'high'|'balanced'|'fast'`, varsayılan `'high'`, `normalizeSettings`, `diagnostics.js` SETTING_KEYS),
  `engines/sep/models.js` (eşleme), `sep/host.js` / `content/separation.js` (`load` seçenekleri), `options/*` (AI Model sekmesi: üç seçenek + hız/kalite notu),
  `content/panel.js` (Ses ayırma adımında kalite etiketi).
- **Eşleme:** Yüksek = `kim-vocal-2`, `overlap 0.5`; Dengeli = `kim-vocal-2`, `overlap 0.25` (≈ 1.5× daha az pencere);
  Hızlı = `mdxnet-lite`, `overlap 0.25` (≈ 3–5× daha hızlı; SDR ≈ 16.8 vs 18.1 dB, `docs/SES-AYIRMA.md`). GPU yokken `auto` davranışı korunur.
- **Not:** kalite değişince ayırıcı yeniden yüklenir, önbellek temizlenir (`dispose` + yeniden `spawn`); oynatma "buffering"e düşer.
- **Kabul:** ayarlarda üç seçenek; seçim motora yansır (mock `loaded` cevabından doğrulanır); tanılama raporunda kalite görünür.
- **Test:** `settings` birim testi; `separation.e2e`'de kalite değişimi → yeniden yükleme; `options-nav` 1280×720 kaydırmasız.

### T10. WebGPU `batch` otomatik seçimi (M) — T1 verisine bağlı
- T1 sonuçlarına göre varsayılan `batch` belirle. İlk yüklemede ısınma sırasında 1 ve seçilen değeri dene, en hızlıyı cihaz anahtarıyla
  (`adapter.info` varsa) `chrome.storage.local`'a yaz. Hata olursa bir alt `batch`'e düş (mevcut yedek yol).
- **Kabul:** ikinci yüklemede deneme yapılmaz, kayıtlı değer kullanılır. **Test:** `sep.test.mjs`'te seçim mantığı (saf fonksiyon).

### T11. Geri sarmayı ucuzlatma (S)
- `SEP.keepBehindSec` 15 → 60 (`content/sep-core.js`); bellek bedeli ≈ 21 MB. `[Bellek]`'te PCM saniyesi görünür.
- **Kabul:** `separation.e2e`: 40 sn oynat, 30 sn geri sar → yeniden ayırma işi başlamaz (iş sayacı değişmez).

### T12. Başlangıç gecikmesini daralt (M) — T3 verisine bağlı
- T3 kırılımına göre darboğaz belirlenir. Kural: **önce ölç, yalnız en büyük kalemi düzelt.** Adaylar: ilk iki cümlenin çeviri + sentezini paralel başlat;
  TTS ısınma sentezini model yüklenir yüklenmez başlat; ilk grup boyunu (`trBatchSize`) koru.
- **Kabul:** M4 raporunda "ilk ses" medyanı düşer (önce/sonra tanılama satırıyla kanıtla); `hold-start` e2e geçer.

## FAZ 4 — Sonra (ayrıntısı yazılmadı)
- Mağaza hazırlığı (`docs/STORE.md` kontrol listesi, izin sadeleştirme, ekran görüntüleri) — hedef kişisel kullanım olduğu için son sırada.
- Sentetik seslerde konuşmacı tutarlılığı (%89 → %95): ek gerçek konuşma verisiyle eşik ayarı.
- Reklam sonrası ayırma önbelleğini koruma; 1x dışı oynatma hızında ayırma (perde korumalı yeniden örnekleme).
- AAC (mp4) video doğrulaması (cihazda), DRM / canlı yayın bildirimi.

## Sıra ve bağımlılık
`T1 → (T3) → T2 → T4 → T5` (Faz 1, 0.5.3) · `T6 → T7 → T8` (Faz 2, 0.5.4) · `T9`, `T10 (T1'e bağlı)`, `T11`, `T12 (T3'e bağlı)` (Faz 3, 0.6.0).
Her fazın sonunda tüm birim + e2e, sürüm artır, push; kullanıcı "yükle" derse PR → birleştirme → Pages doğrulaması.

## Kullanıcıdan beklenenler (görevleri engellemez, veri sağlar)
1. T1 hazır olunca "Hız testi"ni M4 ve RTX 5060'ta çalıştırıp çıktıyı paylaşmak (T10 / T12 kararları buna dayanır).
2. DNS / Pages geçişi (localdub.mhmmd.app): T4 bunu beklemeden çalışır, kalıcı çözüm DNS.
3. Hugging Face token'ının iptali; eski uzak dalların GitHub arayüzünden silinmesi.
