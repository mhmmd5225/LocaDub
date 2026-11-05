// Hız testi: bu cihazda ses ayırma (WebGPU/WASM, toplu boyutları), seslendirme ve çeviri hızını ölçer.
// Saf modül (DOM yok): bağımlılıklar (ayırma istemcisi, sentez, çeviri) dışarıdan verilir; Node testleri sahteleriyle sınar,
// ayarlar sayfası (options.js) gerçekleriyle çağırır. Amaç tahminleri gerçek sayılarla değiştirmek (docs/PERFORMANS-RAPORU.md).

export const BENCH = Object.freeze({
  sepRate: 48000,
  sepChunkSec: 8,        // akış kipinde art arda parçalar; ilki ısınma sayılır
  sepChunks: 3,
  sepBatches: [1, 2, 4],  // yalnız WebGPU'da; WASM'da tek yapılandırma. 8 yok: tek GPU işi sürücü sınırını aşabilir
  maxRunSec: 0.8,        // sonraki toplu boyutun tahmini tek model çağrısı süresi bunu aşacaksa denenmez (Windows ≈ 2 sn'de sürücüyü sıfırlar)
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
 * Ses ayırma: her toplu boyutu için yeni istemci yükler, akış kipinde art arda parçalar işler.
 * GPU güvenliği: toplu boyut küçükten büyüğe gider; bir sonrakinin tahmini tek model çağrısı süresi (toplu × pencere süresi)
 * maxRunSec'i aşacaksa denenmez. Çökme koruması (guard): her deneme öncesi "yarım" işaretlenir, başarıyla bitince silinir; sayfa/sürücü
 * denemenin ortasında giderse bir sonraki testte o toplu boyut ve üstü atlanır (sınır capDays gün geçerli).
 * @param {{ createClient: () => { load:Function, process:Function, dispose:Function }, now?: () => number,
 *           batches?: number[], chunkSec?: number, chunks?: number, rate?: number, onStep?: (s:string)=>void,
 *           guard?: { read:()=>Promise<{ inflight?:number, cap?:{ batch:number, at:number }|null }>, mark:(b:number)=>Promise<void>,
 *                     clear:()=>Promise<void>, setCap:(b:number)=>Promise<void> }, maxRunSec?: number, nowMs?: () => number }} o
 * @returns {Promise<{ runs: { batch:number, backend?:string, model?:string, loadMs?:number, rtfs?:number[], rtf?:number, error?:string }[],
 *           interrupted?: number, cap?: number, stopped?: { batch:number, reason:string } }>}
 */
export async function runSepBench({ backend = 'auto', webnnDevice, createClient, now = () => performance.now(), batches = BENCH.sepBatches, chunkSec = BENCH.sepChunkSec,
  chunks = BENCH.sepChunks, rate = BENCH.sepRate, onStep, guard, maxRunSec = BENCH.maxRunSec, nowMs = () => Date.now() } = {}) {
  const runs = [];
  const out = { runs };
  // önceki test yarıda kaldıysa o toplu boyut ve üstü atlanır
  if (guard) {
    const st = await guard.read().catch(() => ({}));
    let capBatch = st?.cap && nowMs() - st.cap.at < BENCH.capDays * 86400000 ? st.cap.batch : null;
    if (st?.inflight) {
      out.interrupted = st.inflight;
      capBatch = Math.min(capBatch ?? Infinity, st.inflight);
      await guard.setCap(capBatch).catch(() => {});
      await guard.clear().catch(() => {});
    }
    if (capBatch != null) {
      out.cap = capBatch;
      batches = batches.filter((b) => b < capBatch);
      if (!batches.length) batches = [];
    }
  }
  let prev = null;
  for (const batch of batches) {
    if (prev?.rtf > 0 && prev.stepSec > 0 && batch * prev.rtf * prev.stepSec > maxRunSec) {
      out.stopped = { batch, reason: `tahmini tek GPU işi ${(batch * prev.rtf * prev.stepSec).toFixed(1)} sn > ${maxRunSec} sn (sürücü sınırına yakın)` };
      break;
    }
    const run = { batch };
    const client = createClient();
    try {
      await guard?.mark(batch).catch(() => {});
      onStep?.(`Ses ayırma: toplu ${batch} yükleniyor…`);
      const t0 = now();
      const info = await withTimeout(client.load({ model: 'auto', backend, ...(webnnDevice ? { webnnDevice } : {}), batch }), BENCH.loadTimeoutMs, 'Ayırma modeli yükleme');
      run.loadMs = now() - t0;
      run.backend = info?.backend;
      run.fallbackReason = info?.fallbackReason || null;
      run.model = info?.model;
      run.stepSec = info?.stepSec > 0 ? info.stepSec : 2.96;
      const rtfs = [];
      for (let k = 0; k < chunks; k++) {
        onStep?.(`Ses ayırma: toplu ${batch}, parça ${k + 1}/${chunks}…`);
        const { left, right } = benchSignal(chunkSec, rate, k * chunkSec);
        const t1 = now();
        await withTimeout(client.process(left, right, rate, { startSample: Math.round(k * chunkSec * rate), final: k === chunks - 1 }), BENCH.sepTimeoutMs, 'Ayırma parçası');
        rtfs.push(rtf(now() - t1, chunkSec));
      }
      run.rtfs = rtfs;
      run.rtf = mean(rtfs.slice(1)); // ilk parça ısınma/akış başlangıcı sayılmaz
      await guard?.clear().catch(() => {}); // bu toplu boyut çökmeden bitti
    } catch (e) {
      run.error = String(e?.message || e);
      await guard?.clear().catch(() => {}); // hata yakalandı (sayfa gitmedi): çökme değil
    } finally {
      try { await client.dispose?.(); } catch { /* sessiz: ölçüm sonrası temizlik */ }
    }
    runs.push(run);
    if (run.error || run.backend !== 'webgpu' || backend === 'webnn') break; // WASM'da toplu boyutu farksız; hata varsa daha büyüğü denenmez
    prev = run;
  }
  return out;
}

/** Seslendirme: ilk cümle ısınma; kalanların toplam süresi / toplam ses süresi. synth(text) → { ms, audioSec } | { skipped } */
export async function runTtsBench({ synth, sentences = BENCH.tts, onStep } = {}) {
  let ms = 0;
  let audioSec = 0;
  try {
    for (let i = 0; i < sentences.length; i++) {
      onStep?.(`Seslendirme: ${i + 1}/${sentences.length}…`);
      const r = await synth(sentences[i]);
      if (r?.skipped) return { skipped: r.skipped };
      if (i === 0) continue;
      ms += r.ms;
      audioSec += r.audioSec;
    }
    return { sentences: sentences.length - 1, ms, audioSec, rtf: rtf(ms, audioSec) };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
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

/** Üç aşamayı sırayla çalıştırır; biri hata verse diğerleri sürer. */
export async function runBench({ sep, sepNpu, tts, mt, onStep, now = () => Date.now() } = {}) {
  const result = { at: now() };
  result.sep = sep ? await runSepBench({ ...sep, onStep }) : null;
  // deneysel: aynı ölçüm WebNN (NPU) ile; yedeğe düşerse arka uç adı bunu gösterir
  result.sepNpu = sepNpu ? await runSepBench({ ...sepNpu, backend: 'webnn', webnnDevice: sepNpu.webnnDevice || 'npu', batches: [1], guard: undefined, onStep }) : null;
  result.tts = tts ? await runTtsBench({ ...tts, onStep }) : null;
  result.mt = mt ? await runMtBench({ ...mt, onStep }) : null;
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

/** Sonuç → metin satırları (ayarlar sayfasında gösterim ve tanılama raporu). */
export function formatBench(r) {
  const L = [];
  const sep = r?.sep;
  if (!sep) L.push('ses ayırma: çalıştırılmadı');
  else if (!sep.runs.length) L.push('ses ayırma: sonuç yok', ...sepNotes(sep));
  else {
    const h = sep.runs.find((x) => x.backend) || sep.runs[0];
    L.push(`ses ayırma: arka uç ${h.backend || '?'} · model ${h.model || '?'}${h.loadMs != null ? ` · yükleme ${f1(h.loadMs / 1000)} sn` : ''}`);
    L.push(...sepNotes(sep));
    for (const x of sep.runs) {
      if (x.error) L.push(`  toplu ${x.batch}: hata — ${x.error}`);
      else if (!(x.rtf > 0)) L.push(`  toplu ${x.batch}: ölçülemedi`);
      else L.push(`  toplu ${x.batch}: ${f2(x.rtf)} rtf (${f1(1 / x.rtf)}× gerçek zaman)`);
    }
    const best = fastestBatch(sep.runs);
    if (best && sep.runs.filter((x) => !x.error).length > 1) L.push(`  en hızlı: toplu ${best.batch}`);
    if (sep.stopped) L.push(`  toplu ${sep.stopped.batch} denenmedi: ${sep.stopped.reason}`);
    if (best && best.backend !== 'webgpu') L.push('  WebGPU yok ya da kullanılamadı: ayırma işlemcide (WASM) çalıştı');
  }
  const n = r?.sepNpu;
  if (n) {
    const x = n.runs?.[0];
    if (!x) L.push('ses ayırma (WebNN): sonuç yok');
    else if (x.error) L.push(`ses ayırma (WebNN): hata — ${x.error}`);
    else if (x.backend !== 'webnn') L.push(`ses ayırma (WebNN): kullanılamadı, ${x.backend || '?'} çalıştı${x.fallbackReason ? ` (${x.fallbackReason})` : ''}`);
    else if (!(x.rtf > 0)) L.push('ses ayırma (WebNN): ölçülemedi');
    else L.push(`ses ayırma (WebNN): ${f2(x.rtf)} rtf (${f1(1 / x.rtf)}× gerçek zaman) · yükleme ${f1((x.loadMs || 0) / 1000)} sn`);
  }
  const t = r?.tts;
  if (!t) L.push('seslendirme: çalıştırılmadı');
  else if (t.skipped) L.push(`seslendirme: atlandı (${t.skipped})`);
  else if (t.error) L.push(`seslendirme: hata — ${t.error}`);
  else if (!(t.rtf > 0)) L.push('seslendirme: ölçülemedi');
  else L.push(`seslendirme: ${t.sentences} cümle, ${f2(t.rtf)} rtf (${f1(1 / t.rtf)}× gerçek zaman)`);
  const m = r?.mt;
  if (!m) L.push('çeviri: çalıştırılmadı');
  else if (m.error) L.push(`çeviri: hata — ${m.error}`);
  else L.push(`çeviri: ${m.sentences} cümle, ${f1(m.perSec)} cümle/sn`);
  return L;
}
