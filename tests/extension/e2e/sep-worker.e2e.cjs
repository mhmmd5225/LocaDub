// Ses ayırma işçisi tarayıcıda (Chromium, module Worker, cross-origin isolated):
//  1) sahte işçi (_mock/sep.js) sözleşmesi + ArrayBuffer aktarımı,
//  2) gerçek işçi (engines/sep/worker.js) gerçek modelle — model tests/extension/.models/sep altında varsa
//     (node tools/sep-bench.mjs indirir) ya da SEP_REAL=1 ise (HF'ten iner). WASM'da RTF ölçülür; varsa
//     onnxruntime-node ile aynı girdinin sonucuyla karşılaştırılır (SNR). --webgpu: SwiftShader/GPU WebGPU da denenir.
//  3) akış kipi (gerçek modelle, WASM): --stream-seconds'lık ses içerik betiğinin eski yoluyla (12 sn + 2·1 sn bağlam)
//     ve akışla (12 sn'lik ardışık çağrılar) işlenir: ses saniyesi başına pencere ve duvar saati RTF'i; akışın
//     parçalı çıktısı tek akış çağrısınınkiyle karşılaştırılır (SNR, ≥ 60 dB).
//
//   xvfb-run -a node tests/extension/e2e/sep-worker.e2e.cjs [--seconds 12] [--threads 4] [--webgpu] [--model kim-vocal-2]
//                                                         [--stream-seconds 36] (0: akış ölçümü atlanır)
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const ROOT = path.resolve(__dirname, '../../..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const SECONDS = Number(arg('--seconds', 12));
const THREADS = Number(arg('--threads', 4));
const MODEL = arg('--model', 'kim-vocal-2');
const WEBGPU = process.argv.includes('--webgpu');
const STREAM_SECONDS = Number(arg('--stream-seconds', 36));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };

function serve() {
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' };
    if (p === '/sep-test.html') {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html' });
      return res.end('<!doctype html><meta charset="utf-8"><title>sep</title>');
    }
    const file = path.join(ROOT, path.normalize(p).replace(/^([/\\])+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// Sayfada ve Node'da aynı deterministik girdi (ton + gürültü + konuşmaya benzer AM'li tonlar)
function makeInput(n, sr) {
  let s = 12345;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) - 0.5;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const music = 0.2 * Math.sin(2 * Math.PI * 110 * t) + 0.1 * Math.sin(2 * Math.PI * 440 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 2 * t));
    const env = Math.max(0, Math.sin(2 * Math.PI * 3 * t)) * (Math.floor(t / 2) % 2);
    const voice = env * (0.2 * Math.sin(2 * Math.PI * 180 * t + 3 * Math.sin(2 * Math.PI * 5 * t)) + 0.1 * Math.sin(2 * Math.PI * 360 * t));
    L[i] = music + voice + 0.02 * r();
    R[i] = 0.9 * music + voice + 0.02 * r();
  }
  return [L, R];
}

