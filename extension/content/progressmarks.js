// Oynatıcı çubuğunda dublaj işaretleri: hangi bölümlerin dublajı yapıldı (yeşil), hangileri çevrildi ama henüz seslendirilmedi (soluk).
// İleri geri sararken kullanıcı dublajlı bölümleri görür. Saf hesap (dubRanges) Node testleriyle sınanır; ProgressMarks YouTube'un
// ilerleme çubuğuna (.ytp-progress-bar) ince bir şerit ekler (pointer-events yok, YouTube denetimleriyle birlikte gizlenir).

const GAP_SEC = 1.5; // bu kadar boşluk içindeki bitişik cümleler tek aralık sayılır

/** Sıralı [a, b] aralıklarını gap içindeki boşlukları birleştirerek döndürür. */
export function mergeSpans(spans, gap = GAP_SEC) {
  const s = spans.filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Cümlelerden iki aralık listesi: dubbed — sesi üretilmiş (bir kez bile) ya da şu an hazır; translated — çevrilmiş, sesi yok.
 * Sesi üretilemeyen (auFailed) cümle işaretlenmez.
 */
export function dubRanges(sentences, gap = GAP_SEC) {
  const dubbed = [];
  const translated = [];
  for (const s of sentences) {
    if (!(s.end > s.start)) continue;
    if (s.auFailed) continue;
    if (s.dubbed || s.audio) dubbed.push([s.start, s.end]);
    else if (s.tr) translated.push([s.start, s.end]);
  }
  return { dubbed: mergeSpans(dubbed, gap), translated: mergeSpans(translated, gap) };
}

/** Aralıkları video süresine göre yüzde dizisine çevirir: [[left%, width%]]. */
export function toPercent(ranges, duration) {
  if (!(duration > 0) || !Number.isFinite(duration)) return [];
  return ranges.map(([a, b]) => {
    const l = Math.max(0, Math.min(100, (a / duration) * 100));
    const r = Math.max(0, Math.min(100, (b / duration) * 100));
    return [Math.round(l * 100) / 100, Math.round((r - l) * 100) / 100];
  }).filter(([, w]) => w > 0);
}

export class ProgressMarks {
  constructor(player) {
    this.player = player;
    this.root = null;
    this.key = '';
  }

  _mount() {
    const bar = this.player?.querySelector('.ytp-progress-bar');
    if (!bar) return false;
    if (this.root && this.root.isConnected && this.root.parentNode === bar) return true;
    this.root?.remove();
    this.root = document.createElement('div');
    this.root.className = 'ld-marks';
    this.root.setAttribute('aria-hidden', 'true');
    this.dubbedEl = document.createElement('div');
    this.dubbedEl.className = 'ld-marks-dubbed';
    this.translatedEl = document.createElement('div');
    this.translatedEl.className = 'ld-marks-translated';
    this.root.append(this.translatedEl, this.dubbedEl);
    bar.appendChild(this.root);
    this.key = '';
    return true;
  }

  /** sentences + video süresi → şeridi günceller (değişmediyse DOM'a dokunmaz). */
  update(sentences, duration) {
    if (!this._mount()) return;
    const { dubbed, translated } = dubRanges(sentences);
    const d = toPercent(dubbed, duration);
    const t = toPercent(translated, duration);
    const key = JSON.stringify([d, t]);
    if (key === this.key) return;
    this.key = key;
    const fill = (el, list) => {
      el.replaceChildren(...list.map(([l, w]) => {
        const i = document.createElement('i');
        i.style.left = `${l}%`;
        i.style.width = `${w}%`;
        return i;
      }));
    };
    fill(this.dubbedEl, d);
    fill(this.translatedEl, t);
    this.root.title = '';
  }

  destroy() {
    this.root?.remove();
    this.root = null;
  }
}
