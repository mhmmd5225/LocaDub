// Ses ayırma motoru (engines/sep): FFT/STFT/ISTFT, yeniden örnekleme, katalog, ayırıcının parçalama ve
// çağrılar arası birleşmesi (sahte model oturumuyla; gerçek model: tools/sep-bench.mjs), sahte işçi sözleşmesi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FFT, stft, stftPair, istft, istftPair } from '../../extension/engines/sep/stft.js';
import { resample } from '../../extension/engines/sep/resample.js';
import { SEP_MODELS, DEFAULT_SEP_MODEL, sepModelById, chunkSamples } from '../../extension/engines/sep/models.js';
import { createSeparator, joinOverlap, CONTEXT_SEC, FADE_SEC } from '../../extension/engines/sep/separator.js';
import { handleMessage, MOCK_GAIN } from '../../extension/engines/_mock/sep.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) - 0.5;
}
const noise = (n, seed = 1) => { const r = rng(seed); return Float32Array.from({ length: n }, r); };
const maxAbsDiff = (a, b, lo = 0, hi = a.length) => { let m = 0; for (let i = lo; i < hi; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
function snrDb(ref, x, lo = 0, hi = ref.length) {
  let s = 0, e = 0;
  for (let i = lo; i < hi; i++) { s += ref[i] ** 2; e += (x[i] - ref[i]) ** 2; }
  return 10 * Math.log10(s / Math.max(e, 1e-30));
}

test('FFT: karışık tabanlı boylar doğrudan DFT ile aynı, ters FFT geri getirir', () => {
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 12, 15, 20, 30, 60, 64, 98, 120]) {
    const re = Float64Array.from(noise(n, n)), im = Float64Array.from(noise(n, n + 99));
    const r0 = re.slice(), i0 = im.slice();
    const f = new FFT(n);
    f.transform(re, im);
    for (let k = 0; k < n; k++) {
      let sr = 0, si = 0;
      for (let j = 0; j < n; j++) {
        const a = (-2 * Math.PI * j * k) / n;
        sr += r0[j] * Math.cos(a) - i0[j] * Math.sin(a);
        si += r0[j] * Math.sin(a) + i0[j] * Math.cos(a);
      }
      assert.ok(Math.abs(sr - re[k]) < 1e-9 && Math.abs(si - im[k]) < 1e-9, `n=${n} k=${k}`);
    }
    f.transform(re, im, true);
    for (let j = 0; j < n; j++) assert.ok(Math.abs(re[j] / n - r0[j]) < 1e-12 && Math.abs(im[j] / n - i0[j]) < 1e-12);
  }
});

test('STFT: torch.stft(center, reflect, periyodik Hann) karesiyle aynı', () => {
  const nFft = 7680, hop = 1024, x = noise(30000, 3);
  const s = stft(x, { nFft, hop });
  assert.equal(s.frames, 1 + Math.floor(x.length / hop));
  assert.equal(s.bins, nFft / 2 + 1);
  const reflect = (i) => (i < 0 ? -i : i >= x.length ? 2 * (x.length - 1) - i : i);
  for (const t of [0, 7, s.frames - 1]) {
    for (const f of [0, 1, 500, 3072, nFft / 2]) {
      let re = 0, im = 0;
      for (let i = 0; i < nFft; i++) {
        const v = x[reflect(t * hop - nFft / 2 + i)] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nFft));
        const a = (-2 * Math.PI * f * i) / nFft;
        re += v * Math.cos(a); im += v * Math.sin(a);
      }
      const o = f * s.frames + t;
      assert.ok(Math.abs(re - s.re[o]) < 1e-3 && Math.abs(im - s.im[o]) < 1e-3, `t=${t} f=${f}`);
    }
  }
});

test('STFT → ISTFT gidiş-dönüş hatası < 1e-4 (modellerin n_fft değerleri, stereo paket ve mono)', () => {
  for (const nFft of [5120, 6144, 7680]) {
    const hop = 1024, a = noise(50000, nFft), b = noise(50000, nFft + 1);
    const sp = stftPair(a, b, { nFft, hop });
    const [ya, yb] = istftPair(sp.a, sp.b, { nFft, hop, frames: sp.frames, bins: sp.bins, length: a.length });
    assert.ok(maxAbsDiff(a, ya) < 1e-4, `n_fft ${nFft} sol`);
    assert.ok(maxAbsDiff(b, yb) < 1e-4, `n_fft ${nFft} sağ`);
    const m = stft(a, { nFft, hop });
    assert.ok(maxAbsDiff(a, istft(m, { nFft, hop, length: a.length })) < 1e-4, `n_fft ${nFft} mono`);
  }
});

