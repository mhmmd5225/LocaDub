// Konuşma ayırıcı: stereo PCM → eşlik (müzik + efekt, konuşma çıkarılmış). Ortamdan bağımsız çekirdek: işçide
// onnxruntime-web, Node testlerinde/benchmark'ta onnxruntime-node ile aynı kod çalışır.
//
//   const sep = createSeparator({ model: 'kim-vocal-2', backend: 'auto', onProgress });
//   await sep.load();
//   const { left, right, backend } = await sep.process(L, R, 48000);                 // tek parça
//   const r = await sep.process(L, R, 48000, { startSample, final });                 // akış (aşağıda)
//
// İç parçalama: model 5.92 sn'lik (hop·(dim_t−1)) pencerelerde çalışır; pencereler `overlap` (varsayılan 0.5)
// örtüşmeyle Hann ağırlıklı toplanır.
//
// Tek parça kipi (startSample yok): pencereler girdinin başına göre dizilir, iki uç (pencere − adım) kadar sıfırla
// dolgulanır; bir çağrının içinde parça sınırı duyulmaz. Çağrılar arası birleşmede model her iki yanda ~CONTEXT_SEC
// bağlam görmeden kenarda biraz farklı sonuç verir: ardışık çağrılar en az 2·CONTEXT_SEC örtüşmeli ve çıktılar
// örtüşmenin ortasından kısa çapraz geçişle birleşmelidir (joinOverlap). Pencere işi ≈ 3.5× ses süresi
// (12 sn + 2·1 sn bağlam + iki uçta dolgu ≈ 7 pencere).
//
// Akış kipi (o.startSample = girdinin ilk örneğinin mutlak dizini, girdi hızında: medya zamanı · sampleRate):
// pencereler mutlak model ızgarasında (44.1 kHz, medya zamanı · 44100) k·adım konumlarındadır. Ayırıcı bekleyen
// ağırlıklı toplamları (+ ağırlık toplamlarını) ve sonraki pencerenin girdisini tutar; yeniden örnekleme de durumludur
// (resample.js StreamResampler). Her çağrı yalnızca kesinleşen aralığı (onu örten tüm pencereler bitti) döndürür:
// { left, right, startSample, windows, reset, final } — çıktı girdinin (pencere − adım)..pencere kadar gerisindedir.
// Ardışık çağrıların çıktısı aynı girdinin tek çağrısınınkiyle örneği örneğine aynıdır; pencere işi
// ≈ 1/(1 − overlap) = 2× ses süresi. Kesinti (startSample bitişik değil, hız değişti, o.reset) akışı sıfırlar
// (reset: true): yeni akışın başı bağlamdır (öncesi sıfır sayılır), çağıran CONTEXT_SEC kırpıp çapraz geçişle ekler.
// o.final: girdi sonrası sıfır sayılıp her şey kesinleştirilir (video sonu / önceden ayrılmış parçaya varış), akış biter.
// Ölçüm: docs/SES-AYIRMA.md.

import { sepModelById, chunkSamples, WASM_SEP_MODEL } from './models.js';
import { stftPair, istftPair, hann } from './stft.js';
import { resample, StreamResampler } from './resample.js';

/** Bir çağrının her iki ucunda önerilen bağlam (sn). */
export const CONTEXT_SEC = 1;
/** joinOverlap'in varsayılan çapraz geçişi (sn). */
export const FADE_SEC = 0.05;
export const DEFAULT_OVERLAP = 0.5;
/** batch verilmezse: WebGPU'da bir çalıştırmada 4 pencere, WASM'da 1 (çıktıyı değiştirmez). */
export const DEFAULT_BATCH = Object.freeze({ webgpu: 4, wasm: 1, cpu: 1 });
/** UVR gibi en alt 3 bin (DC civarı) sıfırlanır. */
const ZERO_LOW_BINS = 3;

