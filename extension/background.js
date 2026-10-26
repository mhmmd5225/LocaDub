// Service worker: offscreen yönetimi, mesaj yönlendirme, ilerleme yayını, chrome.tts (sistem sesi).

import { getSettings } from './common/settings.js';

const OFFSCREEN_URL = 'offscreen.html';
const FORWARD = new Set([
  'mt.translate', 'tts.synthesize', 'engine.init', 'engine.status', 'engine.list', 'jobs.cancel', 'models.clear',
  'engine.reset',
]);

// ---------- Offscreen document ----------

let creating = null;
let readyWaiters = [];

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    return ctx.length > 0;
  }
  return chrome.offscreen.hasDocument ? chrome.offscreen.hasDocument() : false;
}

function waitReady(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { readyWaiters = readyWaiters.filter((f) => f !== done); resolve(false); }, ms);
    const done = () => { clearTimeout(t); resolve(true); };
    readyWaiters.push(done);
  });
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = (async () => {
      const ready = waitReady(10000);
      try {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_URL,
          reasons: ['WORKERS'],
          justification: 'Çeviri ve seslendirme modellerini (ONNX/WASM, WebGPU) yerel olarak çalıştırmak için.',
        });
      } catch (e) {
        if (!/single offscreen|only a single|already/i.test(String(e?.message))) throw e;
      }
      await ready;
    })().finally(() => { creating = null; });
  }
  await creating;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendToOffscreen(msg) {
  const settings = await getSettings();
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    await ensureOffscreen();
    try {
      const res = await chrome.runtime.sendMessage({ ...msg, target: 'offscreen', settings });
      if (res === undefined) throw new Error('Offscreen yanıt vermedi');
      return res;
    } catch (e) {
      lastErr = e;
      if (!/Receiving end does not exist|Could not establish connection|yanıt vermedi|message port closed/i.test(String(e?.message))) break;
      await sleep(150 * (attempt + 1));
    }
  }
  return { ok: false, error: 'Motor sayfasına ulaşılamadı: ' + (lastErr?.message || lastErr), code: 'OFFSCREEN' };
}

// ---------- İlerleme yayını ----------

async function broadcastToTabs(msg) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
    for (const t of tabs) chrome.tabs.sendMessage(t.id, msg).catch(() => {});
  } catch { /* yoksay */ }
}

async function rememberProgress(p) {
  try {
    const { progress = {} } = await chrome.storage.session.get('progress');
    progress[p.engine] = { loaded: p.loaded, total: p.total, cached: !!p.cached, done: !!p.done, error: p.error || null, at: Date.now() };
    await chrome.storage.session.set({ progress });
  } catch { /* yoksay */ }
}

// ---------- Sistem sesi (chrome.tts) ----------

let systemSpeakSeq = 0;

function systemSpeak({ text, rate = 1, volume = 1, voiceName }) {
  return new Promise((resolve) => {
    const seq = ++systemSpeakSeq;
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    const opts = {
      lang: 'tr-TR',
      rate: Math.min(10, Math.max(0.1, Number(rate) || 1)),
      volume: Math.min(1, Math.max(0, Number(volume) || 1)),
      enqueue: false,
      onEvent: (ev) => {
        if (ev.type === 'end') finish({ ok: true, result: { ended: true } });
        else if (ev.type === 'interrupted' || ev.type === 'cancelled') finish({ ok: true, result: { ended: false, reason: ev.type } });
        else if (ev.type === 'error') finish({ ok: false, error: 'Sistem sesi hatası: ' + (ev.errorMessage || 'bilinmiyor') });
      },
    };
    if (voiceName) opts.voiceName = voiceName;
    chrome.tts.speak(String(text || ''), opts, () => {
      if (chrome.runtime.lastError) finish({ ok: false, error: chrome.runtime.lastError.message });
    });
    // Güvenlik: olay gelmezse 60 sn sonra kapat.
    setTimeout(() => { if (seq === systemSpeakSeq) finish({ ok: true, result: { ended: false, reason: 'timeout' } }); }, 60000);
  });
}

async function systemVoices() {
  const voices = await chrome.tts.getVoices();
  return voices
    .filter((v) => !v.lang || /^tr\b/i.test(v.lang))
    .map((v) => ({ voiceName: v.voiceName, lang: v.lang || '', remote: !!v.remote }));
}

// ---------- Mesajlar ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || msg.target === 'offscreen') return false;

  switch (msg.type) {
    case 'offscreen.ready': {
      const ws = readyWaiters; readyWaiters = [];
      ws.forEach((f) => f());
      return false;
    }
    case 'engine.progress':
      rememberProgress(msg);
      broadcastToTabs(msg);
      return false;
    case 'tts.system.speak':
      systemSpeak(msg).then(sendResponse);
      return true;
    case 'tts.system.stop':
      chrome.tts.stop();
      sendResponse({ ok: true });
      return false;
    case 'tts.system.pause':
      chrome.tts.pause();
      sendResponse({ ok: true });
      return false;
    case 'tts.system.resume':
      chrome.tts.resume();
      sendResponse({ ok: true });
      return false;
    case 'tts.system.voices':
      systemVoices().then((result) => sendResponse({ ok: true, result }), (e) => sendResponse({ ok: false, error: e.message }));
      return true;
    default:
      if (FORWARD.has(msg.type)) {
        if (msg.type === 'models.clear') chrome.storage.session.remove('progress').catch(() => {});
        sendToOffscreen(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
      }
      return false;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.remove('progress').catch(() => {});
});
