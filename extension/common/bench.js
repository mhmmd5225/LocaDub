// Hız testi: bu cihazda ses ayırma (WebGPU/WASM, toplu boyutları), seslendirme ve çeviri hızını ölçer.
// Saf modül (DOM yok): bağımlılıklar (ayırma istemcisi, sentez, çeviri) dışarıdan verilir; Node testleri sahteleriyle sınar,
// ayarlar sayfası (options.js) gerçekleriyle çağırır. Amaç tahminleri gerçek sayılarla değiştirmek (docs/PERFORMANS-RAPORU.md).

export const BENCH = Object.freeze({
  sepRate: 48000,
  sepChunkSec: 8,        // akış kipinde art arda parçalar; ilki ısınma sayılır
  sepChunks: 3,
  sepBatches: [1, 2, 4],  // yalnız WebGPU'da; WASM'da tek yapılandırma. 8 yok: tek GPU işi sürücü sınırını aşabilir
  maxRunSec: 0.8,        // sonraki toplu boyutun tahmini tek model çağrısı süresi bunu aşacaksa denenmez (Windows ≈ 2 sn'de sürücüyü sıfırlar)
  paceRtf: 0.6,          // GPU hız sınırı ölçümü (content/sep-core.js SEP.pacePlay ile aynı)
  capDays: 7,            // yarım kalan (çöken) denemenin toplu boyut sınırı bu kadar gün geçerli
  sepTimeoutMs: 90000,   // tek parça (yükleme hariç) için üst sınır
  loadTimeoutMs: 300000, // model indirmesi dahil
  tts: ['Merhaba, bu bir hız testidir.', 'Bugün hava çok güzel ve sakin.', 'Yarın sabah erkenden yola çıkacağız.', 'Toplantı saat üçte başlayacak.'],
  mt: [
    'Hello and welcome to the show.', 'Today we are talking about cats.', 'The weather is nice and calm.',
    'We will leave early tomorrow morning.', 'The meeting starts at three o\'clock.', 'Thank you for watching this video.',
    'Please subscribe to the channel.', 'See you in the next episode.',
  ],
});

export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
/** Gerçek zaman oranı: işlem süresi / ses süresi (< 1: gerçek zamandan hızlı). */
export const rtf = (ms, audioSec) => (audioSec > 0 ? ms / 1000 / audioSec : 0);

/** Belirleyici sentetik stereo sinyal (harmonikli "konuşma" + hafif gürültü); mutlak zamana göre, parçalar bitişik. */
export function benchSignal(seconds, rate, offsetSec = 0) {
  const n = Math.round(seconds * rate);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  let seed = (Math.round(offsetSec * rate) % 2147483646) + 1;
  for (let i = 0; i < n; i++) {
    const t = offsetSec + i / rate;
    const f0 = 140 + 40 * Math.sin(2 * Math.PI * 0.7 * t);
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
    seed = (seed * 16807) % 2147483647;
    const noise = (seed / 2147483647 - 0.5) * 0.1;
    left[i] = 0.18 * v + noise;
    right[i] = 0.18 * v - noise;
  }
  return { left, right };
}

