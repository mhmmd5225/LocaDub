# engines/tts — yerel Türkçe seslendirme

API: `docs/CONTRACT.md` → "Seslendirme motoru API". `index.js` offscreen'de çalışır, çıkarım `worker.js`
(module Worker, `../../lib/ort/ort.webgpu.min.mjs`, varsayılan EP `wasm`, 1 iş parçacığı; Supertonic en çok 4) içindedir.

| Dosya | İş |
|---|---|
| `index.js` | listVoices / init / synthesize / dispose; model indirme (`../common/model-cache.js`), worker yönetimi, iptal |
| `worker.js` | onnxruntime-web oturumları, istek kuyruğu |
| `core.js` | ortamdan bağımsız sentez: normalizasyon → parçalama → model → sessizlik kırpma → birleştirme → hız |
| `voices.js` | ses kataloğu (commit'e sabitlenmiş HF URL'leri, boyutlar, lisanslar) |
| `normalize.js` | trnorm + yerel eklemeler (İngilizce sayı biçimleri, kısaltma/isim okunuşları) |
| `trnorm/` | Harfiyen trnorm'undan üretildi (`tools/tts/port-trnorm.mjs`), elle düzenlenmez |
| `ahenk.js` | Ahenk Cep çıkarımı (Harfiyen `ahenk.ts`/`ema.ts` JS portu) |
| `antalia.js`, `antalia/` | Antalia-2 Mini çıkarımı (Space'ten değiştirilmeden kopyalanan `tts.js`, `frontend.js`) |
| `ema.js` | EMA Lightning çıkarımı (Harfiyen `ema.ts` portu) |
| `supertonic.js` | Supertonic 3 çıkarımı (resmî web örneği `helper.js` portu), hazır ses karıştırma |
| `dsp.js` | sessizlik kırpma, WSOLA zaman esnetme, FIR süzgeçli örnek hızı dönüşümü, ses seviyesi dengesi, WAV |

Sesler: `antalia-mini` (erkek, varsayılan), `ahenk-cep` (kadın), `ema-lightning` (kadın), `supertonic-3:F1…F5` /
`supertonic-3:M1…M5` (deneysel, 10 hazır ses) ve `system` (`{system:true}`). Karşılaştırma: `docs/TTS-KIYAS.md`.

**Supertonic paketi:** on hazır ses aynı dosyaları (`pack: 'supertonic-3'`, ≈ 398 MB fp32) paylaşır; dosyalar bir kez
iner, worker modeli bir kez yükler, ses yalnızca bir stil vektörüdür (her istekte değişir, karıştırılabilir). Tek iş
parçacıklı WASM'de gerçek zamandan yavaş olduğu için (RTF ≈ 1.2) katalogda `threads: 4` taşır: `index.js` sayfa
cross-origin isolated ise worker'ı en çok 4 (çekirdek − 1) iş parçacığıyla başlatır; çok iş parçacıklı yükleme 90 sn'de
bitmezse tek iş parçacığına düşer.

**Her satırda (tüm sesler):** cümle başına metnin özetinden türeyen tohum (`core.js textSeed`; sabit tohumla her cümle aynı
gürültüden başlıyordu), uzun yan cümlelerde "ama / fakat / çünkü / oysa / halbuki" öncesine virgül
(`normalize.js addClauseCommas`; modeller duraklamayı ve yeni ezgi yayını yalnızca noktalamadan alır) ve −20 dBFS kapılı
RMS seviyesine getirme (`dsp.js normalizeLoudness`, ±12 dB, ardından yumuşak sınırlayıcı).
Hız: 0.5–3'e kırpılır; ≤ 1.6 modelin süre tahmini (native), üstü WSOLA. Çıkış varsayılan 24 kHz
(`init({outputRate:48000})` ile doğal hız).

## Üslup, perde, kalite (`styles.js`)

`synthesize(text, { voice, speed, tone: { style, pitch, quality } })` → worker → `core.js synthesizeText`. Tablo ve
sınırlar yalnızca `styles.js`'te. **Bunlar ince ayardır; robot hissini ortadan kaldırmaz.** Sayılar başlangıç tahminidir,
dinleyerek ayarlanacak.

| Denetim | Ahenk Cep | Antalia Mini | Not |
|---|---|---|---|
| Üslup: stil | `text.onnx` style girdisi: Doğal `neutral`, Canlı `cheerful`, Sakin `calm` (manifestte yoksa `neutral`) | yok | Model kartına göre etki zayıf (`calm` ≈ %8 yavaş); `laughter` gömmesi var ama kahkaha eğitilmediği için sunulmaz |
| Üslup: sıcaklık | yok | 0.6 / 0.8 / 0.4 (`speak()`'in `temperature`ı) | düşük = düz ve kararlı, yüksek = daha değişken tonlama |
| Üslup: hız çarpanı | ×1 / 1.05 / 0.95 | aynı | motor çarpmaz; `content/app.js` temel hıza katar (`ttsSpeed × çarpan`), sığdırma hesabı (`chooseSynthSpeed`) bilir. Ahenk `calm` zaten ~%8 yavaştır, çarpanla birleşince Sakin ≈ %13 yavaşlar |
| Perde | üslup perdesi (0 / +1 / −1) + kullanıcı (−3…+3), toplam ±4 yarım ton | aynı | modele `hız / k` verilir (k = 2^(yarımTon/12), ses k kat uzar), çıktı k oranında yeniden örneklenir: perde k kat, süre aynı kalır (`dsp.shiftPitch`, doğrusal aradeğerleme). Biçimlenti de kayar; WSOLA gerekmez |
| Kalite | flow adımı 8 → 16 | flow adımı 8 → 16 | ölçülen RTF için aşağıya bakın. Supertonic: gürültü giderme adımı 5 → 8 (`SUPERTONIC_STEPS`); EMA'da adımlar grafiğin içinde |
| Karıştırma | yok | yok | yalnızca Supertonic: `tone.blend = { with: 'M1', amount: 0…0.9 }`, stil = (1 − a)·seçili + a·katılan |

Hız ölçümü (Node, tek iş parçacığı, `onnxruntime-node` CPU; tarayıcıdaki WASM bundan ~%20–30 yavaştır; 3 cümle ≈ 15 sn ses, 24 kHz çıkış):

| Ses | Kalite | Doğal | Canlı | Sakin |
|---|---|---|---|---|
| Antalia Mini | Hızlı (8 adım) | 0.162 | 0.165 | 0.148 |
| Antalia Mini | Yüksek (16) | 0.250 | 0.313 | 0.290 |
| Ahenk Cep | Hızlı (8 adım) | 0.244 | 0.293 | 0.247 |
| Ahenk Cep | Yüksek (16) | 0.305 | 0.343 | 0.305 |

(Perde +2 yarım ton ek maliyeti: Antalia 0.162 → 0.194, Ahenk 0.244 → 0.260; ses k kat uzun üretildiği için.)

## Üçüncü taraf bildirimleri (THIRD_PARTY_NOTICES.md'ye eklenmeli)

- **Harfiyen** — https://github.com/ozcancelik/harfiyen — MIT License, Copyright (c) 2026 Özcan Çelik.
  `trnorm/*.js` (src/tts/trnorm, tipler çıkarıldı), `ahenk.js` (src/tts/ahenk.ts + ema.ts portu),
  `dsp.js` trimSilence, `antalia.js` yapısı. Commit 981902ceaef804fdb7a4edb782078c766e3b53c2.
- **trnorm / Ahenk demo** — github.com/ozguradmin/ahenk-turkish-tts — Apache-2.0 (Harfiyen'in kaynağı).
- **Antalia-2 Mini web demo** — https://huggingface.co/spaces/cloud0day3/antalia-mini
  (`js/tts.js`, `js/frontend.js` @ 2c24b406) — Apache-2.0, Copyright 2026 PatientDesk AI.
  frontend-data.json.gz CMU Pronouncing Dictionary verisini içerir (BSD-2-Clause).
- **Model: Antalia-2 Mini** — https://huggingface.co/cloud0day3/antalia-mini — Apache-2.0 (sentetik erkek ses).
- **Model: Ahenk Cep** — https://huggingface.co/ozgurguler/ahenk-cep-tr — CC BY 4.0, ozgurguler; EMA Lightning
  (Apache-2.0) türevi, Alania verileri (CC BY 4.0, PatientDesk AI). CC BY atfı: arayüzde/hakkında sayfasında
  "Ses: Ahenk Cep (ozgurguler), CC BY 4.0" yazılmalı. Model kartı üretilen sesin yapay olduğunun belirtilmesini ister.