/**
 * @param {object} opts
 * @param {string|object} [opts.model] katalog kimliği (models.js), model nesnesi ya da 'auto' (WebGPU'da
 *   varsayılan model, WASM'da hafif model; seçim load()'da)
 * @param {'webgpu'|'wasm'|'auto'|'cpu'} [opts.backend] 'cpu' yalnızca onnxruntime-node
 * @param {(p:{loaded:number,total:number})=>void} [opts.onProgress] indirme ilerlemesi
 * @param {object} [opts.ort] onnxruntime modülü (yoksa paketli ort.webgpu.min.mjs)
 * @param {(url:string, o:object)=>Promise<ArrayBuffer>} [opts.fetchModel] (yoksa model-cache.js)
 * @param {ArrayBuffer|Uint8Array} [opts.modelData] model baytları (indirmeyi atlar)
 * @param {number} [opts.overlap] iç pencere örtüşmesi 0..0.9
 * @param {number} [opts.batch] bir çalıştırmadaki pencere sayısı (yoksa DEFAULT_BATCH[arka uç])
 * @param {boolean} [opts.denoise] UVR "denoise": model(x) ve −model(−x) ortalaması (2× maliyet)
 * @param {object} [opts.sessionOptions] ek InferenceSession seçenekleri
 * @param {object} [opts.session] hazır oturum ({ run, inputNames, outputNames }; testler için)
 */