test('Yeniden örnekleme: 48 kHz → 44.1 kHz frekansı korur, gidiş-dönüş iç bölgede küçük hata', () => {
  const n = 48000;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 48000) + 0.3 * Math.sin((2 * Math.PI * 12345 * i) / 48000);
  const y = resample(x, 48000, 44100);
  assert.equal(y.length, 44100);
  let e = 0;
  for (let i = 2000; i < y.length - 2000; i++) {
    const ref = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 44100) + 0.3 * Math.sin((2 * Math.PI * 12345 * i) / 44100);
    e = Math.max(e, Math.abs(y[i] - ref));
  }
  assert.ok(e < 2e-3, `44.1 kHz hata ${e}`);
  const z = resample(y, 44100, 48000, n);
  assert.equal(z.length, n);
  assert.ok(maxAbsDiff(x, z, 2000, n - 2000) < 3e-3);
  // Nyquist üstü (30 kHz yok, 23 kHz) bastırılır
  const hf = new Float32Array(n);
  for (let i = 0; i < n; i++) hf[i] = Math.sin((2 * Math.PI * 23000 * i) / 48000);
  const hy = resample(hf, 48000, 44100);
  assert.ok(maxAbsDiff(hy, new Float32Array(hy.length), 2000, hy.length - 2000) < 1e-3);
});

test('Katalog: sabitlenmiş HF revizyonu, boyut/sha, STFT parametreleri tutarlı', () => {
  assert.ok(sepModelById(DEFAULT_SEP_MODEL));
  assert.equal(sepModelById(), sepModelById(DEFAULT_SEP_MODEL));
  assert.equal(new Set(SEP_MODELS.map((m) => m.id)).size, SEP_MODELS.length);
  for (const m of SEP_MODELS) {
    assert.match(m.url, /^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\//, m.id);
    assert.ok(m.url.includes(m.revision) && m.url.endsWith(m.file), m.id);
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.ok(m.bytes > 1e7);
    assert.equal(m.arch, 'mdx');
    assert.equal(m.sampleRate, 44100);
    assert.ok(['vocals', 'instrumental'].includes(m.stem));
    assert.ok(m.dimF <= m.nFft / 2 + 1 && m.nFft % 2 === 0);
    assert.equal(chunkSamples(m) % m.hop, 0);
    assert.ok(m.compensate > 1 && m.compensate < 1.05);
    assert.ok(m.license && m.label);
  }
});

test('joinOverlap: aynı içerik dikişsiz birleşir, uzunluk doğru', () => {
  const x = noise(10000, 5);
  const a = x.slice(0, 6000), b = x.slice(4000);
  const j = joinOverlap(a, b, 2000, 200);
  assert.equal(j.length, x.length);
  assert.ok(maxAbsDiff(j, x) < 1e-6);
});

// Sahte MDX oturumu: her TF hücresine büyüklüğüne bağlı (doğrusal olmayan) bir maske uygular. Kare yerel olduğu
// için gerçek modelden daha az bağlam ister; ama parçalama, OLA ve yeniden örnekleme yolunu uçtan uca sınar.
function fakeSession(kind = 'mask') {
  return {
    inputNames: ['input'],
    outputNames: ['output'],
    calls: 0,
    async run(feeds) {
      this.calls++;
      const t = feeds.input;
      const [B, C, F, T] = t.dims;
      const x = t.data, y = new Float32Array(x.length);
      if (kind === 'identity') y.set(x);
      else {
        const plane = F * T;
        for (let b = 0; b < B; b++) for (let c = 0; c < C; c += 2) {
          const r0 = (b * C + c) * plane, i0 = r0 + plane;
          for (let k = 0; k < plane; k++) {
            const p = x[r0 + k] ** 2 + x[i0 + k] ** 2;
            const g = p / (p + 4); // büyük bileşenler geçer, küçükler bastırılır
            y[r0 + k] = x[r0 + k] * g; y[i0 + k] = x[i0 + k] * g;
          }
        }
      }
      return { output: { data: y, dims: t.dims } };
    },
  };
}
const fakeOrt = { Tensor: class { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } } };

function signal(n, sr, seed, noiseAmp = 0.05) {
  // 50 Hz üstü tonlar (+ gürültü); UVR'nin sıfırladığı en alt 3 bin ≈ 17 Hz'in altında içerik yok. Birim model
  // testleri gürültüsüz: modelin dim_f kesimi (17.6 kHz) ve yeniden örneklemenin geçiş bandı üstünü keser.
  const r = rng(seed), L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const s = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 1310 * t + 1) * Math.sin(2 * Math.PI * 0.7 * t);
    L[i] = s + noiseAmp * r(); R[i] = 0.8 * s + noiseAmp * r();
  }
  return [L, R];
}

test('Ayırıcı: birim model + enstrümantal → çıktı = giriş · compensate (44.1 kHz ve 48 kHz)', async () => {
  const model = sepModelById('inst-hq-3');
  const sep = createSeparator({ model, ort: fakeOrt, session: fakeSession('identity') });
  for (const sr of [44100, 48000]) {
    const n = Math.round(sr * 7.3);
    const [L, R] = signal(n, sr, 1, 0);
    const r = await sep.process(L, R, sr);
    assert.equal(r.left.length, n);
    const ref = L.map((v) => v * model.compensate);
    assert.ok(snrDb(ref, r.left, 2000, n - 2000) > 50, `${sr} Hz SNR ${snrDb(ref, r.left, 2000, n - 2000)}`);
  }
});

