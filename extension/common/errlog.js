// Hata günlüğü: sessizce yutulan motor / ağ / ses hatalarını tanılama raporundaki "Son hatalar" bölümüne düşürür.
// Her bağlamdan (içerik betiği, ayarlar sayfası, offscreen) `diag.error` iletisiyle arka plana gider (background.js recordError);
// arka plan kendisi hata yazacaksa `setErrorSink` ile doğrudan yazıcıyı verebilir. Aynı (alan, ileti) çifti 10 sn içinde bir kez gönderilir
// (sık tekrarlayan hata sayfayı ya da depolamayı doldurmasın; sayım arka planda ardışık/yinelenen kayıtlarda tutulur).
//
// Ne zaman kullanılır: motor, ağ, ses bağlamı, port / köprü çağrıları başarısız olup işlev sessizce eksiliyorsa.
// Kullanılmaz: zararsız temizlik (revokeObjectURL, disconnect, dispose, terminate), beklenen yedek yollar ve kendi arayüz bildirimi
// olan yerler (panoya kopyalama), sayfa dünyası kancaları (content/main-world.js: sayfayı bozmamak için sessiz kalır).

const WINDOW_MS = 10000;
const MAX_KEYS = 100;
const recent = new Map(); // "alan|ileti" → son gönderim zamanı

let sink = (source, message) => {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'diag.error', source, message }).catch(() => {});
    }
  } catch { /* bağlam geçersiz ya da chrome yok (Node): hata günlüğü işlevi bozmamalı */ }
};

/** Yazıcıyı değiştirir (arka plan: doğrudan recordError; testler: dizi). */
export function setErrorSink(fn) {
  sink = typeof fn === 'function' ? fn : () => {};
}

/** Hatadan kısa, tek satırlık ileti. */
export function describeError(err) {
  const m = err?.message ?? (typeof err === 'string' ? err : '');
  const s = String(m || err || 'bilinmeyen hata').replace(/\s+/g, ' ').trim();
  return s.slice(0, 300);
}

/** Aynı anahtar pencere içinde tekrar yazılmaz; true → yazılmalı. Saf (Map ve zaman dışarıdan). */
export function shouldLog(map, key, now, windowMs = WINDOW_MS, maxKeys = MAX_KEYS) {
  const last = map.get(key);
  if (last != null && now - last < windowMs) return false;
  map.set(key, now);
  if (map.size > maxKeys) {
    for (const [k, t] of map) if (now - t >= windowMs) map.delete(k);
    while (map.size > maxKeys) map.delete(map.keys().next().value);
  }
  return true;
}

/**
 * @param {string} scope kısa alan adı ("ses yakalama", "altyazı indirme"…); raporda "alan: ileti" olarak görünür
 * @param {unknown} err hata ya da ileti
 */
export function logError(scope, err, { now = Date.now() } = {}) {
  const message = describeError(err);
  if (!shouldLog(recent, `${scope}|${message}`, now)) return false;
  sink(String(scope), message);
  return true;
}

/** Testler için. */
export function _resetErrorLog() {
  recent.clear();
}
