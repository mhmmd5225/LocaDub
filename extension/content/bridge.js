// İçerik betiği ↔ sayfa (MAIN world) köprüsü ve background mesajlaşması.

const FROM_CONTENT = 'yt-tr-dub:content';
const FROM_MAIN = 'yt-tr-dub:main';

let seq = 0;
const pending = new Map();

window.addEventListener('message', (ev) => {
  if (ev.source !== window || !ev.data || ev.data.source !== FROM_MAIN) return;
  const p = pending.get(ev.data.reqId);
  if (!p) return;
  pending.delete(ev.data.reqId);
  clearTimeout(p.timer);
  if (ev.data.error) p.reject(new Error(ev.data.error));
  else p.resolve(ev.data.result);
});

export function callMain(type, data = {}, timeoutMs = 5000) {
  const reqId = `r${Date.now().toString(36)}${(++seq).toString(36)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error('Sayfa betiği yanıt vermedi: ' + type));
    }, timeoutMs);
    pending.set(reqId, { resolve, reject, timer });
    window.postMessage({ source: FROM_CONTENT, type, reqId, ...data }, location.origin);
  });
}

// Background'a mesaj; hata durumunda { ok:false, error } döner (asla fırlatmaz).
export async function sendBg(msg) {
  try {
    const res = await chrome.runtime.sendMessage(msg);
    return res ?? { ok: false, error: 'Boş yanıt' };
  } catch (e) {
    const m = String(e?.message || e);
    if (/context invalidated/i.test(m)) {
      return { ok: false, error: 'Eklenti güncellendi; sayfayı yenileyin.', code: 'INVALIDATED' };
    }
    return { ok: false, error: m };
  }
}