export function createSeparator(opts = {}) {
  const autoModel = opts.model === 'auto';
  let model = typeof opts.model === 'object' && opts.model ? opts.model : sepModelById(autoModel ? null : opts.model);
  if (!model) throw new Error(`Bilinmeyen ayırma modeli: ${opts.model}`);
  if (model.arch !== 'mdx') throw new Error(`Desteklenmeyen mimari: ${model.arch}`);
  const overlap = Math.min(0.9, Math.max(0, opts.overlap ?? DEFAULT_OVERLAP));
  const wantBatch = opts.batch > 0 ? Math.floor(opts.batch) : 0;
  let batch = Math.max(1, wantBatch || 1);
  const denoise = !!opts.denoise;
  let ort = opts.ort || null;
  let session = opts.session || null;
  let backend = session ? opts.backend || 'custom' : null;
  let loading = null;
  let queue = Promise.resolve();
  let stream = null;
  const stats = { windows: 0, runs: 0 };

  async function getOrt() {
    if (!ort) {
      ort = await import('../../lib/ort/ort.webgpu.min.mjs');
      ort.env.wasm.wasmPaths = new URL('../../lib/ort/', import.meta.url).href;
    }
    return ort;
  }

  async function modelBytes() {
    if (opts.modelData) return opts.modelData;
    const fetchModel = opts.fetchModel || (await import('../common/model-cache.js')).fetchModel;
    const buf = await fetchModel(model.url, {
      onProgress: (p) => opts.onProgress?.({ loaded: p.loaded, total: p.total || model.bytes }),
    });
    if (model.bytes && buf.byteLength !== model.bytes) {
      throw new Error(`Ayırma modeli bozuk indi (${buf.byteLength}/${model.bytes} bayt)`);
    }
    return buf;
  }

  async function pickBackend(want) {
    if (want === 'cpu' || want === 'wasm') return want;
    const gpu = globalThis.navigator?.gpu;
    if (gpu) {
      const adapter = await gpu.requestAdapter().catch(() => null);
      if (adapter) return 'webgpu';
    }
    if (want === 'webgpu') console.warn('[sep] WebGPU yok, WASM kullanılıyor');
    return 'wasm';
  }

  async function createSession(o, bytes, be) {
    const so = {
      graphOptimizationLevel: 'all',
      executionProviders: [be],
      freeDimensionOverrides: { batch_size: denoise ? 2 * batch : batch },
      ...(opts.sessionOptions || {}),
    };
    return o.InferenceSession.create(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), so);
  }

  async function load() {
    if (session) return { backend, model: model.id, batch };
    if (!loading) {
      loading = (async () => {
        const o = await getOrt();
        let be = await pickBackend(opts.backend || 'auto');
        if (autoModel && be === 'wasm') model = sepModelById(WASM_SEP_MODEL);
        let bytes = await modelBytes();
        const open = async (b, n) => {
          batch = n;
          session = await createSession(o, bytes, b);
          await warmUp();
        };
        try {
          await open(be, wantBatch || DEFAULT_BATCH[be] || 1);
        } catch (e) {
          if (be !== 'webgpu') throw e;
          session = null;
          let ok = false;
          if (!wantBatch && DEFAULT_BATCH.webgpu > 1) {
            // toplu çalıştırma GPU belleğine sığmadıysa tek pencereyle (çıktı aynı, yalnızca daha yavaş)
            console.warn('[sep] WebGPU toplu çalıştırma kurulamadı, batch 1 deneniyor', e);
            try { await open(be, 1); ok = true; } catch { session = null; }
          }
          if (!ok) {
            console.warn('[sep] WebGPU oturumu kurulamadı, WASM deneniyor', e);
            be = 'wasm';
            if (autoModel) { model = sepModelById(WASM_SEP_MODEL); bytes = await modelBytes(); }
            await open(be, wantBatch || DEFAULT_BATCH.wasm);
          }
        }
        backend = be;
        return { backend, model: model.id, batch };
      })();
      loading.catch(() => { loading = null; });
    }
    return loading;
  }

  // ilk çalıştırma bellek ayırır, WebGPU'da gölgelendiricileri derler
  async function warmUp() {
    const n = denoise ? 2 * batch : batch;
    const plane = model.dimF * model.dimT;
    await runModel(new Float32Array(n * 4 * plane), n);
  }

  async function runModel(data, n) {
    const o = ort;
    const T = o?.Tensor || session.Tensor;
    const input = new T('float32', data, [n, 4, model.dimF, model.dimT]);
    const out = await session.run({ [session.inputNames[0]]: input });
    const t = out[session.outputNames[0]];
    const res = t.data instanceof Float32Array ? t.data : await t.getData?.();
    t.dispose?.();
    input.dispose?.();
    return res;
  }

  const geom = () => {
    const chunk = chunkSamples(model);
    return { chunk, step: Math.max(model.hop, Math.round(chunk * (1 - overlap))) };
  };

  /**
   * Pencereleri `batch`'lik gruplarla çalıştırır. fill(s, segL, segR): s'de başlayan pencerenin girdisi (sıfırlı
   * dizilere); add(s, yl, yr): çıktısı. Model çalışırken sonraki grubun STFT'si hazırlanır. Son grup eksikse sıfırla
   * dolar (oturumun toplu boyutu sabit); çıktı pencere başınadır, gruplamadan bağımsızdır.
   */
  async function runWindows(starts, fill, add, isCancelled) {
    if (!starts.length) return;
    const chunk = chunkSamples(model);
    const plane = model.dimF * model.dimT;
    const stftOpts = { nFft: model.nFft, hop: model.hop, maxBins: model.dimF };
    const segL = new Float32Array(chunk), segR = new Float32Array(chunk);
    const runs = denoise ? 2 * batch : batch;
    const prepare = (b0) => {
      const group = starts.slice(b0, b0 + batch);
      const data = new Float32Array(runs * 4 * plane);
      group.forEach((s, gi) => {
        segL.fill(0); segR.fill(0);
        fill(s, segL, segR);
        const sp = stftPair(segL, segR, stftOpts);
        const base = gi * 4 * plane;
        data.set(sp.a.re, base); data.set(sp.a.im, base + plane);
        data.set(sp.b.re, base + 2 * plane); data.set(sp.b.im, base + 3 * plane);
        for (let c = 0; c < 4; c++) data.fill(0, base + c * plane, base + c * plane + ZERO_LOW_BINS * model.dimT);
        if (denoise) {
          const nb = (batch + gi) * 4 * plane;
          for (let i = 0; i < 4 * plane; i++) data[nb + i] = -data[base + i];
        }
      });
      return { group, data };
    };
    let next = prepare(0);
    for (let b0 = 0; b0 < starts.length; b0 += batch) {
      if (isCancelled?.()) throw new Error('cancelled');
      const { group, data } = next;
      const pending = runModel(data, runs);
      next = b0 + batch < starts.length ? prepare(b0 + batch) : null;
      const out = await pending;
      stats.runs++;
      stats.windows += group.length;
      group.forEach((s, gi) => {
        const base = gi * 4 * plane;
        let o = out.subarray(base, base + 4 * plane);
        if (denoise) {
          const neg = out.subarray((batch + gi) * 4 * plane, (batch + gi + 1) * 4 * plane);
          const avg = new Float32Array(4 * plane);
          for (let i = 0; i < avg.length; i++) avg[i] = 0.5 * (o[i] - neg[i]);
          o = avg;
        }
        const [yl, yr] = istftPair(
          { re: o.subarray(0, plane), im: o.subarray(plane, 2 * plane) },
          { re: o.subarray(2 * plane, 3 * plane), im: o.subarray(3 * plane, 4 * plane) },
          { nFft: model.nFft, hop: model.hop, frames: model.dimT, bins: model.dimF, length: chunk },
        );
        add(s, yl, yr);
      });
    }
  }

  // ---- tek parça kipi ----

  /** 44.1 kHz stereo → hedef kaynağın (model.stem) dalga biçimi, aynı uzunlukta. */
  async function separateNative(L, R) {
    const n = L.length;
    const { chunk, step } = geom();
    const pad = chunk - step;
    const starts = [];
    for (let s = -pad; ; s += step) {
      starts.push(s);
      if (s + chunk >= n + pad) break;
    }
    const win = hann(chunk);
    const accL = new Float64Array(n), accR = new Float64Array(n), wsum = new Float64Array(n);
    await runWindows(starts, (s, segL, segR) => {
      const lo = Math.max(0, s), hi = Math.min(n, s + chunk);
      if (hi > lo) { segL.set(L.subarray(lo, hi), lo - s); segR.set(R.subarray(lo, hi), lo - s); }
    }, (s, yl, yr) => {
      const lo = Math.max(0, s), hi = Math.min(n, s + chunk);
      for (let j = lo; j < hi; j++) {
        const w = win[j - s];
        accL[j] += yl[j - s] * w; accR[j] += yr[j - s] * w; wsum[j] += w;
      }
    });
    const outL = new Float32Array(n), outR = new Float32Array(n);
    const k = model.compensate || 1;
    for (let j = 0; j < n; j++) {
      const w = wsum[j] > 1e-8 ? k / wsum[j] : 0;
      outL[j] = accL[j] * w; outR[j] = accR[j] * w;
    }
    return [outL, outR];
  }

  async function processNow(left, right, sr) {
    const n = left.length;
    if (!n) return { left: new Float32Array(0), right: new Float32Array(0), backend };
    const native = sr !== model.sampleRate;
    const L = native ? resample(left, sr, model.sampleRate) : left;
    const R = native ? resample(right, sr, model.sampleRate) : right;
    let [tl, tr] = await separateNative(L, R);
    if (model.stem === 'vocals') {
      for (let j = 0; j < tl.length; j++) { tl[j] = L[j] - tl[j]; tr[j] = R[j] - tr[j]; }
    }
    if (native) {
      tl = resample(tl, model.sampleRate, sr, n);
      tr = resample(tr, model.sampleRate, sr, n);
    }
    return { left: tl, right: tr, backend };
  }

  // ---- akış kipi ----

  function newStream(sr, start) {
    const msr = model.sampleRate;
    const native = sr !== msr;
    const { chunk, step } = geom();
    const rin = native ? [new StreamResampler(sr, msr, start), new StreamResampler(sr, msr, start)] : null;
    const s0 = native ? rin[0].next : start; // model ızgarasında ilk örnek
    return {
      sr, native, chunk, step, win: hann(chunk), rin,
      rout: native ? [new StreamResampler(msr, sr, s0, start), new StreamResampler(msr, sr, s0, start)] : null,
      inPos: start, outPos: start,
      // model hızındaki girdi [mb.s, mb.s + mb.n) ve bekleyen ağırlıklı toplamlar [acc.s, acc.s + acc.n)
      mb: { s: s0, n: 0, L: new Float32Array(0), R: new Float32Array(0) },
      acc: { s: s0, n: 0, L: new Float64Array(0), R: new Float64Array(0), W: new Float64Array(0) },
      nextK: Math.floor((s0 - chunk) / step) + 1, // sonu s0'ı geçen ilk pencere
      fEnd: s0, // kesinleşen son (model ızgarası)
    };
  }

  const grow = (a, need) => {
    if (a.length >= need) return a;
    const b = new a.constructor(Math.max(need, Math.ceil(a.length * 1.5)));
    b.set(a);
    return b;
  };

  function trimTo(o, abs, keys) {
    const d = Math.min(o.n, abs - o.s);
    if (d <= 0) return;
    for (const k of keys) o[k].copyWithin(0, d, o.n);
    o.s += d; o.n -= d;
  }

  const concat = (a, b) => {
    if (!b.length) return a;
    const c = new Float32Array(a.length + b.length);
    c.set(a); c.set(b, a.length);
    return c;
  };

  async function processStream(left, right, sr, { startSample, final = false, reset = false, isCancelled } = {}) {
    const start = Math.round(startSample);
    let restarted = false;
    if (!stream || reset || stream.sr !== sr || stream.inPos !== start) { stream = newStream(sr, start); restarted = true; }
    const S = stream;
    try {
      const msr = model.sampleRate;
      S.inPos += left.length;
      // 1. girdi → model ızgarası
      let ml = left, mr = right;
      if (S.native) {
        ml = S.rin[0].push(left); mr = S.rin[1].push(right);
        if (final) {
          const e = Math.ceil((S.inPos * msr) / sr);
          ml = concat(ml, S.rin[0].flush(e)); mr = concat(mr, S.rin[1].flush(e));
        }
      }
      const { chunk, step, win, mb, acc } = S;
      const nIn = mb.n + ml.length;
      mb.L = grow(mb.L, nIn); mb.R = grow(mb.R, nIn);
      mb.L.set(ml, mb.n); mb.R.set(mr, mb.n);
      mb.n = nIn;
      const mEnd = mb.s + mb.n;
      // 2. hesaplanabilir pencereler (final: girdinin dokunduğu hepsi, sonrası sıfır)
      const starts = [];
      for (let k = S.nextK; final ? k * step < mEnd : k * step + chunk <= mEnd; k++) starts.push(k * step);
      const accN = Math.max(acc.n, (starts.length ? starts[starts.length - 1] + chunk : acc.s) - acc.s);
      if (accN > acc.n) {
        for (const k of ['L', 'R', 'W']) { acc[k] = grow(acc[k], accN); acc[k].fill(0, acc.n, accN); }
        acc.n = accN;
      }
      await runWindows(starts, (s, segL, segR) => {
        const lo = Math.max(s, mb.s), hi = Math.min(s + chunk, mEnd);
        if (hi > lo) { segL.set(mb.L.subarray(lo - mb.s, hi - mb.s), lo - s); segR.set(mb.R.subarray(lo - mb.s, hi - mb.s), lo - s); }
      }, (s, yl, yr) => {
        const lo = Math.max(s, acc.s), hi = final ? Math.min(s + chunk, mEnd) : s + chunk;
        for (let j = lo; j < hi; j++) {
          const w = win[j - s], i = j - acc.s;
          acc.L[i] += yl[j - s] * w; acc.R[i] += yr[j - s] * w; acc.W[i] += w;
        }
      }, isCancelled);
      S.nextK += starts.length;
      // 3. kesinleşen [fEnd, f1): f1'den önceki örnekleri bundan sonraki pencereler örtmez
      const f1 = Math.max(S.fEnd, final ? mEnd : Math.min(mEnd, S.nextK * step));
      const n = f1 - S.fEnd;
      let yl = new Float32Array(n), yr = new Float32Array(n);
      const kc = model.compensate || 1;
      for (let i = 0; i < n; i++) {
        const a = S.fEnd + i - acc.s;
        const w = acc.W[a] > 1e-8 ? kc / acc.W[a] : 0;
        yl[i] = acc.L[a] * w; yr[i] = acc.R[a] * w;
      }
      if (model.stem === 'vocals') {
        for (let i = 0; i < n; i++) { const m = S.fEnd + i - mb.s; yl[i] = mb.L[m] - yl[i]; yr[i] = mb.R[m] - yr[i]; }
      }
      S.fEnd = f1;
      trimTo(acc, f1, ['L', 'R', 'W']);
      trimTo(mb, Math.min(f1, S.nextK * step), ['L', 'R']);
      // 4. model ızgarası → girdi hızı
      if (S.native) {
        let ol = S.rout[0].push(yl), or = S.rout[1].push(yr);
        if (final) { ol = concat(ol, S.rout[0].flush(S.inPos)); or = concat(or, S.rout[1].flush(S.inPos)); }
        yl = ol; yr = or;
      }
      const outStart = S.outPos;
      S.outPos += yl.length;
      if (final) stream = null;
      return { left: yl, right: yr, startSample: outStart, sampleRate: sr, backend, windows: starts.length, reset: restarted, final };
    } catch (e) {
      if (stream === S) stream = null; // yarım kalan durum güvenilmez: sonraki çağrı yeni akış
      throw e;
    }
  }

  async function run(left, right, sampleRate, o) {
    if (!session) await load();
    if (!(left instanceof Float32Array)) throw new Error('left Float32Array olmalı');
    right = right && right.length ? right : left;
    if (right.length !== left.length) throw new Error('Kanal uzunlukları farklı');
    const sr = Math.round(sampleRate || model.sampleRate);
    if (o && o.startSample != null) {
      if (!Number.isFinite(o.startSample)) throw new Error('startSample sayı olmalı');
      return processStream(left, right, sr, o);
    }
    return processNow(left, right, sr);
  }

  return {
    get model() { return model; },
    get backend() { return backend; },
    get batch() { return batch; },
    get overlap() { return overlap; },
    contextSec: CONTEXT_SEC,
    get chunkSec() { return chunkSamples(model) / model.sampleRate; },
    /** Akış ızgarasının adımı (sn). */
    get stepSec() { return geom().step / model.sampleRate; },
    /** Toplam çalıştırılan pencere ve model çağrısı (ölçüm). */
    stats,
    load,
    /**
     * Çağrılar sırayla çalışır (ORT oturumu eşzamanlı çalıştırılmaz). o: { startSample, final?, reset?,
     * isCancelled?() } verilirse akış kipi (dosya başı); isCancelled gruplar arasında sorulur.
     */
    process(left, right, sampleRate, o) {
      const p = queue.then(() => run(left, right, sampleRate, o));
      queue = p.catch(() => {});
      return p;
    },
    /** Akışı bırak (sonraki akış çağrısı yeni akış başlatır). */
    resetStream() { stream = null; },
    async dispose() {
      const s = session;
      session = null;
      loading = null;
      stream = null;
      await s?.release?.();
    },
  };
}

/**
 * İki ardışık çağrının çıktısını birleştirir. prev ve next, `overlap` örnek ortak ses içerir (prev'in son
 * overlap örneği = next'in ilk overlap örneği). Kesim örtüşmenin ortasında, `fade` örneklik yükseltilmiş
 * kosinüs çapraz geçişle yapılır. Dönüş: prev.length + next.length − overlap uzunluğunda Float32Array.
 */
export function joinOverlap(prev, next, overlap, fade = 0) {
  overlap = Math.max(0, Math.min(overlap, prev.length, next.length));
  fade = Math.max(0, Math.min(fade, overlap));
  const out = new Float32Array(prev.length + next.length - overlap);
  const start = prev.length - overlap; // next'in out içindeki konumu
  const cut = start + Math.floor(overlap / 2);
  const f0 = cut - Math.floor(fade / 2), f1 = f0 + fade;
  out.set(prev.subarray(0, f0));
  for (let i = f0; i < f1; i++) {
    const a = 0.5 - 0.5 * Math.cos((Math.PI * (i - f0 + 0.5)) / fade);
    out[i] = prev[i] * (1 - a) + next[i - start] * a;
  }
  out.set(next.subarray(f1 - start), f1);
  return out;
}
