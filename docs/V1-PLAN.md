# LocaDub v1.0 planı

Durum: 0.5.14 dalda hazır (yayınlanmadı). Bu belge v1.0'a giden işi tanımlar. **Kod yazılmadı; yalnız plan.**
Başlatmak için: yeni oturumda modeli Fable yapıp "docs/V1-PLAN.md planını başlat" demek yeterli.

## 1. v1.0'ın hedefi

1. **Tam video dublajı:** baştan sona izlenecek videoda tüm çeviri, ses ve ses ayırma önceden hazırlanır; oynatma boyunca bekleme olmaz.
2. **Yeni arayüz:** oynatıcı paneli, açılır pencere ve ayarlar sayfası tek bir tasarım diliyle baştan yapılır.
3. **Cihaz profilleri:** RTX 5060 Ti (Windows) ve Mac mini M4 için ayrı, ölçüme dayalı ayarlar.
4. **Kararlılık:** v1.0 etiketi; bilinen açık sorunların kapatılması, tam test turu, sürüm notları.

Kapsam dışı (v1.0'da yok): WebNN/NPU (denendi, kaldırıldı), ses klonlama (denendi, reddedildi), Chrome Web Mağazası gönderimi
(ayrı iş, `docs/STORE.md`), 1x dışı oynatma hızında ayırma.

## 2. Yönetim modeli (kota için)

| Rol | Model | Ne yapar |
|---|---|---|
| Yönetici | **Fable** | Planı yürütür, işleri dağıtır, her işin diff'ini ve test çıktısını inceler, birleştirir, kullanıcıyla konuşur. Kendi kod yazmaz; yalnız inceleme düzeltmeleri (birkaç satır) ve mimari kararlar. |
| Orta işler | **Opus** | Birden çok dosyaya dokunan, tasarım kararı içeren işler: tam video dublaj çekirdeği, cihaz profilleri, panel yeniden yazımı, ayırma zamanlayıcısı. |
| Basit işler | **Sonnet** | Sınırları net işler: CSS/HTML, metinler, ayar anahtarı ekleme, test yazma, belge, sürüm/yayın adımları. |

Kurallar:
- Yönetici her işi `Agent` aracıyla, kartta yazan modelle (`model: "opus"` / `"sonnet"`) başlatır; iş kartı (§6) alt ajana **aynen** verilir
  (alt ajan sıfırdan başlar: dosya yolları, kabul ölçütü ve test komutları kartta olmalı).
- Aynı dosyaya dokunan işler sırayla, dokunmayanlar paralel (en çok 3) yürür. Paralel işler `isolation: "worktree"` ile.
- Alt ajan işi bitirince: değişen dosyalar, çalıştırdığı testler ve çıktıları, yapamadığı şeyler. Yönetici diff'i okur, testleri **kendisi
  yeniden çalıştırır**, sonra commit eder. Test çıktısı olmayan "geçti" beyanı kabul edilmez.
- İki kez başarısız olan Sonnet işi Opus'a, iki kez başarısız olan Opus işi yöneticiye çıkar.
- Bu, önceki "alt ajan yok" kararının yerini alır (kullanıcı kararı, 2026-11-10).
- Dürüst not: kota kazancı garanti değil; yöneticinin okuduğu her diff Fable kotasından gider. Kartlar küçük tutulursa kazanç artar.

Değişmeyen kurallar: dal `claude/adoring-dijkstra-2es6yp`; her iş ayrı commit, Türkçe mesaj; PR/birleştirme/site yalnız kullanıcı "yükle" deyince;
model kimliği commit/dosyalara yazılmaz; jeton istenmez; her iş sonunda `node --test tests/extension/*.test.mjs` + ilgili e2e
(`xvfb-run -a node tests/extension/e2e/<ad>.e2e.cjs`).

## 3. Özellik A — Tam video dublajı

### Bugünkü durum (koddan)
- Hazırlık kayan pencereyle yapılır: `settings.lookaheadSec` (10–120 sn, varsayılan 30) kadar ileri çevrilir ve seslendirilir
  (`content/app.js` `loopTr`/`loopAu`, `windowIndices`); ses ayırma `SEP.high` 8 sn + parça kadar ileri gider (`content/sep-core.js`).
- Sesler geride 90 sn / ileride `lookahead + 120` sn tutulur (`KEEP_AHEAD_EXTRA_SEC`); ayrılmış PCM geride 15 sn (`SEP.keepBehindSec`).
- 0.5.5'te oynatıcı çubuğunda hazır aralık işaretleri var (`content/progressmarks.js`); çeviri önbelleği kalıcı (son 50 video).
- Yakalanan ses MAIN dünyasında 32 MB ile sınırlı (`content/main-world.js SEP_CAP`), yani ≈ 30 dk opus.

### Hedef davranış
Oynatıcı panelinde **"Tüm videoyu hazırla"** düğmesi (panel başlığında, ana anahtarın yanında; kapalıyken bugünkü davranış):
1. Basılınca video duraklatılmaz; arka planda sırayla **tüm çeviri → tüm ses → tüm ses ayırma** hazırlanır.
2. Panelde tek ilerleme: "Çeviri 412/493 · Ses 18:20 / 42:10 · Ayırma 12:05 / 42:10 · tahmini 6 dk". İlerleme çubuğundaki işaretler dolar.
3. Kullanıcı beklemeden izlemeye başlayabilir (hazır olan yerden çalar) ya da "Hazır olunca başlat" seçebilir.
4. İptal: düğmeye yeniden basmak; hazırlananlar kalır.
5. Tamamlanınca: "Video hazır" durumu; sarma/geri alma anında.

### Teknik tasarım
- **Kip:** `Session.fullMode` (sekmeye ve videoya özel; ayarlara yazılmaz). `windowIndices` çağrıları `fullMode` iken pencereyi video sonuna
  kadar genişletir; öncelik yine oynatma konumuna en yakın cümlelerde (önce pencere, sonra geri kalan).
- **Bellek bütçesi (asıl risk):**
  - Cümle sesi: 22 kHz int16 WAV ≈ 2.6 MB/dk. 60 dk ≈ 160 MB blob. Çözüm: sesleri **Cache API**'ye (ya da OPFS) yaz, bellekte yalnız
    pencere tutulur (`sentence.audio` → tembel `cacheKey`); anahtar `audioKey` + cümle özeti. Kota: video başına sınır yok, toplam 2 GB,
    en eski video silinir. Bu aynı zamanda yeniden izlemede sentezi atlatır.
  - Ayrılmış PCM: 44.1 kHz stereo float ≈ 21 MB/dk → 60 dk 1.3 GB, bellekte tutulamaz. Çözüm: ayrılmış eşlik **opus'a kodlanıp** (WebCodecs
    `AudioEncoder`, 96 kb/sn ≈ 0.7 MB/dk) OPFS'e yazılır; çalarken pencere çözülür (`PcmTimeline` kaynağı: bellek → disk). Kalite kaybı ölçülür
    (SNR; hedef duyulmaz).
  - Yakalama: tüm videonun kodlanmış sesi gerekir. `SEP_CAP` tam kipte kaldırılamaz (bellek); çözüm: tam kipte paketler MAIN'den geldikçe
    içerik betiğinde OPFS'e akıtılır. Ama **YouTube yalnız tamponladığı kadarını indirir** (≈ 30–120 sn ileri). Seçenekler, iş A0'da ölçülür:
    (a) videoyu sessizce ileri sararak tamponlatmak — kullanıcıyı bozar, reddedilir;
    (b) ses akışını eklentinin kendisi indirmesi (oynatıcının `streamingData` adaptif ses URL'si, aralık istekleri) — mümkünse en temiz yol;
    (c) yapılamazsa tam kip yalnız çeviri + sesi tümüyle hazırlar, ayırma yine oynatmanın önünden gider ve arayüz bunu açıkça söyler.
- **Süre tahmini:** `separation.rtf`, TTS rtf ve çeviri hızı zaten ölçülüyor; ETA bunlardan.
- **Güç/ısı:** tam kipte GPU hız sınırı `pacePlay` (0.6) ile çalışır; "hızlı hazırla" seçeneği sınırı kaldırır.

### İşler
| No | İş | Model | Not |
|---|---|---|---|
| A0 | Ses akışının tamamını elde etme araştırması: (b) yolu gerçek YouTube'da denenir, 3 video; sonuç `docs/TAM-VIDEO.md` | Opus | Karar noktası: (b) çalışmazsa A4–A5 küçülür. Kod değil, ölçüm ve rapor. |
| A1 | `fullMode`: çeviri ve ses döngülerinde pencereyi videoya genişlet, öncelik sırası, iptal | Opus | `content/app.js`; e2e: sahte 10 dk video, tümü hazırlanır |
| A2 | Cümle seslerini Cache API'ye taşı (tembel yükleme, kota, temizlik) | Opus | Bellek: `[Bellek]` raporu önce/sonra |
| A3 | Panel: "Tüm videoyu hazırla" düğmesi, ilerleme, ETA, "hazır olunca başlat" | Sonnet | B2'den sonra (yeni panel üstüne) |
| A4 | Ayrılmış eşliği opus + OPFS'e yaz, `PcmTimeline` disk kaynağı | Opus | A0 sonucu (b) ise |
| A5 | Tam ses akışını indirip ayırma kuyruğuna verme | Opus | A0 sonucu (b) ise |
| A6 | Testler: birim (pencere/öncelik, kota), e2e `full-video`, soak 30 dk sahte video bellek sınırı | Sonnet | |

## 4. Özellik B — Yeni arayüz

### Bugünkü durum
Üç yüzey, üç ayrı CSS: `content/panel.css` (425 satır) + `panel.js` (729), `popup/*` (≈ 475), `options/*` (≈ 1800). Ayarlar sayfası
1280×720'ye kaydırmasız sığma kuralı yüzünden sıkışık; son eklenenler (`Otomatik güncelleme ve ayırma`) açılır kutuya tıkıldı.

### Hedef
- **Tek tasarım sistemi:** `common/ui/tokens.css` (renk, aralık, yarıçap, tipografi, koyu/açık), `common/ui/components.css`
  (düğme, anahtar, seçim, kaydırıcı, kart, rozet, ilerleme, bildirim). Üç yüzey bunu kullanır.
- **Dil:** sade, yoğun olmayan, sistem yazı tipi; tek vurgu rengi; durum renkleri (hazır / hazırlanıyor / uyarı / hata) her yerde aynı.
  "AI görünümü" yok (mor gradyan, parıltı, emoji başlık yok). Referans: site tasarımıyla aynı aile (`site/index.html`).
- **Oynatıcı paneli (en çok kullanılan yüzey):** hap → panel. Panelde üç bölüm: *Durum* (tek satır + ilerleme; ayrıntı açılır),
  *Ses* (dublaj/orijinal ses düzeyi, ses seçimi, konuşmacılar), *Hazırlık* (tüm videoyu hazırla, hazır aralıklar). Klavye ve ekran okuyucu tam.
- **Açılır pencere:** durum kartı + etkin sekme anahtarı + ses seçimi + güncelleme şeridi; başka bir şey yok.
- **Ayarlar:** sol gezinme, kaydırılabilir içerik (1280×720 kaydırmasız kuralı **kaldırılır**; yerine "her bölüm tek ekranda başlar").
  Bölümler: Genel · Sesler · Modeller ve indirme · Ses ayırma ve performans · Sözlük · Güncelleme · Tanılama.
  Cihaz profili (§5) ve Hız testi "Ses ayırma ve performans"ta.
- **Önce tasarım, sonra kod:** B0 statik HTML maketleri üretir; kullanıcı onaylamadan B1+ başlamaz (site tasarımı üç tur sürdü; aynı risk).

### İşler
| No | İş | Model | Not |
|---|---|---|---|
| B0 | Üç yüzeyin statik maketleri (açık/koyu, 3 genişlik), ekran görüntüleri kullanıcıya | Opus | **Kullanıcı onayı beklenir** |
| B1 | Tasarım sistemi dosyaları + mevcut bileşenlerin eşlemesi | Sonnet | |
| B2 | Oynatıcı paneli yeniden yazımı (`panel.js` davranışı korunur, görünüm ve yapı yeni) | Opus | e2e `player-panel` güncellenir |
| B3 | Açılır pencere | Sonnet | e2e `popup-header`, `update-banner`, `popup-update-now` |
| B4 | Ayarlar sayfası (yeni gezinme, bölümler, kaydırma) | Opus | e2e `options-nav` yeniden yazılır (taşma yerine erişilebilirlik ve bölüm denetimi) |
| B5 | Erişilebilirlik ve görsel denetim: kontrast, odak, klavye, 200% yakınlaştırma; ekran görüntüsü karşılaştırma | Sonnet | |

## 5. Özellik C — Cihaz profilleri

### Bilinenler (ölçülmüş)
- **RTX (Windows):** toplu boyut 4 sürücü çökmesi (TDR ≈ 2 sn) yaptı → 0.5.4'te toplu 1 + GPU hız sınırı. Gerçek hız hiç raporlanmadı.
- **Mac mini M4:** başlangıç 4.5–12.6 sn; ayırma "geride kalabiliyor" (0.5.1'de üç neden düzeltildi); hız raporu yok.
- **Intel iGPU (Core Ultra 7 265):** Kim Vocal 2 2.4–3.3 rtf (yetişmiyor); hafif model ölçülmedi.
- Seslendirme varsayılanı WASM (4 iş parçacığı); çeviri WASM.

### Tasarım
- `common/device-profile.js`: `detectProfile({ adapter, platform, cores, memory })` → `'rtx' | 'apple' | 'igpu' | 'cpu'`
  (WebGPU `adapter.info.vendor/architecture`, `navigator.userAgentData.platform`). Elle seçim: Ayarlar → Otomatik / RTX / Apple Silicon / Dahili kart / İşlemci.
- Profil bir **parametre tablosu**dur; kod yolları aynı kalır:

| Parametre | RTX 5060 Ti 16 GB (masaüstü) | Mac mini M4 | Dahili kart | İşlemci |
|---|---|---|---|---|
| Ayırma modeli | Kim Vocal 2 | Kim Vocal 2 | hafif model | hafif model |
| Toplu boyut | ölçümle 1–2 (TDR sınırı: tek iş < 0.8 sn) | ölçümle 1–4 (TDR yok) | 1 | 1 |
| GPU hız sınırı | açık (0.25 / 0.6) | kapalı ya da gevşek (birleşik bellek, TDR yok) | kapalı | — |
| Akış parçası | 24 sn | 24 sn | 12 sn | 12 sn |
| TTS aygıtı | ölçümle WebGPU ya da WASM | ölçümle WebGPU ya da WASM | WASM | WASM |
| Ön tampon / lookahead | 20 / 30 | 20 / 30 | 30 / 45 | 45 / 60 |
| Tam video hazırlama hızı | sınırsız seçeneği açık | sınırsız seçeneği açık | kapalı | kapalı |

- Tablodaki "ölçümle" değerleri **tahminle doldurulmaz**: C1 Hız testini genişletir, kullanıcı iki cihazda çalıştırır, C3 sayıları yazar.
- Hibrit dizüstü (Intel + RTX): Chrome Windows'ta kart tercihini yok sayar; profil `igpu` çıkar ve arayüz
  `chrome://flags/#force-high-performance-gpu` adımını gösterir (mevcut davranış, `docs/SES-AYIRMA.md`).

### İşler
| No | İş | Model | Not |
|---|---|---|---|
| C1 | Hız testini genişlet: toplu 1/2/4 (TDR korumalı), hız sınırı açık/kapalı, TTS WebGPU ve WASM, tek pencere süresi; çıktı tek metin | Opus | `common/bench.js`, `options.js` |
| C2 | `device-profile.js` + ayar + tablo + tanılama satırı (`profil: rtx (otomatik)`) | Sonnet | Saf fonksiyon, birim testli; değerler başta bugünkü varsayılanlar |
| C3 | **Kullanıcı:** RTX 5060 Ti ve Mac mini M4'te Hız testi çıktısı | — | Engel: C4 bunu bekler |
| C4 | Ölçümlere göre tabloyu doldur; ayırma zamanlayıcısını profile bağla | Opus | Her değişiklik için önce/sonra rtf commit mesajında |
| C5 | TTS WebGPU yolu profile göre (ölçüm kazanıyorsa) | Opus | Kazanmıyorsa yapılmaz |

## 6. İş kartı şablonu (alt ajana aynen verilir)

```
İŞ <No> — <başlık>            Model: <opus|sonnet>
Depo: /home/user/LocaDub, dal claude/adoring-dijkstra-2es6yp (commit ETME; yönetici eder)
Amaç: <tek cümle>
Bağlam: <neden; ilgili mevcut kod: dosya yolu + fonksiyon adı>
Dokunulacak dosyalar: <liste>      Dokunulmayacaklar: <liste>
Adımlar: 1… 2… 3…
Kabul ölçütü: <gözlemlenebilir davranış>
Testler: node --test tests/extension/*.test.mjs ; xvfb-run -a node tests/extension/e2e/<ad>.e2e.cjs
Kurallar: ES modül, 2 boşluk, Türkçe arayüz metni ve kısa Türkçe yorum; yeni bağımlılık yok; ölçmediğin şeyi ölçülmüş gibi yazma.
Rapor: değişen dosyalar · çalıştırılan komutlar ve çıktıların son satırları · yapılamayanlar ve nedeni.
```

## 7. Sıra ve kilometre taşları

```
M0  Hazırlık        0.5.14 yayını (kullanıcı "yükle") · C1 Hız testi genişletme · A0 araştırma · B0 maketler      (paralel)
     ↳ kullanıcı: maket onayı (B0) · iki cihazda Hız testi (C3)
M1  0.6.0  Arayüz   B1 → B2 → B3 → B4 → B5
M2  0.7.0  Tam video A1 → A2 → A3 → (A4 → A5, A0 sonucuna göre) → A6
M3  0.8.0  Profiller C2 → C4 → C5
M4  1.0.0  Sürüm    tam e2e + soak · belgeler (README, SES-AYIRMA, gizlilik sayfası: yeni disk kullanımı) · site güncelleme · sürüm notları
```
Her kilometre taşı kendi başına yayınlanabilir; kullanıcı "yükle" demeden yayın yok.

## 8. Riskler

| Risk | Etki | Önlem |
|---|---|---|
| Tam ses akışı eklentiden indirilemez (A0) | Tam kipte ayırma önceden hazırlanamaz | A0 önce yapılır; olmazsa kapsam (c)'ye iner ve arayüz bunu söyler |
| Bellek/disk (60 dk video) | Sekme çökmesi | A2/A4 disk tabanlı; soak testi; kota ve temizlik |
| Arayüz beğenilmez | Yeniden iş | B0 maket onayı kod öncesi |
| Cihaz ölçümleri gelmez | Profiller tahminle kalır | C2 bugünkü varsayılanlarla çalışır; C4 ölçüme kadar bekler, tahmin yazılmaz |
| RTX'te TDR | Ekran donması | Toplu boyut ölçümü mevcut çökme korumasıyla (`benchGuard`), tek iş < 0.8 sn kuralı |
| Alt ajan yanlış "geçti" der | Bozuk birleştirme | Yönetici testleri kendisi çalıştırır |
| Gizlilik metni eskir (diske ses yazılıyor) | Yanlış beyan | M4'te `site/gizlilik.html` güncellenir |

## 9. Kullanıcı kararları (2026-11-10)

- RTX makinesi: **RTX 5060 Ti 16 GB, masaüstü** (tek kart; hibrit GPU sorunu bu makinede yok).
- Arayüz: **sitenin tasarım diline uygun** (`site/index.html`: siyah/beyaz bölümler, SF/Inter, tek mavi vurgu).
- 0.5.14 ayrıca yayınlanmadı; dalda duruyor, v1 kilometre taşlarıyla birlikte "yükle" denince çıkar.
- M0 başlatıldı: A0, B0, C1 paralel.

## 10. v1.0.0'da ne var, ne yok (2026-11-11)

**Var:** yeni arayüz (oynatıcı paneli, açılır pencere, ayarlar; `docs/maket/` onaylı tasarım) · "Tüm videoyu hazırla" (çeviri ve sesler baştan sona,
sesler eklenti kökeninde Cache API'de, yeniden izlemede sentezsiz) · cihaz profili (algılama + seçici; yalnız ayırma kalitesi, ön tampon, önceden hazırlama)
· genişletilmiş Hız testi · 0.5.14 düzeltmeleri.

**Yok (sonraya):** ses ayırmanın tüm video için önceden hazırlanması (`docs/TAM-VIDEO.md`: ses akışının tamamı alınamıyor) · yakalanan sesi diske yazıp
ikinci izlemede ayırmayı hazır bulma (A4/A5) · profilde toplu boyut ve GPU hız sınırı (RTX 5060 Ti ve Mac mini M4 Hız testi çıktıları bekleniyor: C3/C4)
· WebGPU'da seslendirme ölçümü/yolu (C5).

**Cihazda doğrulanmadı:** gerçek YouTube, gerçek ekran kartı, gerçek eklenti klasörüne otomatik güncelleme; hepsi sahte YouTube e2e ve birim testleriyle sınandı.