test('Ayırıcı: vokal modelinde eşlik = karışım − compensate · vokal', async () => {
  const model = sepModelById('kim-vocal-2');
  const sep = createSeparator({ model, ort: fakeOrt, session: fakeSession('identity') });
  const [L, R] = signal(44100 * 4, 44100, 2, 0);
  const r = await sep.process(L, R, 44100);
  const ref = R.map((v) => v * (1 - model.compensate));
  assert.ok(maxAbsDiff(ref, r.right, 2000, R.length - 2000) < 1e-3);
});

test(`Ayırıcı: iki çağrı (${CONTEXT_SEC} sn bağlam + joinOverlap) tek çağrıyla neredeyse aynı`, async () => {
  const model = sepModelById(DEFAULT_SEP_MODEL);
  const sr = 48000;
  const n = Math.round(sr * 16);
  const [L, R] = signal(n, sr, 3);
  const sep = createSeparator({ model, ort: fakeOrt, session: fakeSession('mask') });
  const whole = await sep.process(L, R, sr);
  const ov = Math.round(2 * CONTEXT_SEC * sr), cut = Math.round(n * 0.45);
  const a = await sep.process(L.slice(0, cut), R.slice(0, cut), sr);
  const b = await sep.process(L.slice(cut - ov), R.slice(cut - ov), sr);
  const fade = Math.round(FADE_SEC * sr);
  const jl = joinOverlap(a.left, b.left, ov, fade), jr = joinOverlap(a.right, b.right, ov, fade);
  assert.equal(jl.length, n);
  const lo = cut - ov - sr, hi = cut + sr;
  const snr = Math.min(snrDb(whole.left, jl, lo, hi), snrDb(whole.right, jr, lo, hi));
  assert.ok(snr > 40, `birleşme SNR ${snr.toFixed(1)} dB`);
  // birleşme dışı bölgeler tamamen aynı kaynaktan
  assert.ok(snrDb(whole.left, jl, sr, cut - ov - sr) > 60);
});

test('Ayırıcı: mono giriş (right yok) ve boş giriş', async () => {
  const sep = createSeparator({ model: 'inst-hq-3', ort: fakeOrt, session: fakeSession('identity') });
  const [L] = signal(44100, 44100, 4);
  const r = await sep.process(L, null, 44100);
  assert.equal(r.left.length, L.length);
  assert.ok(maxAbsDiff(r.left, r.right) < 1e-6);
  const e = await sep.process(new Float32Array(0), new Float32Array(0), 48000);
  assert.equal(e.left.length, 0);
});

test("Ayırıcı: model 'auto' WebGPU yoksa hafif modeli indirir ve yükler", async () => {
  const fetched = [];
  const created = [];
  const ort = {
    Tensor: fakeOrt.Tensor,
    InferenceSession: { async create(bytes, so) { created.push(so); return fakeSession('identity'); } },
  };
  const sep = createSeparator({
    model: 'auto', backend: 'wasm', ort,
    fetchModel: async (url, { onProgress }) => {
      fetched.push(url);
      const m = SEP_MODELS.find((x) => x.url === url);
      onProgress({ loaded: m.bytes, total: m.bytes });
      return new ArrayBuffer(m.bytes);
    },
  });
  const r = await sep.load();
  assert.equal(r.model, 'mdxnet-lite');
  assert.equal(r.backend, 'wasm');
  assert.deepEqual(fetched, [sepModelById('mdxnet-lite').url]);
  assert.deepEqual(created[0].executionProviders, ['wasm']);
  assert.equal(sep.model.id, 'mdxnet-lite');
});

test('Sahte işçi: sözleşme (load → progress + loaded, process → result ×0.5, dispose)', () => {
  const out = [];
  const post = (m, transfer) => out.push({ m, transfer });
  handleMessage({ type: 'process', id: 1, left: new Float32Array(2), right: new Float32Array(2), sampleRate: 48000 }, post);
  assert.equal(out.pop().m.type, 'error');
  handleMessage({ type: 'load', id: 2, model: 'kim-vocal-2', backend: 'auto' }, post);
  assert.deepEqual(out.map((o) => o.m.type), ['progress', 'loaded']);
  assert.equal(out[1].m.model, 'kim-vocal-2');
  assert.equal(out[1].m.id, 2);
  out.length = 0;
  const left = Float32Array.from([1, -0.5, 0.25]), right = Float32Array.from([0.2, 0.4, 0.6]);
  handleMessage({ type: 'process', id: 3, left, right, sampleRate: 48000 }, post);
  const { m, transfer } = out.pop();
  assert.equal(m.type, 'result');
  assert.equal(m.id, 3);
  assert.deepEqual([...m.left], [...left].map((v) => v * MOCK_GAIN));
  assert.ok(Math.abs(m.right[2] - 0.3) < 1e-7);
  assert.equal(transfer.length, 2);
  assert.equal(typeof m.ms, 'number');
  handleMessage({ type: 'dispose', id: 4 }, post);
  assert.equal(out.pop().m.type, 'disposed');
});
