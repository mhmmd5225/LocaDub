# LocaDub

İngilizce altyazılı YouTube videolarını **tamamen bilgisayarınızda** Türkçeye çeviren ve Türkçe
seslendiren bir Chrome eklentisi. Modeller ilk kullanımda bir kez indirilir, sonra internetsiz çalışır;
metin ve ses hiçbir sunucuya gönderilmez.

- **Çeviri:** Chrome'un cihaz üzerindeki çevirmeni ya da
  [OPUS-MT tc-big EN→TR](https://huggingface.co/Helsinki-NLP/opus-mt-tc-big-en-tr) (ONNX, ≈300 MB)
- **Seslendirme:** [Antalia Mini](https://huggingface.co/cloud0day3/antalia-mini) (erkek, varsayılan),
  [Ahenk Cep](https://huggingface.co/ozgurguler/ahenk-cep-tr) (kadın) ya da Windows'un Türkçe sistem sesi
- **Çalışma ortamı:** [onnxruntime-web](https://github.com/microsoft/onnxruntime) (WASM), Chrome MV3
  offscreen belgesi

Türkçe çeviri ve seslendirme mekanizması [harfiyen](https://github.com/ozcancelik/harfiyen) (MIT)
projesinden uyarlanmıştır.

## Eklentisiz kullanım (web sürümü)

https://localdub.mhmmd.app/app/ — kurulum yok: YouTube bağlantısını yapıştırıp **Dublajı başlat**'a basın.

- **Konuşma tanıma:** Videonun İngilizce konuşması tarayıcıda
  [Whisper base.en](https://huggingface.co/onnx-community/whisper-base.en) ile yazıya dökülür
  ([transformers.js](https://github.com/huggingface/transformers.js), ≈136 MB, bir kez indirilir). Altyazı gerekmez.
- **YouTube:** Web sayfası YouTube'un sesine erişemediği için küçük bir *dinleyici penceresi* (`site/app/listen.html`)
  açılır. Pencere videoyu ana oynatıcının önünde, sessiz olarak (`suppressLocalAudioPlayback`) oynatır ve bir kez
  verilen "bu sekmeyi paylaş" izniyle kendi sesini yakalar. Masaüstü Chrome ya da Edge gerekir. Gömmeye kapalı
  videolar oynatılamaz.
- **Bilgisayardaki video:** Ses doğrudan dosyadan çözülür; her tarayıcıda çalışır.
- **Bekleme:** Yazıya dökme, çeviri ya da ses hazır değilse video kendiliğinden kısa süre bekletilir; dublaj kaçmaz.
- **İsteğe bağlı:** .srt / .vtt / json3 altyazı dosyası verilirse konuşma tanıma kullanılmaz.

YouTube'un kendi tam ekranında Türkçe altyazı görünmez; sayfadaki **Tam ekran** düğmesini kullanın.
Yalnızca İngilizce konuşulan videolar desteklenir.

## Eklenti kurulumu

1. Bu depoyu indirin.
2. Chrome'da `chrome://extensions` → **Geliştirici modu** → **Paketlenmemiş öğe yükle** → `extension/`
   klasörünü seçin.
3. Eklenti simgesi → **Tüm ayarlar ve modeller** → **Seçili modelleri indir**.
4. İngilizce altyazılı bir YouTube videosunda oynatıcıdaki **TR** düğmesine basın.

Ayrıntılar: [extension/README.md](extension/README.md).

## Depo yapısı

| Klasör | İçerik |
|---|---|
| `extension/` | Eklentinin kendisi (derleme adımı yok, düz ES module JS) |
| `tests/extension/` | Eklenti birim testleri: `node --test tests/extension/` |
| `tests/mt/`, `tests/tts/` | Çeviri ve ses motoru testleri (`npm install && npm test`; uçtan uca testler modelleri indirir) |
| `site/` | Tanıtım sayfası: https://localdub.mhmmd.app (Netlify; yedek: GitHub Pages) |
| `site/app/` | Web sürümü. Motorları ve saf modülleri `extension/`'dan alır: `python3 tools/site/build.py` bunları `site/app/ext/`'e kopyalar (yerelde: derleyip `site/` klasörünü herhangi bir statik sunucuyla sunun) |
| `tests/app/` | Web sürümünün testleri (altyazı ayrıştırıcı, konuşma tanıma yardımcıları): `node --test tests/app/*.test.mjs` |
| `tools/` | Model indirme, simge üretme ve sayfa önizleme araçları |
| `docs/CONTRACT.md` | Bileşenler arası sözleşme (mesajlar, motor API'leri) |

## Lisanslar

Kod ve model lisansları: [extension/THIRD_PARTY_NOTICES.md](extension/THIRD_PARTY_NOTICES.md).
Modeller depoya dahil değildir; ilk kullanımda HuggingFace'ten indirilir. Ahenk Cep (CC BY 4.0) atıf
gerektirir; eklenti bu atfı ses seçiliyken gösterir.
