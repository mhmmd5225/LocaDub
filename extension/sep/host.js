// Ses ayırma ev sahibi: YouTube sayfasındaki gizli eklenti çerçevesi. İçerik betiği bir MessagePort gönderir; bu
// çerçeve ayırma işçisini (engines/sep/worker.js ya da test için engines/_mock/sep.js) eklenti kökeninde (WebGPU ile)
// başlatır ve iletileri iki yöne aktarır (PCM Float32Array'ler kopyalanmadan aktarılır).
// Port iletileri: { type:'spawn', mode:'real'|'mock' } → { type:'spawned' }; diğerleri işçi protokolüdür (load / process
// / dispose → progress / loaded / result / error), olduğu gibi aktarılır. İşçi açılamazsa { type:'error', id:null }.

const WORKERS = { real: '../engines/sep/worker.js', mock: '../engines/_mock/sep.js' };
const ALLOWED = /^https:\/\/(www\.youtube\.com|www\.youtube-nocookie\.com)$/;

let port = null;
let worker = null;

const buffers = (m) => [m?.left?.buffer, m?.right?.buffer].filter((b) => b instanceof ArrayBuffer);

function spawn(mode) {
  try { worker?.terminate(); } catch { /* yoksay */ }
  worker = null;
  const url = new URL(WORKERS[mode] || WORKERS.real, location.href);
  try {
    worker = new Worker(url, { type: 'module', name: 'locadub-sep' });
  } catch (e) {
    port.postMessage({ type: 'error', id: null, message: 'Ayırma işçisi açılamadı: ' + (e?.message || e) });
    return;
  }
  worker.onmessage = (ev) => port?.postMessage(ev.data, buffers(ev.data));
  worker.onerror = (ev) => {
    ev.preventDefault?.();
    port?.postMessage({ type: 'error', id: null, message: 'Ayırma motoru yüklenemedi' + (ev.message ? ': ' + ev.message : ` (${url.pathname.slice(1)})`) });
  };
  worker.onmessageerror = () => port?.postMessage({ type: 'error', id: null, message: 'Ayırma işçisi iletisi okunamadı' });
  port.postMessage({ type: 'spawned', mode, gpu: !!navigator.gpu });
}

function onPort(ev) {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'spawn') return spawn(m.mode);
  if (!worker) { if (m.id != null) port.postMessage({ type: 'error', id: m.id, message: 'Ayırma işçisi yok' }); return; }
  worker.postMessage(m, buffers(m));
  if (m.type === 'dispose') { setTimeout(() => { try { worker?.terminate(); } catch { /* yoksay */ } worker = null; }, 500); }
}

window.addEventListener('message', (ev) => {
  if (ev.source !== window.parent || !ALLOWED.test(ev.origin)) return;
  if (ev.data?.type !== 'locadub-sep-port' || !ev.ports?.[0]) return;
  port?.close();
  port = ev.ports[0];
  port.onmessage = onPort;
  port.postMessage({ type: 'host-ready', gpu: !!navigator.gpu });
});