async function main() {
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const flags = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'];
  const browser = await chromium.launch({
    headless: false,
    args: WEBGPU ? flags : [],
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined,
  });
  const ctx = await browser.newContext();
  const { SEP_MODELS } = await import(path.join(ROOT, 'extension/engines/sep/models.js'));
  const model = SEP_MODELS.find((m) => m.id === MODEL);
  const local = path.join(ROOT, 'tests/extension/.models/sep', model.file);
  const haveLocal = fs.existsSync(local) && fs.statSync(local).size === model.bytes;
  // modeli yerel kopyadan ver (işçinin isteği de bağlamın rotasından geçer)
  let routed = 0;
  if (haveLocal) {
    await ctx.route(model.url, (route) => { routed++; route.fulfill({ status: 200, body: fs.readFileSync(local), headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' } }); });
  }
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[sayfa]', m.text()); });
  await page.goto(`${base}/sep-test.html`);
  assert.equal(await page.evaluate(() => self.crossOriginIsolated), true);

  // 1) sahte işçi
  const mock = await page.evaluate(async () => {
    const w = new Worker('/extension/engines/_mock/sep.js', { type: 'module' });
    const msgs = [];
    const next = (pred) => new Promise((res) => { const h = (e) => { msgs.push(e.data.type); if (pred(e.data)) { w.removeEventListener('message', h); res(e.data); } }; w.addEventListener('message', h); });
    w.postMessage({ type: 'load', id: 1, model: 'kim-vocal-2', backend: 'auto' });
    const loaded = await next((m) => m.type === 'loaded');
    const left = new Float32Array([1, 2, 3]), right = new Float32Array([4, 5, 6]);
    w.postMessage({ type: 'process', id: 2, left, right, sampleRate: 48000 }, [left.buffer, right.buffer]);
    const r = await next((m) => m.type === 'result');
    w.terminate();
    return { msgs, loaded, transferred: left.length === 0, left: [...r.left], right: [...r.right], id: r.id };
  });
  assert.deepEqual(mock.msgs, ['progress', 'loaded', 'result']);
  assert.equal(mock.transferred, true);
  assert.deepEqual(mock.left, [0.5, 1, 1.5]);
  assert.deepEqual(mock.right, [2, 2.5, 3]);
  console.log('sahte işçi: tamam');

  if (!haveLocal && process.env.SEP_REAL !== '1') {
    console.log(`gerçek model yok (${local}); atlandı (SEP_REAL=1 ile HF'ten iner)`);
    await browser.close(); srv.close();
    return;
  }

  // 2) gerçek işçi
  const sr = 48000, n = Math.round(SECONDS * sr);
  const backends = ['wasm', ...(WEBGPU ? ['webgpu'] : [])];
  const results = {};
  for (const backend of backends) {
    const r = await page.evaluate(async ({ backend, threads, model, n, sr, gen }) => {
      const makeInput = new Function(`return (${gen})`)();
      const w = new Worker('/extension/engines/sep/worker.js', { type: 'module' });
      const call = (msg, transfer = []) => new Promise((res, rej) => {
        const h = (e) => {
          if (e.data.id !== msg.id || e.data.type === 'progress') return;
          w.removeEventListener('message', h);
          e.data.type === 'error' ? rej(new Error(e.data.message)) : res(e.data);
        };
        w.addEventListener('message', h);
        w.postMessage(msg, transfer);
      });
      const gpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null)));
      let t = performance.now();
      const loaded = await call({ type: 'load', id: 1, model, backend, threads });
      const loadMs = performance.now() - t;
      const [L, R] = makeInput(n, sr);
      t = performance.now();
      const res = await call({ type: 'process', id: 2, left: L, right: R, sampleRate: sr }, [L.buffer, R.buffer]);
      const wall = performance.now() - t;
      w.terminate();
      return { gpu, loaded, loadMs, ms: res.ms, wall, backend: res.backend, left: Array.from(res.left), right: Array.from(res.right) };
    }, { backend, threads: THREADS, model: MODEL, n, sr, gen: makeInput.toString() });
    results[backend] = r;
    let finite = true;
    for (const v of r.left) if (!Number.isFinite(v)) { finite = false; break; }
    assert.ok(finite, 'çıktıda NaN/Inf');
    assert.equal(r.left.length, n);
    console.log(`gerçek işçi [${backend}${backend === 'webgpu' ? `, adapter ${r.gpu}` : ''}] → ${r.backend}: yükleme ${Math.round(r.loadMs)} ms, işlem ${r.ms} ms, RTF ${(r.ms / 1000 / SECONDS).toFixed(3)} (${SECONDS} sn stereo @ ${sr}, ${THREADS} iş parçacığı)`);
  }
  if (haveLocal) console.log(`model yerel kopyadan verildi (${routed} istek)`);

  // 3) akış ↔ eski yol (WASM)
  if (STREAM_SECONDS > 0) {
    const r = await page.evaluate(async ({ threads, model, n, sr, gen }) => {
      const makeInput = new Function(`return (${gen})`)();
      const w = new Worker('/extension/engines/sep/worker.js', { type: 'module' });
      let id = 10;
      const call = (msg, transfer = []) => new Promise((res, rej) => {
        msg.id = ++id;
        const h = (e) => {
          if (e.data.id !== msg.id || e.data.type === 'progress') return;
          w.removeEventListener('message', h);
          e.data.type === 'error' ? rej(new Error(e.data.message)) : res(e.data);
        };
        w.addEventListener('message', h);
        w.postMessage(msg, transfer);
      });
      const loaded = await call({ type: 'load', model, backend: 'wasm', threads });
      const [L, R] = makeInput(n, sr);
      const cut = (a, b) => [L.slice(a, b), R.slice(a, b)];
      const C = 12 * sr, X = sr;
      // eski yol: 12 sn çekirdek + iki yanda 1 sn bağlam, iş başına bir çağrı
      let t = performance.now(), oldWin = 0, oldMs = 0;
      for (let p = 0; p < n; p += C) {
        const [l, rr] = cut(Math.max(0, p - X), Math.min(n, p + C + X));
        const res = await call({ type: 'process', left: l, right: rr, sampleRate: sr }, [l.buffer, rr.buffer]);
        oldWin += res.windows; oldMs += res.ms;
      }
      const oldWall = performance.now() - t;
      // akış: 12 sn'lik ardışık çağrılar, sonuncusu final; iki iş art arda gönderilir (boru hattı)
      t = performance.now();
      const parts = [], pend = [];
      let newWin = 0, newMs = 0;
      for (let p = 0; p < n; p += C) {
        const [l, rr] = cut(p, Math.min(n, p + C));
        pend.push(call({ type: 'process', left: l, right: rr, sampleRate: sr, startSample: p, final: p + C >= n }, [l.buffer, rr.buffer]));
      }
      for (const q of pend) { const res = await q; parts.push(res); newWin += res.windows; newMs += res.ms; }
      const newWall = performance.now() - t;
      const [l1, r1] = cut(0, n);
      const one = await call({ type: 'process', left: l1, right: r1, sampleRate: sr, startSample: 0, final: true }, [l1.buffer, r1.buffer]);
      w.terminate();
      let s = 0, e = 0, at = 0, contiguous = true;
      for (const q of parts) {
        if (q.startSample !== at) contiguous = false;
        for (let j = 0; j < q.left.length; j++) {
          const k = q.startSample + j;
          s += one.left[k] ** 2 + one.right[k] ** 2;
          e += (q.left[j] - one.left[k]) ** 2 + (q.right[j] - one.right[k]) ** 2;
        }
        at = q.startSample + q.left.length;
      }
      return {
        model: loaded.model, step: loaded.stepSec, batch: loaded.batch, oldWin, oldMs, oldWall, newWin, newMs, newWall,
        oneWin: one.windows, oneMs: one.ms, snr: e ? 10 * Math.log10(s / e) : Infinity, contiguous, end: at, oneLen: one.left.length,
      };
    }, { threads: THREADS, model: MODEL, n: Math.round(STREAM_SECONDS * sr), sr, gen: makeInput.toString() });
    const S = STREAM_SECONDS;
    console.log(`akış [wasm, ${r.model}, adım ${r.step.toFixed(2)} sn, batch ${r.batch}], ${S} sn ses, 12 sn'lik işler:`);
    console.log(`  eski yol (12 + 2·1 sn bağlam): ${r.oldWin} pencere = ${(r.oldWin / S).toFixed(3)} pencere/sn, işlem ${(r.oldMs / 1000).toFixed(1)} sn, duvar RTF ${(r.oldWall / 1000 / S).toFixed(3)}`);
    console.log(`  akış:                          ${r.newWin} pencere = ${(r.newWin / S).toFixed(3)} pencere/sn, işlem ${(r.newMs / 1000).toFixed(1)} sn, duvar RTF ${(r.newWall / 1000 / S).toFixed(3)}`);
    console.log(`  hızlanma: pencere ${(r.oldWin / r.newWin).toFixed(2)}×, duvar ${(r.oldWall / r.newWall).toFixed(2)}×; parçalı akış ↔ tek akış çağrısı SNR ${Number.isFinite(r.snr) ? r.snr.toFixed(1) + ' dB' : '∞ (birebir aynı)'}`);
    assert.ok(r.contiguous && r.end === r.oneLen, 'akış çıktısı ardışık değil');
    assert.ok(r.snr >= 60, `akış SNR ${r.snr}`);
    assert.ok(r.newWin < r.oldWin, 'akış daha az pencere çalıştırmalı');
  }

  // onnxruntime-node ile aynı girdinin sonucu (varsa)
  let ortNode = null;
  try { ortNode = require(require.resolve('onnxruntime-node', { paths: [path.join(ROOT, 'tests/tts')] })); } catch { /* yok */ }
  if (ortNode && haveLocal) {
    const { createSeparator } = await import(path.join(ROOT, 'extension/engines/sep/separator.js'));
    const sep = createSeparator({ model, ort: ortNode, backend: 'cpu', modelData: new Uint8Array(fs.readFileSync(local)), sessionOptions: { executionProviders: ['cpu'] } });
    await sep.load();
    const [L, R] = makeInput(n, sr);
    const ref = await sep.process(L, R, sr);
    for (const [backend, r] of Object.entries(results)) {
      let s = 0, e = 0;
      for (let i = 0; i < n; i++) { s += ref.left[i] ** 2 + ref.right[i] ** 2; e += (r.left[i] - ref.left[i]) ** 2 + (r.right[i] - ref.right[i]) ** 2; }
      const snr = 10 * Math.log10(s / e);
      console.log(`${backend} ↔ onnxruntime-node: SNR ${snr.toFixed(1)} dB`);
      assert.ok(snr > 40, `${backend} sonucu Node'dakinden farklı (${snr.toFixed(1)} dB)`);
    }
    await sep.dispose();
  }
  await browser.close();
  srv.close();
  console.log('tamam');
}

main().catch((e) => { console.error(e); process.exit(1); });
