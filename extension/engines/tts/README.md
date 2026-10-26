# engines/tts — yerel Türkçe seslendirme

API: `docs/CONTRACT.md` → "Seslendirme motoru API". `index.js` offscreen'de çalışır, çıkarım `worker.js`
(module Worker, `../../lib/ort/ort.webgpu.min.mjs`, varsayılan EP `wasm`, 1 iş parçacığı) içindedir.

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
| `dsp.js` | sessizlik kırpma, WSOLA zaman esnetme, 2:1 FIR örnek indirme, WAV |

Sesler: `antalia-mini` (erkek, varsayılan), `ahenk-cep` (kadın), `system` (`{system:true}`).
Hız: 0.5–3'e kırpılır; ≤ 1.6 modelin süre tahmini (native), üstü WSOLA. Çıkış varsayılan 24 kHz
(`init({outputRate:48000})` ile doğal hız).

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
