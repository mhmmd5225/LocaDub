# LocaDub — Mimari ve Ajanlar Arası Sözleşme

Amaç: YouTube'da İngilizce altyazısı (manuel veya otomatik) olan videolarda altyazıyı
**tarayıcıda, yerel olarak** Türkçeye çevirmek ve Türkçe seslendirmek (dublaj).
İlk model indirmesinden sonra internetsiz çalışmalı. Hiçbir metin/ses sunucuya gitmez.

Referans: https://github.com/ozcancelik/harfiyen (MIT). `src/mt`, `src/tts`, `src/worker`,
`src/models.ts`, `scripts/prepare_models.py` incelenebilir. Kod alınırsa MIT atfı
`extension/THIRD_PARTY_NOTICES.md` dosyasına eklenir. Model lisansları da oraya yazılır.

## Dizin ve sahiplik

```
yt-tr-dub/
  docs/CONTRACT.md            # yönetici (değişiklik için yöneticiye danış)
  extension/                  # Chrome MV3 eklentisi → EKLENTİ AJANI
    manifest.json
    background.js             # service worker: mesaj yönlendirme, offscreen yönetimi
    offscreen.html/.js        # motorları yükler; çeviri + TTS burada çalışır
    content/                  # youtube.com içerik betiği: altyazı alma, overlay, ses senkronu
    popup/                    # ayarlar: aç/kapa, ses seviyesi, ses (voice), motor seçimi
    lib/ort/                  # onnxruntime-web dist dosyaları (paketli, uzaktan kod YOK) → EKLENTİ AJANI
    engines/mt/               # → ÇEVİRİ AJANI
    engines/tts/              # → SESLENDİRME AJANI
    engines/common/model-cache.js  # → EKLENTİ AJANI (aşağıdaki API)
  tools/mt/                   # model hazırlama/test betikleri → ÇEVİRİ AJANI
  tools/tts/                  # → SESLENDİRME AJANI
```

Bir ajan başka ajanın klasörüne yazmaz. Gerekirse yöneticiye sorar.

## Çalışma ortamı kuralları

- Düz ES module JavaScript (bundler yok). Eklenti `chrome://extensions` → "Paketlenmemiş yükle"
  ile `extension/` klasöründen doğrudan yüklenebilmeli.
- MV3 uzaktan kod yasağı: tüm JS/WASM eklentiye paketlenir. Model ağırlıkları (veri) ilk
  kullanımda HuggingFace'ten indirilip Cache Storage'da saklanabilir.
- `onnxruntime-web` `extension/lib/ort/` altında: `ort.webgpu.min.mjs` / `ort.wasm.min.mjs`
  ve ilgili `.wasm` dosyaları. Motorlar şöyle import eder:
  `import * as ort from '../../lib/ort/ort.wasm.min.mjs'` (WebGPU için `ort.webgpu.min.mjs`),
  ve `ort.env.wasm.wasmPaths = chrome.runtime.getURL('lib/ort/')`.
- **KARAR (v1.22.0 hazır):** Ses motoru `ort.webgpu.min.mjs`, çeviri ve noktalama işçileri düz WASM derlemesi
  `ort.wasm.min.mjs` kullanır (yalnızca `wasm` EP gerekir; 11 MB'lık ikili 22 MB'lık JSEP ikilisinin yarı sürede derlenir).
  İki farklı ort derlemesi aynı bağlamda import edilmez (her işçi ayrı bağlamdır). Inference motorun kendi Worker'ında
  yapılır; Worker içinde `ort.env.wasm.wasmPaths = new URL('../../lib/ort/', import.meta.url).href` (worker dosyasının
  konumuna göre göreli yolu ayarla). **İş parçacıkları:** küçük sesler 1; çeviri çekirdeklerin yarısı (en çok 4), Supertonic
  en çok 4 (çekirdek − 1), yalnızca crossOriginIsolated iken. ort 1.22 bazı Chromium sürümlerinde COI sayfadaki module
  Worker'da numThreads>1 ile `InferenceSession.create`'te asılı kaldığı için çok iş parçacıklı yükleme 90 sn'de bitmezse
  işçi tek iş parçacığıyla yeniden başlatılır.
- Manifest CSP: `"extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"`.
- Motorlar **offscreen document** içinde çalışır (window bağlamı: WebGPU, AudioContext,
  Chrome yerleşik `Translator` API kullanılabilir). Ağır iş için motor kendi Web Worker'ını
  açabilir (`new Worker(new URL('./worker.js', import.meta.url), {type:'module'})`).
- host_permissions: `https://www.youtube.com/*`, `https://huggingface.co/*`,
  `https://*.hf.co/*`, `https://cdn-lfs.huggingface.co/*`, `https://cas-bridge.xethub.hf.co/*`.

## Ortak model önbelleği — `engines/common/model-cache.js`