function withTimeout(p, ms, what) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} ${Math.round(ms / 1000)} sn içinde bitmedi`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/**
 * Tek ayırma ölçümü: yeni istemci yükler, akış kipinde art arda parçalar işler (ilk parça ısınma sayılmaz).
 * Ölçülen parçalardan: rtf, tek pencere süresi (iş süresi / pencere; işçi `windows` verirse), hız sınırında bekleme (`idleMs`).
 */
async function measureSep({ createClient, now, batch, quality, pace, chunkSec, chunks, rate, onStep, label }) {
  const run = { batch };
  if (quality) run.quality = quality;
  let client = null;
  try {
    client = createClient();
    onStep?.(`Ses ayırma: ${label} yükleniyor…`);
    const t0 = now();
    const info = await withTimeout(client.load({ model: 'auto', backend: 'auto', batch, ...(quality ? { quality } : {}) }), BENCH.loadTimeoutMs, 'Ayırma modeli yükleme');
    run.loadMs = now() - t0;
    run.backend = info?.backend;
    run.model = info?.model;
    run.stepSec = info?.stepSec > 0 ? info.stepSec : 2.96;
    const rtfs = [];
    let ms = 0, windows = 0, idleMs = 0;
    for (let k = 0; k < chunks; k++) {
      onStep?.(`Ses ayırma: ${label}, parça ${k + 1}/${chunks}…`);
      const { left, right } = benchSignal(chunkSec, rate, k * chunkSec);
      const t1 = now();
      const opts = { startSample: Math.round(k * chunkSec * rate), final: k === chunks - 1, ...(pace ? { pace } : {}) };
      const r = await withTimeout(client.process(left, right, rate, opts), BENCH.sepTimeoutMs, 'Ayırma parçası');
      const dt = now() - t1;
      rtfs.push(rtf(dt, chunkSec));
      if (k === 0) continue;
      ms += dt;
      windows += r?.windows > 0 ? r.windows : 0;
      idleMs += r?.idleMs > 0 ? r.idleMs : 0;
    }
    run.rtfs = rtfs;
    run.rtf = mean(rtfs.slice(1));
    // tek pencere = ölçülen iş süresi (beklemeler hariç) / pencere; tek GPU işi = pencere × toplu
    if (windows > 0) {
      run.windowMs = Math.max(0, ms - idleMs) / windows;
      run.jobMs = run.windowMs * batch;
    }
    if (pace) run.idleMs = idleMs;
  } catch (e) {
    run.error = String(e?.message || e);
  } finally {
    try { await client?.dispose?.(); } catch { /* sessiz: ölçüm sonrası temizlik */ }
  }
  return run;
}

/** Sonraki toplu boyutun tahmini tek GPU işi (sn): ölçülen pencere süresinden, yoksa rtf × adımdan; ikisi varsa büyüğü (temkinli). */
export function estJobSec(prev, batch) {
  if (!prev) return 0;
  const byRtf = prev.rtf > 0 && prev.stepSec > 0 ? batch * prev.rtf * prev.stepSec : 0;
  const byWin = prev.windowMs > 0 ? (batch * prev.windowMs) / 1000 : 0;
  return Math.max(byRtf, byWin);
}

/**
 * Ses ayırma: her toplu boyutu için yeni istemci yükler, akış kipinde art arda parçalar işler.
 * GPU güvenliği: toplu boyut küçükten büyüğe gider; bir sonrakinin tahmini tek model çağrısı süresi (toplu × pencere süresi)
 * maxRunSec'i aşacaksa denenmez. Çökme koruması (guard): her deneme öncesi "yarım" işaretlenir, başarıyla bitince silinir; sayfa/sürücü
 * denemenin ortasında giderse bir sonraki testte o toplu boyut ve üstü atlanır (sınır capDays gün geçerli).
 * Ek ölçümler (extras, yalnız WebGPU'da; aynı koruma ve 0.8 sn kuralıyla):
 *   paced: en hızlı güvenli toplu boyutta GPU hız sınırıyla (pace.targetRtf = paceRtf) aynı ölçüm → rtf + toplam bekleme
 *   lite:  hafif model (quality 'fast'), toplu 1
 * @param {{ createClient: () => { load:Function, process:Function, dispose:Function }, now?: () => number,
 *           batches?: number[], chunkSec?: number, chunks?: number, rate?: number, onStep?: (s:string)=>void,
 *           guard?: { read:()=>Promise<{ inflight?:number, cap?:{ batch:number, at:number }|null }>, mark:(b:number)=>Promise<void>,
 *                     clear:()=>Promise<void>, setCap:(b:number)=>Promise<void> }, maxRunSec?: number, nowMs?: () => number,
 *           extras?: boolean, paceRtf?: number }} o
 * @returns {Promise<{ runs: { batch:number, backend?:string, model?:string, loadMs?:number, rtfs?:number[], rtf?:number,
 *           windowMs?:number, jobMs?:number, error?:string }[], interrupted?: number, cap?: number, stopped?: { batch:number, reason:string },
 *           paced?: object, lite?: object }>}
 */
export async function runSepBench({ createClient, now = () => performance.now(), batches = BENCH.sepBatches, chunkSec = BENCH.sepChunkSec,
  chunks = BENCH.sepChunks, rate = BENCH.sepRate, onStep, guard, maxRunSec = BENCH.maxRunSec, nowMs = () => Date.now(),
  extras = true, paceRtf = BENCH.paceRtf } = {}) {
  const runs = [];
  const out = { runs };
  let capBatch = null;
  // önceki test yarıda kaldıysa o toplu boyut ve üstü atlanır
  if (guard) {
    const st = await guard.read().catch(() => ({}));
    capBatch = st?.cap && nowMs() - st.cap.at < BENCH.capDays * 86400000 ? st.cap.batch : null;
    if (st?.inflight) {
      out.interrupted = st.inflight;
      capBatch = Math.min(capBatch ?? Infinity, st.inflight);
      await guard.setCap(capBatch).catch(() => {});
      await guard.clear().catch(() => {});
    }
    if (capBatch != null) {
      out.cap = capBatch;
      batches = batches.filter((b) => b < capBatch);
    }
  }
  const common = { createClient, now, chunkSec, chunks, rate, onStep };
  // korumalı tek ölçüm: önce işaretle, bitince (ya da yakalanan hatada) sil
  const guarded = async (batch, o) => {
    await guard?.mark(batch).catch(() => {});
    const run = await measureSep({ ...common, batch, ...o });
    await guard?.clear().catch(() => {}); // çökmeden bitti (hata yakalandıysa da sayfa gitmedi)
    return run;
  };
  let prev = null;
  for (const batch of batches) {
    const est = estJobSec(prev, batch);
    if (est > maxRunSec) {
      out.stopped = { batch, reason: `tahmini tek GPU işi ${est.toFixed(1)} sn > ${maxRunSec} sn (sürücü sınırına yakın)` };
      break;
    }
    const run = await guarded(batch, { label: `toplu ${batch}` });
    runs.push(run);
    if (run.error || run.backend !== 'webgpu') break; // WASM'da toplu boyutu farksız; hata varsa daha büyüğü denenmez
    prev = run;
  }
  if (!extras) return out;
  // ek ölçümler: yalnız WebGPU'da ve ölçülmüş, tek GPU işi sınırın altında kalan toplu boyutla
  const safe = runs.filter((r) => !r.error && r.rtf > 0 && r.backend === 'webgpu' && !(r.jobMs > maxRunSec * 1000));
  const best = fastestBatch(safe);
  if (best) {
    out.paced = await guarded(best.batch, { pace: { targetRtf: paceRtf }, label: `hız sınırı ${paceRtf} (toplu ${best.batch})` });
    out.paced.targetRtf = paceRtf;
  }
  // hafif model toplu 1'de: tam modelin toplu 1'inden hafif, o yüzden ölçülmüş toplu 1 güvenliyse o da güvenli
  if (runs.some((r) => r.batch === 1 && !r.error && r.backend === 'webgpu')) {
    out.lite = await guarded(1, { quality: 'fast', label: 'hafif model (toplu 1)' });
  }
  return out;
}

/**
 * Seslendirme: ilk cümle ısınma; kalanların toplam süresi / toplam ses süresi. synth(text) → { ms, audioSec } | { skipped }
 * device (isteğe bağlı): () → { device:'wasm'|'webgpu', threads? } — motorun çalıştığı aygıt, sonuçta `device` olarak döner.
 */
export async function runTtsBench({ synth, sentences = BENCH.tts, onStep, device } = {}) {
  let ms = 0;
  let audioSec = 0;
  let out;
  try {
    for (let i = 0; i < sentences.length; i++) {
      onStep?.(`Seslendirme: ${i + 1}/${sentences.length}…`);
      const r = await synth(sentences[i]);
      if (r?.skipped) return { skipped: r.skipped };
      if (i === 0) continue;
      ms += r.ms;
      audioSec += r.audioSec;
    }
    out = { sentences: sentences.length - 1, ms, audioSec, rtf: rtf(ms, audioSec) };
  } catch (e) {
    out = { error: String(e?.message || e) };
  }
  if (device) {
    try { const d = await device(); if (d?.device) out.device = d; } catch { /* aygıt bilgisi isteğe bağlı */ }
  }
  return out;
}

/** Çeviri: bir cümleyle ısınma, sonra tüm cümleler tek istekte; cümle/sn. translate(sentences) → Promise */
export async function runMtBench({ translate, sentences = BENCH.mt, now = () => performance.now(), onStep } = {}) {
  try {
    onStep?.('Çeviri: ısınma…');
    await translate(sentences.slice(0, 1));
    onStep?.('Çeviri: ölçülüyor…');
    const t0 = now();
    await translate(sentences);
    const ms = now() - t0;
    return { sentences: sentences.length, ms, perSec: ms > 0 ? sentences.length / (ms / 1000) : 0 };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

/**
 * Ortam bilgisi (saf: navigator benzeri nesne parametreyle gelir). adapter: common/gpu.js describeAdapter çıktısı ya da null.
 * @returns {{ platform:string, chrome:string|null, cores:number|null, memoryGb:number|null, coi:boolean, gpu:string|null, version:string|null }}
 */
export function collectEnv({ nav = {}, adapter = null, coi = false, version = null } = {}) {
  const ua = String(nav.userAgent || '');
  const uaPlat = /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Android/.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  const brands = nav.userAgentData?.brands || [];
  const brand = brands.find((x) => /Google Chrome/.test(x.brand)) || brands.find((x) => /Chromium/.test(x.brand));
  const chrome = brand?.version ? String(brand.version).split('.')[0] : (ua.match(/Chrome\/(\d+)/) || [])[1] || null;
  return {
    platform: nav.userAgentData?.platform || uaPlat || 'bilinmiyor',
    chrome,
    cores: Number(nav.hardwareConcurrency) > 0 ? Number(nav.hardwareConcurrency) : null,
    memoryGb: Number(nav.deviceMemory) > 0 ? Number(nav.deviceMemory) : null,
    coi: !!coi,
    gpu: adapter || null,
    version: version || null,
  };
}

/** Ortam → başlık satırları (çıktının başı). */
export function formatEnv(env) {
  if (!env) return [];
  const mem = env.memoryGb ? ` · bellek ${env.memoryGb >= 8 ? '≥8' : env.memoryGb} GB` : '';
  return [
    `ortam: ${env.platform} · Chrome ${env.chrome || '?'} · LocaDub ${env.version || '?'}`,
    `ekran kartı: ${env.gpu ? `${env.gpu} (WebGPU)` : 'WebGPU yok'}`,
    `işlemci: ${env.cores ?? '?'} çekirdek${mem} · crossOriginIsolated ${env.coi ? 'evet' : 'hayır'}`,
  ];
}

/** Aşamaları sırayla çalıştırır; biri hata verse (fırlatsa bile) diğerleri sürer. env verilirse çıktının başına girer. */
export async function runBench({ sep, tts, mt, env, onStep, now = () => Date.now() } = {}) {
  const t0 = now();
  const result = { at: t0 };
  if (env) result.env = env;
  const stage = async (fn, o) => {
    if (!o) return null;
    try { return await fn({ ...o, onStep }); } catch (e) { return { error: String(e?.message || e) }; }
  };
  result.sep = await stage(runSepBench, sep);
  result.tts = await stage(runTtsBench, tts);
  result.mt = await stage(runMtBench, mt);
  result.ms = now() - t0;
  return result;
}

const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);

/** En hızlı toplu boyutu (hatasız çalışanlar arasında en düşük rtf) ya da null. */
export function fastestBatch(runs) {
  const ok = (runs || []).filter((r) => !r.error && r.rtf > 0);
  if (!ok.length) return null;
  return ok.reduce((a, b) => (b.rtf < a.rtf ? b : a));
}

function sepNotes(sep) {
  if (sep.interrupted) return [`  UYARI: önceki test toplu ${sep.interrupted}'de yarım kaldı (sürücü/sekme çökmüş olabilir): toplu ${sep.cap} ve üstü atlandı`];
  if (sep.cap) return [`  not: önceki yarım kalan test nedeniyle toplu ${sep.cap} ve üstü atlandı`];
  return [];
}

