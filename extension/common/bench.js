// Hız testi: bu cihazda ses ayırma (WebGPU/WASM, toplu boyutları), seslendirme ve çeviri hızını ölçer.
// Saf modül (DOM yok): bağımlılıklar (ayırma istemcisi, sentez, çeviri) dışarıdan verilir; Node testleri sahteleriyle sınar,
// ayarlar sayfası (options.js) gerçekleriyle çağırır. Amaç tahminleri gerçek sayılarla değiştirmek (docs/PERFORMANS-RAPORU.md).

export const BENCH = Object.freeze({
  sepRate: 48000,
  sepChunkSec: 8,        // akış kipinde art arda parçalar; ilki ısınma sayılır
  sepChunks: 3,
  sepBatches: [1, 2, 4, 8], // yalnız WebGPU'da; WASM'da tek yapılandırma
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
 * @param {{ createClient: () => { load:Function, process:Function, dispose:Function }, now?: () => number,
 *           batches?: number[], chunkSec?: number, chunks?: number, rate?: number, onStep?: (s:string)=>void }} o
 * @returns {Promise<{ runs: { batch:number, backend?:string, model?:string, loadMs?:number, rtfs?:number[], rtf?:number, error?:string }[] }>}
 */
export async function runSepBench({ createClient, now = () => performance.now(), batches = BENCH.sepBatches, chunkSec = BENCH.sepChunkSec,
  chunks = BENCH.sepChunks, rate = BENCH.sepRate, onStep } = {}) {
  const runs = [];
  for (const batch of batches) {
    const run = { batch };
    const client = createClient();
    try {
      onStep?.(`Ses ayırma: toplu ${batch} yükleniyor…`);
      const t0 = now();
      const info = await withTimeout(client.load({ model: 'auto', backend: 'auto', batch }), BENCH.loadTimeoutMs, 'Ayırma modeli yükleme');
      run.loadMs = now() - t0;
      run.backend = info?.backend;
      run.model = info?.model;
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
    } catch (e) {
      run.error = String(e?.message || e);
    } finally {
      try { await client.dispose?.(); } catch { /* sessiz: ölçüm sonrası temizlik */ }
    }
    runs.push(run);
    if (run.error || run.backend !== 'webgpu') break; // WASM'da toplu boyutu farksız; hata varsa daha büyüğü denenmez
  }
  return { runs };
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
export async function runBench({ sep, tts, mt, onStep, now = () => Date.now() } = {}) {
  const result = { at: now() };
  result.sep = sep ? await runSepBench({ ...sep, onStep }) : null;
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

/** Sonuç → metin satırları (ayarlar sayfasında gösterim ve tanılama raporu). */
export function formatBench(r) {
  const L = [];
  const sep = r?.sep;
  if (!sep) L.push('ses ayırma: çalıştırılmadı');
  else if (!sep.runs.length) L.push('ses ayırma: sonuç yok');
  else {
    const h = sep.runs.find((x) => x.backend) || sep.runs[0];
    L.push(`ses ayırma: arka uç ${h.backend || '?'} · model ${h.model || '?'}${h.loadMs != null ? ` · yükleme ${f1(h.loadMs / 1000)} sn` : ''}`);
    for (const x of sep.runs) {
      if (x.error) L.push(`  toplu ${x.batch}: hata — ${x.error}`);
      else if (!(x.rtf > 0)) L.push(`  toplu ${x.batch}: ölçülemedi`);
      else L.push(`  toplu ${x.batch}: ${f2(x.rtf)} rtf (${f1(1 / x.rtf)}× gerçek zaman)`);
    }
    const best = fastestBatch(sep.runs);
    if (best && sep.runs.filter((x) => !x.error).length > 1) L.push(`  en hızlı: toplu ${best.batch}`);
    if (best && best.backend !== 'webgpu') L.push('  WebGPU yok ya da kullanılamadı: ayırma işlemcide (WASM) çalıştı');
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