```js
// URL'yi Cache Storage'dan döndürür, yoksa indirir ve saklar. İlerleme bildirir.
export async function fetchModel(url, { onProgress, cacheName = 'yt-tr-dub-models-v1' } = {})
  // → Promise<ArrayBuffer>; onProgress({ url, loaded, total })
export async function isCached(url, cacheName?) // → Promise<boolean>
export async function clearModels(cacheName?)
```

## Çeviri motoru API — `engines/mt/index.js`

```js
export const id = 'mt';
export async function listBackends()
  // → [{ id:'opus-mt'|'chrome-translator'|..., label, sizeMB, available:boolean }]
export async function init({ backend, onProgress })   // modeli indir/yükle; idempotent
export async function translateBatch(sentences /* string[] EN */, { signal } = {})
  // → Promise<string[] TR>  (aynı uzunluk, aynı sıra; boş girdi → boş çıktı)
export async function dispose()
```

Gereksinimler: Batch başına ≤ 16 cümle hedeflenir, tipik cümle < 1 sn (WASM, 4 çekirdek).
YouTube otomatik altyazıları noktalamasızdır; motor bunu tolere etmelidir (cümle birleştirme
eklenti tarafında yapılır, bkz. aşağı).

## Seslendirme motoru API — `engines/tts/index.js`

```js
export const id = 'tts';
export async function listVoices()
  // → [{ id, label, gender:'female'|'male'|'unknown', sizeMB, license, available, pack?, preset?, experimental? }]
  //   pack: aynı dosyaları paylaşan hazır sesler (Supertonic: 'supertonic-3:F1' … 'supertonic-3:M5')
export async function init({ voice, onProgress })
export async function synthesize(text /* TR */, { voice, speed = 1.0, tone /* { style, pitch, quality, blend? }, styles.js */, signal } = {})
  // → Promise<{ pcm: Float32Array, sampleRate: number }>  (mono)
export async function dispose()
```

Gereksinimler: Türkçe metin normalizasyonu (sayılar, kısaltmalar, %, saat vb.) motorun
içinde yapılır. `speed` 0.8–2.0 arası desteklenmeli (eklenti uzun cümleleri hızlandırır).
RTF (gerçek zaman çarpanı) hedefi < 0.3 (WASM). Yedek olarak `chrome.tts` / `speechSynthesis`
Türkçe sesi `voice:'system'` adıyla sunulabilir (bu durumda pcm yerine eklenti sistemi kullanır;
`synthesize` `{ system:true }` döndürür).

## Mesajlaşma (eklenti içi)

content → background → offscreen, `chrome.runtime.sendMessage` ile:

```
{ type:'mt.translate', sentences:[...] }      → { ok, result:string[] } | { ok:false, error }
{ type:'tts.synthesize', text, voice, speed, tone } → { ok, result:{ pcmBase64 | audioUrl, sampleRate } }
{ type:'engine.init', engine:'mt'|'tts', options } ; ilerleme: { type:'engine.progress', engine, loaded, total }
{ type:'engine.status' }                      → { mt:{ready,backend}, tts:{ready,voice} }
```

PCM aktarımı mesajlarda yapılandırılmış kopyalanamazsa offscreen tarafında WAV'a çevrilip
`blob:` URL'si ya da base64 olarak iletilir (eklenti ajanının kararı).

## Altyazı → dublaj akışı (eklenti)

1. `ytInitialPlayerResponse` / player API'den `captionTracks` alınır; `languageCode` `en*`
   olan (manuel tercih, yoksa `kind:'asr'`) parça `&fmt=json3` ile çekilir.
2. Olaylar cümlelere birleştirilir (noktalama veya duraklama > 700 ms, en fazla ~12 sn).
3. Oynatma konumunun ilerisindeki ~30 sn önceden çevrilir + sentezlenir (önbellek).
4. Cümle başlangıcında Türkçe ses çalınır; orijinal ses kısılır (ducking, ayarlanabilir).
   Ses, cümle süresine sığmazsa `speed` artırılır (≤ 1.6), yine sığmazsa sıradaki beklenir.
5. Duraklatma/ileri sarma/hız değişimi takip edilir. Türkçe altyazı overlay olarak gösterilir.

## Danışma protokolü

Alt ajanlar kendi alanlarında bağımsız çalışır; sözleşmeyi değiştirmeyi gerektiren bir karar,
lisans belirsizliği veya başka ajanın klasörünü etkileyen bir ihtiyaç doğduğunda
`SendMessage` ile `to: "main"` (yönetici) adresine kısa bir soru gönderir ve yanıt gelene kadar
o konuya bağlı olmayan işlere devam eder. Bitirince son raporda: oluşturulan dosyalar,
seçilen modeller + lisanslar + boyutlar, nasıl test edildiği, bilinen eksikler.
