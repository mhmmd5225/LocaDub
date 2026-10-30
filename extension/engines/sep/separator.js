// Konuşma ayırıcı: stereo PCM → eşlik (müzik + efekt, konuşma çıkarılmış). Ortamdan bağımsız çekirdek: işçide
// onnxruntime-web, Node testlerinde/benchmark'ta onnxruntime-node ile aynı kod çalışır.
//
//   const sep = createSeparator({ model: 'kim-vocal-2', backend: 'auto', onProgress });
//   await sep.load();
//   const { left, right, backend } = await sep.process(L, R, 48000);
//
// İç parçalama: model 5.92 sn'lik (hop·(dim_t−1)) pencerelerde çalışır; pencereler `overlap` (varsayılan 0.5)
// örtüşmeyle Hann ağırlıklı toplanır, girişin iki ucu (1−overlap)'ın tamamlayanı kadar sıfırla dolgulanır.
// Böylece bir çağrının içinde parça sınırı duyulmaz.
//
// Çağrılar arası birleşme (canlı akış): model her iki yanda ~CONTEXT_SEC saniye bağlam görmeden kenarda
// biraz farklı sonuç verir. Ardışık çağrılar en az 2·CONTEXT_SEC örtüşmeli ve çıktılar örtüşmenin ortasından
// kısa bir çapraz geçişle birleştirilmelidir (joinOverlap). Yani her çağrı yeni sesin önüne önceki
// çağrının son 2·CONTEXT_SEC saniyesini ekler; bir çağrının son CONTEXT_SEC saniyesi, sonraki çağrı gelene
// kadar kesinleşmiş sayılmaz (gecikme = CONTEXT_SEC). Ölçüm: docs/SES-AYIRMA.md.

import { sepModelById, chunkSamples, WASM_SEP_MODEL } from './models.js';
import { stftPair, istftPair, hann } from './stft.js';
import { resample } from './resample.js';

/** Bir çağrının her iki ucunda önerilen bağlam (sn). */
export const CONTEXT_SEC = 1;
/** joinOverlap'in varsayılan çapraz geçişi (sn). */
export const FADE_SEC = 0.05;
export const DEFAULT_OVERLAP = 0.5;
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
 * @param {number} [opts.batch] bir çalıştırmadaki pencere sayısı
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
  const batch = Math.max(1, Math.floor(opts.batch || 1));
  const denoise = !!opts.denoise;
  let ort = opts.ort || null;
  let session = opts.session || null;
  let backend = session ? opts.backend || 'custom' : null;
  let loading = null;
  let queue = Promise.resolve();

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
    if (session) return { backend, model: model.id };
    if (!loading) {
      loading = (async () => {
        const o = await getOrt();
        let be = await pickBackend(opts.backend || 'auto');
        if (autoModel && be === 'wasm') model = sepModelById(WASM_SEP_MODEL);
        let bytes = await modelBytes();
        try {
          session = await createSession(o, bytes, be);
          await warmUp();
        } catch (e) {
          if (be !== 'webgpu') throw e;
          console.warn('[sep] WebGPU oturumu kurulamadı, WASM deneniyor', e);
          session = null;
          be = 'wasm';
          if (autoModel) { model = sepModelById(WASM_SEP_MODEL); bytes = await modelBytes(); }
          session = await createSession(o, bytes, be);
          await warmUp();
        }
        backend = be;
        return { backend, model: model.id };
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

  /** 44.1 kHz stereo → hedef kaynağın (model.stem) dalga biçimi, aynı uzunlukta. */
  async function separateNative(L, R) {
    const n = L.length;
    const chunk = chunkSamples(model);
    const step = Math.max(model.hop, Math.round(chunk * (1 - overlap)));
    const pad = chunk - step;
    const starts = [];
    for (let s = -pad; ; s += step) {
      starts.push(s);
      if (s + chunk >= n + pad) break;
    }
    const win = hann(chunk);
    const accL = new Float64Array(n), accR = new Float64Array(n), wsum = new Float64Array(n);
    const plane = model.dimF * model.dimT;
    const stftOpts = { nFft: model.nFft, hop: model.hop, maxBins: model.dimF };
    const segL = new Float32Array(chunk), segR = new Float32Array(chunk);
    const runs = denoise ? 2 * batch : batch; // oturumun toplu boyutu sabit
    const prepare = (b0) => {
      const group = starts.slice(b0, b0 + batch);
      const data = new Float32Array(runs * 4 * plane);
      group.forEach((s, gi) => {
        segL.fill(0); segR.fill(0);
        const lo = Math.max(0, s), hi = Math.min(n, s + chunk);
        if (hi > lo) { segL.set(L.subarray(lo, hi), lo - s); segR.set(R.subarray(lo, hi), lo - s); }
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
      const { group, data } = next;
      const pending = runModel(data, runs);
      // WebGPU çalışırken bir sonraki grubun STFT'si hazırlanır
      next = b0 + batch < starts.length ? prepare(b0 + batch) : null;
      const out = await pending;
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
        const lo = Math.max(0, s), hi = Math.min(n, s + chunk);
        for (let j = lo; j < hi; j++) {
          const w = win[j - s];
          accL[j] += yl[j - s] * w; accR[j] += yr[j - s] * w; wsum[j] += w;
        }
      });
    }
    const outL = new Float32Array(n), outR = new Float32Array(n);
    const k = model.compensate || 1;
    for (let j = 0; j < n; j++) {
      const w = wsum[j] > 1e-8 ? k / wsum[j] : 0;
      outL[j] = accL[j] * w; outR[j] = accR[j] * w;
    }
    return [outL, outR];
  }

  async function processNow(left, right, sampleRate) {
    if (!session) await load();
    if (!(left instanceof Float32Array)) throw new Error('left Float32Array olmalı');
    right = right && right.length ? right : left;
    if (right.length !== left.length) throw new Error('Kanal uzunlukları farklı');
    const sr = Math.round(sampleRate || model.sampleRate);
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

  return {
    get model() { return model; },
    get backend() { return backend; },
    contextSec: CONTEXT_SEC,
    get chunkSec() { return chunkSamples(model) / model.sampleRate; },
    load,
    /** Çağrılar sırayla çalışır (ORT oturumu eşzamanlı çalıştırılmaz). */
    process(left, right, sampleRate) {
      const p = queue.then(() => processNow(left, right, sampleRate));
      queue = p.catch(() => {});
      return p;
    },
    async dispose() {
      const s = session;
      session = null;
      loading = null;
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
