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

https://localdub.mhmmd.app/app/ — aynı çeviri ve ses modelleri doğrudan tarayıcı sekmesinde çalışır, kurulum gerekmez.

1. Video: YouTube bağlantısı (gömülü oynatıcı) ya da bilgisayardaki bir video dosyası.
2. İngilizce altyazı: YouTube'daki **Transkripti göster** metnini yapıştırın ya da .srt / .vtt / json3 dosyası seçin.
   (Web sayfası YouTube altyazısını kendisi alamaz; eklenti bunu otomatik yapar.)
3. **Dublajı başlat**. Modeller ilk kullanımda onayınızla indirilir ve tarayıcıda saklanır.

YouTube'un kendi tam ekranında Türkçe altyazı görünmez; sayfadaki **Tam ekran** düğmesini kullanın. Gömmeye
kapalı videolar web sürümünde oynatılamaz.

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
| `tests/app/` | Web sürümünün altyazı ayrıştırıcı testleri: `node --test tests/app/*.test.mjs` |
| `tools/` | Model indirme, simge üretme ve sayfa önizleme araçları |
| `docs/CONTRACT.md` | Bileşenler arası sözleşme (mesajlar, motor API'leri) |

## Lisanslar

Kod ve model lisansları: [extension/THIRD_PARTY_NOTICES.md](extension/THIRD_PARTY_NOTICES.md).
Modeller depoya dahil değildir; ilk kullanımda HuggingFace'ten indirilir. Ahenk Cep (CC BY 4.0) atıf
gerektirir; eklenti bu atfı ses seçiliyken gösterir.
