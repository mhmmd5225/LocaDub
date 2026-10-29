// Saf zamanlama mantığı: süre tahmini, hız seçimi, oynatma sırası. Zamanlar saniye (video zamanı).

export const CHARS_PER_SEC = 14; // speed=1'de Türkçe TTS için yaklaşık
export const MAX_FIT_SPEED = 1.6;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, step) => Math.round(v / step) * step;

export function estimateSpeechSec(text, speed = 1) {
  const n = String(text || '').trim().length;
  return Math.max(0.4, n / CHARS_PER_SEC / Math.max(0.1, speed));
}

// Cümlenin konuşulabileceği süre: bir sonraki cümleye kadar, en fazla bitiş + tail.
export function slotSec(sentences, i, { tail = 0.8 } = {}) {
  const s = sentences[i];
  if (!s) return 0;
  const next = sentences[i + 1];
  let slotEnd = s.end + tail;
  if (next) slotEnd = Math.min(slotEnd, Math.max(next.start, s.end));
  return Math.max(0.5, slotEnd - s.start);
}

// Sentez hızı: tahmini süre slota sığmıyorsa temel hızı (≤ max) artırır.
export function chooseSynthSpeed(text, slot, { base = 1, max = MAX_FIT_SPEED, margin = 1.05 } = {}) {
  if (base >= max) return base;
  const needed = (estimateSpeechSec(text, 1) * margin) / Math.max(0.1, slot);
  return Number(clamp(round(Math.max(base, needed), 0.05), base, max).toFixed(2));
}

// Sentez sonrası ince ayar: <audio> playbackRate (perde korunur) ile kalan sığmazlığı giderir.
// Toplam hız (synthSpeed × rate) max'ı aşmaz. overflowSec: yine de taşan süre (video zamanı, 1x).
export function fitRate(audioSec, slotRemaining, synthSpeed = 1, { max = MAX_FIT_SPEED } = {}) {
  const avail = Math.max(0.1, slotRemaining);
  const need = audioSec / avail;
  const maxExtra = Math.max(1, max / Math.max(0.1, synthSpeed));
  const rate = clamp(need, 1, maxExtra);
  return { rate: Number(rate.toFixed(3)), overflowSec: Math.max(0, audioSec / rate - avail) };
}

// start <= t olan son cümlenin indeksi (yoksa -1). sentences start'a göre sıralı olmalı.
export function indexAt(sentences, t) {
  let lo = 0, hi = sentences.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sentences[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// Ekranda gösterilecek cümle (bitişten sonra kısa süre kalır).
export function activeIndex(sentences, t, linger = 0.4) {
  const i = indexAt(sentences, t);
  return i >= 0 && t < sentences[i].end + linger ? i : -1;
}

export function maxLateFor(sentences, j) {
  return clamp(slotSec(sentences, j) * 0.6, 1.2, 4);
}

// Sıradaki çalınacak cümle: lastPlayed'den sonra, başlangıcı geçmiş ve çok gecikmemiş ilk cümle.
// → { index, late, skipped:number[] }  (index -1: şimdilik yok)
export function nextDue(sentences, t, lastPlayed) {
  const skipped = [];
  for (let j = lastPlayed + 1; j < sentences.length && sentences[j].start <= t; j++) {
    const late = t - sentences[j].start;
    if (late > maxLateFor(sentences, j)) { skipped.push(j); continue; }
    return { index: j, late, skipped };
  }
  return { index: -1, late: 0, skipped };
}

// İleri sarma sonrası: t - tolerance'tan önce başlayanlar "geçti" sayılır.
export function lastPlayedAfterSeek(sentences, t, tolerance = 0.8) {
  return indexAt(sentences, t - tolerance);
}

// [t, t+ahead] penceresindeki (henüz bitmemiş) cümle indeksleri; pred ile süzülür.
export function windowIndices(sentences, t, ahead, pred = () => true) {
  const out = [];
  let i = Math.max(0, indexAt(sentences, t));
  for (; i < sentences.length && sentences[i].start < t + ahead; i++) {
    if (sentences[i].end + 0.5 < t) continue;
    if (pred(sentences[i], i)) out.push(i);
  }
  return out;
}

// Sıradaki cümle neyi bekliyor? → null | { phase:'translate'|'synth', done, total }
// Yalnızca o cümle `soonSec` içinde başlıyorsa (ya da çalıyorsa) bildirilir; pencere sayaçları ilerlemeyi gösterir.
export function prepStatus(sentences, t, ahead, { needAudio = true, soonSec = 3 } = {}) {
  const win = windowIndices(sentences, t, ahead, (s) => s.end > t);
  if (!win.length) return null;
  const next = sentences[win[0]];
  if (next.start > t + soonSec) return null;
  const total = win.length;
  if (next.tr == null) {
    return { phase: 'translate', done: win.filter((i) => sentences[i].tr != null).length, total };
  }
  if (needAudio && next.tr && !next.audio && !next.auFailed) {
    return { phase: 'synth', done: win.filter((i) => sentences[i].audio || sentences[i].tr === '').length, total };
  }
  return null;
}

// ---- başlangıç: ilk cümleye kadar bekletme ve çeviri grubu boyu ----

/** Bekletme yalnızca sıradaki cümle bu kadar saniye içinde başlıyorsa yapılır (uzaktaki cümle için video durmaz). */
export const HOLD_HORIZON_SEC = 8;
/** Bekletmenin üst sınırı: motorlar çok yavaşsa video yine de devam eder. */
export const HOLD_MAX_MS = 25000;

/**
 * "İlk cümleye kadar beklet": video duraklatılmış kalsın mı? Altyazı daha gelmediyse evet; gelmişse ancak yakındaki
 * ilk cümle hazır değilse (çevirisi ya da — needAudio ise — sesi yoksa).
 */
export function shouldHold(sentences, t, { loaded, needAudio = true, horizon = HOLD_HORIZON_SEC } = {}) {
  if (!loaded) return true;
  const win = windowIndices(sentences, t, horizon, (s) => s.end > t);
  if (!win.length) return false;
  const next = sentences[win[0]];
  if (next.tr == null) return true;
  if (next.tr === '') return false;
  return !!(needAudio && !next.audio && !next.auFailed);
}

/**
 * Çeviri grubu boyu: ilk grup ve oynatma konumuna yakın cümleler küçük gruplarla (ilk ses çabuk gelsin), uzaktakiler
 * büyük gruplarla (toplu çeviri cümle başına daha ucuz). `next` sıradaki çevrilmemiş cümle.
 */
export function trBatchSize(next, t, { first = false, urgentSec = 10, small = 3, large = 8 } = {}) {
  if (first) return 2;
  return next && next.start < t + urgentSec ? small : large;
}