const rt = (v) => `${f2(v)} rtf (${f1(1 / v)}× gerçek zaman)`;
// pencere / tek GPU işi süreleri (işçi pencere sayısı verdiyse)
const winTxt = (x) => (x.windowMs > 0 ? ` · pencere ${Math.round(x.windowMs)} ms · GPU işi ${Math.round(x.jobMs)} ms` : '');

/** Sonuç → metin satırları (ayarlar sayfasında gösterim ve tanılama raporu). */
export function formatBench(r) {
  const L = [...formatEnv(r?.env)];
  const sep = r?.sep;
  if (!sep) L.push('ses ayırma: çalıştırılmadı');
  else if (!sep.runs) L.push(`ses ayırma: hata — ${sep.error || '?'}`);
  else if (!sep.runs.length) L.push('ses ayırma: sonuç yok', ...sepNotes(sep));
  else {
    const h = sep.runs.find((x) => x.backend) || sep.runs[0];
    L.push(`ses ayırma: arka uç ${h.backend || '?'} · model ${h.model || '?'}${h.loadMs != null ? ` · yükleme ${f1(h.loadMs / 1000)} sn` : ''}`);
    L.push(...sepNotes(sep));
    for (const x of sep.runs) {
      if (x.error) L.push(`  toplu ${x.batch}: hata — ${x.error}`);
      else if (!(x.rtf > 0)) L.push(`  toplu ${x.batch}: ölçülemedi`);
      else L.push(`  toplu ${x.batch}: ${rt(x.rtf)}${winTxt(x)}`);
    }
    const best = fastestBatch(sep.runs);
    if (best && sep.runs.filter((x) => !x.error).length > 1) L.push(`  en hızlı: toplu ${best.batch}`);
    if (sep.stopped) L.push(`  toplu ${sep.stopped.batch} denenmedi: ${sep.stopped.reason}`);
    const p = sep.paced;
    if (p) {
      const tag = `  hız sınırı ${p.targetRtf ?? BENCH.paceRtf}`;
      if (p.error) L.push(`${tag}: hata — ${p.error}`);
      else if (!(p.rtf > 0)) L.push(`${tag}: ölçülemedi`);
      else L.push(`${tag}: ${f2(p.rtf)} rtf · bekleme ${f1((p.idleMs || 0) / 1000)} sn (toplu ${p.batch})`);
    }
    const lt = sep.lite;
    if (lt) {
      if (lt.error) L.push(`  hafif model: hata — ${lt.error}`);
      else if (!(lt.rtf > 0)) L.push('  hafif model: ölçülemedi');
      else L.push(`  hafif model: ${rt(lt.rtf)} · model ${lt.model || '?'}${winTxt(lt)}`);
    }
    if (best && best.backend !== 'webgpu') L.push('  WebGPU yok ya da kullanılamadı: ayırma işlemcide (WASM) çalıştı');
  }
  const t = r?.tts;
  if (!t) L.push('seslendirme: çalıştırılmadı');
  else if (t.skipped) L.push(`seslendirme: atlandı (${t.skipped})`);
  else if (t.error) L.push(`seslendirme: hata — ${t.error}`);
  else if (!(t.rtf > 0)) L.push('seslendirme: ölçülemedi');
  else L.push(`seslendirme: ${t.sentences} cümle, ${rt(t.rtf)}`);
  if (t?.device && !t.skipped) L.push(`  TTS aygıtı: ${t.device.device}${t.device.threads ? ` (${t.device.threads} iş parçacığı)` : ''}`);
  const m = r?.mt;
  if (!m) L.push('çeviri: çalıştırılmadı');
  else if (m.error) L.push(`çeviri: hata — ${m.error}`);
  else L.push(`çeviri: ${m.sentences} cümle, ${f1(m.perSec)} cümle/sn`);
  if (r?.ms > 0) L.push(`toplam süre: ${Math.round(r.ms / 1000)} sn`);
  return L;
}
