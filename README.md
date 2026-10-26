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

## Kurulum

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
| `site/` | Tanıtım web sayfası (tek dosya, GitHub Pages ile yayınlanabilir) |
| `tools/` | Model indirme, simge üretme ve sayfa önizleme araçları |
| `docs/CONTRACT.md` | Bileşenler arası sözleşme (mesajlar, motor API'leri) |

## Lisanslar

Kod ve model lisansları: [extension/THIRD_PARTY_NOTICES.md](extension/THIRD_PARTY_NOTICES.md).
Modeller depoya dahil değildir; ilk kullanımda HuggingFace'ten indirilir. Ahenk Cep (CC BY 4.0) atıf
gerektirir; eklenti bu atfı ses seçiliyken gösterir.
