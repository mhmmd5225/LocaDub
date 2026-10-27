// Türkçe altyazı overlay'i, durum satırı ve oynatıcıdaki "TR" düğmesi.

const ROOT_ID = 'yt-tr-dub-overlay';
const BTN_CLASS = 'yt-tr-dub-btn';

export class Overlay {
  constructor(playerEl) {
    this.player = playerEl;
    document.getElementById(ROOT_ID)?.remove();
    this.root = document.createElement('div');
    this.root.id = ROOT_ID;
    this.root.className = 'yt-tr-dub-root';
    this.sub = document.createElement('div');
    this.sub.className = 'yt-tr-dub-sub';
    this.subText = document.createElement('span');
    this.sub.appendChild(this.subText);
    this.status = document.createElement('div');
    this.status.className = 'yt-tr-dub-status';
    this.bar = document.createElement('div');
    this.bar.className = 'yt-tr-dub-bar';
    this.barFill = document.createElement('div');
    this.bar.appendChild(this.barFill);
    this.statusText = document.createElement('span');
    this.status.append(this.statusText, this.bar);
    this.root.append(this.status, this.sub);
    playerEl.appendChild(this.root);
    this._text = null;
    this._statusTimer = null;
    this._progress = {};
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(playerEl);
    this._resize();
  }

  _resize() {
    // Yükseklikle ölçeklenir; dikey (Shorts) oynatıcıda genişlik sınırlar.
    const h = this.player.clientHeight || 360;
    const w = this.player.clientWidth || 640;
    this.root.style.setProperty('--yt-tr-dub-fs', `${Math.max(14, Math.min(40, h * 0.045, w * 0.055))}px`);
  }

  setText(text) {
    const t = text || '';
    if (t === this._text) return;
    this._text = t;
    this.subText.textContent = t;
    this.sub.classList.toggle('visible', !!t);
  }

  // kind: 'info' | 'warn' | 'error'; timeoutMs: otomatik gizleme
  setStatus(text, { kind = 'info', timeoutMs = 0 } = {}) {
    clearTimeout(this._statusTimer);
    this.statusText.textContent = text || '';
    this.status.dataset.kind = kind;
    this.status.classList.toggle('visible', !!text);
    if (!this._hasProgress()) this.bar.classList.remove('visible');
    if (text && timeoutMs) this._statusTimer = setTimeout(() => this.clearStatus(), timeoutMs);
  }

  clearStatus() {
    clearTimeout(this._statusTimer);
    this.status.classList.remove('visible');
    this.statusText.textContent = '';
  }

  _hasProgress() {
    return Object.values(this._progress).some((p) => p && !p.done);
  }

  // Model indirme ilerlemesi
  setProgress(p) {
    const label = p.engine === 'mt' ? 'Çeviri modeli' : 'Ses modeli';
    if (p.error) {
      delete this._progress[p.engine];
      this.setStatus(`${label}: ${p.error}`, { kind: 'error' });
      return;
    }
    if (p.done) {
      delete this._progress[p.engine];
      if (!this._hasProgress()) {
        this.bar.classList.remove('visible');
        // 'prep': dublajın sonraki aşama mesajı bunun yerine hemen geçebilir.
        this.setStatus(`${label} hazır.`, { kind: 'prep', timeoutMs: 2500 });
      }
      return;
    }
    this._progress[p.engine] = p;
    let L = 0, T = 0, cached = true;
    for (const v of Object.values(this._progress)) { L += v.loaded || 0; T += v.total || 0; cached &&= !!v.cached; }
    const pct = T ? Math.floor((L / T) * 100) : 0;
    const mb = (x) => (x / 1048576).toFixed(0);
    this.setStatus(T && !cached
      ? `Modeller indiriliyor… %${pct} (${mb(L)}/${mb(T)} MB)`
      : 'Türkçe dublaj 2/4: modeller bilgisayardan yükleniyor…');
    this.bar.classList.add('visible');
    this.barFill.style.width = `${pct}%`;
  }

  destroy() {
    clearTimeout(this._statusTimer);
    this._ro.disconnect();
    this.root.remove();
  }
}

// Düğme durumları: off | preparing | active | warn | error
const BTN_LABELS = {
  off: 'Dublaj kapalı',
  preparing: 'Hazırlanıyor',
  active: 'Dublaj aktif',
  warn: 'Dikkat',
  error: 'Hata',
};

// Oynatıcı kontrol çubuğuna "TR + durum" düğmesi ekler/günceller. Kontrol çubuğu olmayan Shorts oynatıcısında düğme
// oynatıcının köşesinde yüzer. state: yukarıdaki durumlardan biri; detail: araç ipucuna eklenen açıklama.
export function ensureToggleButton(state, onClick, detail = '', player = document.getElementById('movie_player')) {
  if (!player) return null;
  let controls;
  if (player.id === 'movie_player') {
    controls = player.querySelector('.ytp-right-controls');
  } else {
    controls = player.querySelector(':scope > .yt-tr-dub-float');
    if (!controls) {
      controls = document.createElement('div');
      controls.className = 'yt-tr-dub-float';
      player.appendChild(controls);
    }
  }
  if (!controls) return null;
  let btn = controls.querySelector('.' + BTN_CLASS);
  if (!btn) {
    btn = document.createElement('button');
    btn.className = `ytp-button ${BTN_CLASS}`;
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Türkçe dublaj');
    const pill = document.createElement('span');
    pill.className = 'yt-tr-dub-pill';
    const badge = document.createElement('span');
    badge.className = 'yt-tr-dub-badge';
    badge.textContent = 'TR';
    const spin = document.createElement('span');
    spin.className = 'yt-tr-dub-spin';
    const label = document.createElement('span');
    label.className = 'yt-tr-dub-label';
    pill.append(badge, spin, label);
    btn.appendChild(pill);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn._onClick?.();
    });
    controls.insertBefore(btn, controls.firstChild);
  }
  btn._onClick = onClick;
  const on = state !== 'off';
  if (btn.dataset.state !== state) {
    btn.dataset.state = state;
    btn.querySelector('.yt-tr-dub-label').textContent = BTN_LABELS[state] || '';
  }
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  const title = (on ? 'Türkçe dublajı kapat' : 'Türkçe dublajı aç') + (detail ? ` — ${detail}` : '');
  if (btn.title !== title) {
    btn.title = title;
    btn.dataset.tooltipTitle = title;
  }
  return btn;
}
