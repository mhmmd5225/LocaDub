// LocaDub oynatıcı paneli: sol üstte canlı durum hapı (dublaj, konuşan ses, konuşanın cinsiyeti) ve tıklayınca açılan
// cam panel (hazırlık adımları, kadın/erkek sesleri, karışım). Saf DOM; ayarları kendisi okur ve yazar.
//
// Görünüm modeli (content/app.js besler):
//   panel.update({ enabled, state, detail })        TR düğmesiyle aynı durum: off | preparing | active | warn | error
//   panel.update({ session: Session._panelState() | null })
//     session = { notice:{text,kind}|null, steps:{ captions, mt, tts, cache }: {status,text,pct?},
//                 speaking:{ idx, voice }|null, level: AudioNode|null, speaker:{ gender, hz }|null,
//                 hold:{ sec, maxSec, aheadSec? }|null, separation: EventTarget|null }
//   adım durumu: wait | active | done | warn | error | off
// Ses ayırma (separation): EventTarget, 'state' olayı detail = { status, backend, model, aheadSec, cachedRanges,
// progress, rtf, message }; yoksa bölüm "Kapalı" görünür.

import { getSettings, setSettings, onSettingsChanged, normalizeFavorite, genderVoice, voiceGender } from '../common/settings.js';
import { VOICES, DEFAULT_VOICE, voiceById } from '../engines/tts/voices.js';
import { STYLES, STYLE_IDS, PITCH_RANGE, PITCH_STEP, styleSpeed, normalizeTone } from '../engines/tts/styles.js';
import { decodePcmBase64ToInt16, int16ToWav } from '../common/pcm.js';
import { sendBg } from './bridge.js';
import { resumeAudio } from './player.js';

const ROOT_CLASS = 'ld-root';
const PREVIEW_TEXT = 'Merhaba! Bu ses size nasıl geldi? Videoları bu sesle Türkçe dinleyebilirsiniz.';
const SHORT = { 'antalia-mini': 'Antalia Mini', 'ahenk-cep': 'Ahenk Cep', 'ema-lightning': 'EMA Lightning', system: 'Sistem sesi' };
const GENDER = { female: { sign: '♀', label: 'Kadın' }, male: { sign: '♂', label: 'Erkek' } };
const STATE_TEXT = { off: 'Dublaj kapalı', preparing: 'Hazırlanıyor', active: 'Dublaj açık', warn: 'Dikkat', error: 'Hata' };
const STEP_ICON = { done: '✓', warn: '!', error: '✕', off: '–', wait: '', active: '' };
const SEP_TEXT = {
  off: 'Kapalı', 'loading-model': 'Model yükleniyor', buffering: 'Arabellek', playing: 'Çalışıyor',
  waiting: 'Ayırma bekleniyor', error: 'Hata',
};
const SEP_STATUS = { off: 'off', 'loading-model': 'active', buffering: 'active', playing: 'done', waiting: 'warn', error: 'error' };
const BARS = 5;
// panelin içinde kalan olaylar YouTube'a (kısayollar, tıklayınca oynat/duraklat) ulaşmaz
const ISOLATE = ['keydown', 'keyup', 'keypress', 'click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
  'wheel', 'contextmenu', 'touchstart', 'touchend'];

const reduceMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const favKey = (g) => (g === 'female' ? 'favFemale' : 'favMale');
const fmtPitch = (p) => (p > 0 ? `+${p}` : `${p}`);
let uid = 0;

/** Kısa ses adı: katalog etiketinden parantez atılır ("Antalia Mini (erkek, hızlı)" → "Antalia Mini"). */
export function voiceName(id, list = []) {
  if (!id) return '—';
  if (SHORT[id]) return SHORT[id];
  const v = list.find((x) => x.id === id) || voiceById(id);
  return v ? v.label.replace(/\s*\(.*\)\s*$/, '') : id;
}

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter((x) => x != null && x !== false));
  return el;
}

function toggle(label, onChange, extra = {}) {
  const input = h('input', { type: 'checkbox', role: 'switch', class: 'ld-switch-input', onchange: (e) => onChange(e.target.checked), ...extra });
  return { input, el: h('label', { class: 'ld-switch' }, input, h('span', { class: 'ld-switch-track', 'aria-hidden': 'true' }), label ? h('span', { class: 'ld-switch-label', text: label }) : null) };
}

const analysers = new WeakMap();
function analyserFor(node) {
  if (!node?.context) return null;
  if (analysers.has(node)) return analysers.get(node);
  let an = null;
  try {
    an = node.context.createAnalyser();
    an.fftSize = 256;
    an.smoothingTimeConstant = 0.6;
    node.connect(an); // çıkışsız analizör de işlenir (Chrome: otomatik çekilen düğüm)
  } catch { an = null; }
  analysers.set(node, an);
  return an;
}

export class Panel {
  constructor(player) {
    this.player = player;
    this.vm = { enabled: false, state: 'off', detail: '', session: null };
    this.settings = null;
    this.voices = VOICES.map((v) => ({ id: v.id, label: v.label, gender: v.gender, cached: undefined }));
    this.progress = {}; // model indirme: engine → { loaded, total, cached }
    this.sep = null;
    this._sepTarget = null;
    this._open = false;
    this._raf = 0;
    this._waveRaf = 0;
    this._preview = null;
    this.id = `ld-panel-${++uid}`;
    player.querySelectorAll(':scope > .' + ROOT_CLASS).forEach((n) => n.remove());
    this._build();
    player.appendChild(this.root);
    player.classList.add('ld-panel-on');

    this._ro = new ResizeObserver(() => this._layout());
    this._ro.observe(player);
    this._mo = new MutationObserver(() => this._layout());
    this._mo.observe(player, { attributes: true, attributeFilter: ['class'] });
    this._onDocDown = (e) => { if (this._open && !this.root.contains(e.target)) this.close(false); };
    document.addEventListener('pointerdown', this._onDocDown, true);
    this._onMsg = (msg) => { if (msg?.type === 'engine.progress') this._onProgress(msg); };
    try { chrome.runtime.onMessage.addListener(this._onMsg); } catch { /* bağlam geçersiz */ }
    // test motoru: ses ayırma durumu sayfadan taklit edilir (e2e, sözleşme sınaması)
    this._onTest = (e) => {
      if (e.source !== window || e.data?.source !== 'ld-test-sep' || !this._isMock()) return;
      this._testSep ||= new EventTarget();
      if (this._sepTarget !== this._testSep) this._bindSeparation(this._testSep);
      this._testSep.dispatchEvent(new CustomEvent('state', { detail: e.data.state }));
    };
    window.addEventListener('message', this._onTest);
    this._unsub = onSettingsChanged((s) => { this.settings = s; this._renderControls(); this._schedule(); });
    getSettings().then((s) => { this.settings = s; this._renderControls(); this._schedule(); }).catch(() => {});
    this._layout();
  }

  // ---- dış API ----

  update(patch) {
    const sep = ('session' in patch ? patch.session?.separation : this._sepTarget) || this._testSep || null;
    if (sep !== this._sepTarget) this._bindSeparation(sep);
    Object.assign(this.vm, patch);
    if (!this.vm.enabled) this.vm.session = null;
    this._schedule();
  }

  get isOpen() { return this._open; }

  open() {
    if (this._open) return;
    this._open = true;
    this.root.classList.add('ld-open');
    this.panel.hidden = false;
    this.pill.setAttribute('aria-expanded', 'true');
    this._layout();
    this._loadVoices();
    this._renderControls();
    this._schedule();
    requestAnimationFrame(() => this.panel.querySelector('.ld-close')?.focus({ preventScroll: true }));
  }

  close(focusPill = true) {
    if (!this._open) return;
    this._open = false;
    this.root.classList.remove('ld-open');
    this.panel.hidden = true;
    this.pill.setAttribute('aria-expanded', 'false');
    if (focusPill) this.pill.focus({ preventScroll: true });
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    cancelAnimationFrame(this._waveRaf);
    this._bindSeparation(null);
    this._ro.disconnect();
    this._mo.disconnect();
    this._unsub?.();
    document.removeEventListener('pointerdown', this._onDocDown, true);
    window.removeEventListener('message', this._onTest);
    try { chrome.runtime.onMessage.removeListener(this._onMsg); } catch { /* yoksay */ }
    this._stopPreview();
    this.player.classList.remove('ld-panel-on');
    this.root.remove();
  }

  // ---- yapı ----

  _build() {
    const isolate = (el) => { for (const ev of ISOLATE) el.addEventListener(ev, (e) => e.stopPropagation()); };
    this.root = h('div', { class: `${ROOT_CLASS} ld-theme` });
    isolate(this.root);

    // hap
    this.pillLabel = h('span', { class: 'ld-pill-label' });
    this.pillSpin = h('span', { class: 'ld-spin', 'aria-hidden': 'true' });
    this.waveBars = Array.from({ length: BARS }, () => h('i'));
    this.nowName = h('span', { class: 'ld-now-name' });
    this.now = h('span', { class: 'ld-now', hidden: true }, h('span', { class: 'ld-wave', 'aria-hidden': 'true' }, this.waveBars), this.nowName);
    this.speakerChip = h('span', { class: 'ld-speaker', hidden: true });
    this.pillBar = h('span', { class: 'ld-pill-bar', hidden: true }, h('span'));
    this.pill = h('button', {
      type: 'button', class: 'ld-pill ld-glass', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': this.id,
      onclick: () => (this._open ? this.close() : this.open()),
    }, h('span', { class: 'ld-logo', 'aria-hidden': 'true', text: 'TR' }), this.pillSpin, this.pillLabel, this.now, this.speakerChip, this.pillBar);
    this.live = h('span', { class: 'ld-sr', 'aria-live': 'polite' });

    // panel
    this.mainSwitch = toggle('', (on) => { resumeAudio(); setSettings({ enabled: on }); }, { 'aria-label': 'Türkçe dublaj' });
    this.headState = h('span', { class: 'ld-head-state' });
    const head = h('div', { class: 'ld-head' },
      h('span', { class: 'ld-logo ld-logo-l', 'aria-hidden': 'true', text: 'TR' }),
      h('div', { class: 'ld-head-text' }, h('strong', { text: 'LocaDub' }), this.headState),
      this.mainSwitch.el,
      h('button', { type: 'button', class: 'ld-icon-btn ld-close', 'aria-label': 'Paneli kapat', title: 'Kapat (Esc)', text: '✕', onclick: () => this.close() }));
    this.notice = h('div', { class: 'ld-notice', role: 'status', hidden: true });

    this.nowCard = h('div', { class: 'ld-nowcard', hidden: true });

    // a. durum
    this.stepEls = {};
    const stepDefs = [['captions', 'Altyazılar'], ['mt', 'Çeviri motoru'], ['tts', 'Ses motoru'], ['sep', 'Ses ayırma'], ['cache', 'Önbellek']];
    const steps = h('ol', { class: 'ld-steps' }, stepDefs.map(([k, label]) => {
      const icon = h('span', { class: 'ld-step-icon', 'aria-hidden': 'true' });
      const meta = h('span', { class: 'ld-step-meta' });
      const bar = h('span', { class: 'ld-bar', hidden: true }, h('span'));
      const li = h('li', { class: 'ld-step', 'data-step': k, 'data-status': 'wait' }, icon,
        h('span', { class: 'ld-step-body' }, h('span', { class: 'ld-step-row' }, h('span', { class: 'ld-step-label', text: label }), meta), bar));
      this.stepEls[k] = { li, icon, meta, bar };
      return li;
    }));
    this.holdEl = h('div', { class: 'ld-hold', hidden: true }, h('span', { class: 'ld-hold-text' }), h('span', { class: 'ld-bar' }, h('span')));

    // b. sesler
    this.genderSwitch = toggle('Otomatik kadın/erkek', (on) => setSettings({ genderVoices: on }));
    this.rows = { female: this._voiceRow('female'), male: this._voiceRow('male'), main: this._voiceRow('main') };
    const voices = h('div', { class: 'ld-voices' }, this.rows.female.el, this.rows.male.el, this.rows.main.el);

    // c. karışım
    this.mix = {
      ttsVolume: this._range('Dublaj sesi', 'ttsVolume', 0, 2, 0.05, (v) => `%${Math.round(v * 100)}`),
      originalVolume: this._range('Orijinal ses', 'originalVolume', 0, 1, 0.05, (v) => `%${Math.round(v * 100)}`,
        'Türkçe konuşma sırasında videonun kendi sesi'),
    };
    this.sepSwitch = toggle('Gerçek dublaj (ses ayırma)', (on) => setSettings({ separation: on ? 'auto' : 'off' }));
    this.sepSwitch.el.title = 'Orijinal sesten konuşma ayrılır, yalnızca müzik ve efektler kalır';
    this.subSwitch = toggle('Türkçe altyazı', (on) => setSettings({ showSubtitles: on }));

    const section = (title, ...kids) => h('section', { class: 'ld-sec' }, h('h3', { class: 'ld-sec-title', text: title }), ...kids);
    this.body = h('div', { class: 'ld-body' },
      this.nowCard,
      section('Durum', steps, this.holdEl),
      section('Sesler', this.genderSwitch.el, voices),
      section('Karışım', this.mix.ttsVolume.el, this.mix.originalVolume.el, this.sepSwitch.el, this.subSwitch.el));
    const foot = h('div', { class: 'ld-foot' },
      h('button', { type: 'button', class: 'ld-link', text: 'Tüm ayarlar →', onclick: () => sendBg({ type: 'options.open' }) }));

    this.panel = h('div', {
      id: this.id, class: 'ld-panel ld-glass', role: 'dialog', 'aria-label': 'LocaDub dublaj paneli', hidden: true, tabindex: '-1',
      onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); this.close(); } },
    }, head, this.notice, this.body, foot);
    this.root.append(this.pill, this.panel, this.live);
  }

  _voiceRow(kind) {
    const isMain = kind === 'main';
    const title = isMain ? 'Ses' : GENDER[kind].label;
    const select = h('select', { class: 'ld-select', 'aria-label': `${title} sesi`, onchange: (e) => this._pickVoice(kind, e.target.value) });
    const play = h('button', { type: 'button', class: 'ld-icon-btn ld-play', 'aria-label': `${title} sesini dinle`, title: 'Dinle', text: '▶', onclick: () => this._previewRow(kind, play) });
    const name = `ld-style-${this.id}-${kind}`;
    const radios = STYLE_IDS.map((id) => {
      const input = h('input', { type: 'radio', name, value: id, onchange: (e) => { if (e.target.checked) this._setTone(kind, { style: id }); } });
      return { id, input, el: h('label', { class: 'ld-seg-opt' }, input, h('span', { text: STYLES[id].label })) };
    });
    const seg = h('div', { class: 'ld-seg', role: 'radiogroup', 'aria-label': `${title} üslubu` }, radios.map((r) => r.el));
    const pitchVal = h('output', { class: 'ld-val' });
    const pitch = h('input', {
      type: 'range', class: 'ld-range', min: String(PITCH_RANGE[0]), max: String(PITCH_RANGE[1]), step: String(PITCH_STEP),
      'aria-label': `${title} perdesi (yarım ton)`,
      oninput: (e) => { pitchVal.textContent = fmtPitch(Number(e.target.value)); },
      onchange: (e) => this._setTone(kind, { pitch: Number(e.target.value) }),
    });
    const note = h('div', { class: 'ld-row-note', hidden: true });
    const sign = isMain ? h('span', { class: 'ld-gsign', 'aria-hidden': 'true', text: '♪' }) : h('span', { class: 'ld-gsign', 'aria-hidden': 'true', text: GENDER[kind].sign });
    const el = h('div', { class: 'ld-vrow', 'data-kind': kind },
      h('div', { class: 'ld-vrow-top' }, sign, h('span', { class: 'ld-vrow-title', text: title }), select, play),
      h('div', { class: 'ld-vrow-tone' }, seg, h('label', { class: 'ld-pitch', title: 'Perde (yarım ton)' }, h('span', { class: 'ld-pitch-l', text: 'Perde' }), pitch, pitchVal)),
      note);
    return { el, select, play, radios, pitch, pitchVal, note };
  }

  _range(label, key, min, max, step, fmt, tip) {
    const val = h('output', { class: 'ld-val' });
    const input = h('input', {
      type: 'range', class: 'ld-range', min: String(min), max: String(max), step: String(step), 'aria-label': label,
      oninput: (e) => { val.textContent = fmt(Number(e.target.value)); },
      onchange: (e) => setSettings({ [key]: Number(e.target.value) }),
    });
    return { input, val, fmt, el: h('label', { class: 'ld-mixrow', title: tip }, h('span', { class: 'ld-mix-l', text: label }), input, val) };
  }

  // ---- ses listesi ----

  async _loadVoices() {
    if (this._voicesAt && Date.now() - this._voicesAt < 15000) return;
    this._voicesAt = Date.now();
    const res = await sendBg({ type: 'engine.list' });
    if (!res?.ok || !Array.isArray(res.result?.voices)) return;
    this.mock = res.result.mode === 'mock';
    this.voices = res.result.voices.map((v) => ({ id: v.id, label: v.label, gender: v.gender, cached: v.cached, system: v.system }));
    this._renderControls();
  }

  _isMock() { return this.settings?.engineMode === 'mock'; }

  // Bir cinsiyetin seçilebilecek sesleri: katalogdaki o cinsiyetin sesleri (test motorunda cinsiyetsiz sesler de).
  _voicesFor(kind) {
    const list = this.voices.filter((v) => (this._isMock() ? true : !v.id.startsWith('mock-')));
    if (kind === 'main') return list;
    return list.filter((v) => !v.system && v.id !== 'system' && (v.gender === kind || (this._isMock() && v.gender !== 'female' && v.gender !== 'male')));
  }

  // Satırın o anki sesi ve tonu.
  _rowState(kind) {
    const s = this.settings;
    if (kind === 'main') {
      const voice = s.voice || (this._isMock() ? null : DEFAULT_VOICE);
      const fav = [s.favFemale, s.favMale].find((f) => f && f.voice === voice);
      return { voice, fav: null, auto: null, style: (fav || s).style, pitch: (fav || s).pitch, system: voice === 'system' };
    }
    const fav = s[favKey(kind)];
    const auto = genderVoice({ ...s, [favKey(kind)]: null }, kind) || null;
    const voice = fav?.voice || auto;
    return { voice, fav, auto, style: (fav || s).style, pitch: (fav || s).pitch };
  }

  _pickVoice(kind, id) {
    if (kind === 'main') { setSettings({ voice: id || null, systemVoiceName: null }); return; }
    const cur = this._rowState(kind);
    const fav = id ? normalizeFavorite({ voice: id, style: cur.style, pitch: cur.pitch }, kind) : null;
    if (id && !fav) return;
    setSettings({ [favKey(kind)]: fav });
  }

  // Üslup / perde: cinsiyet satırında favoriye yazılır (favori yoksa o anki sesle favori olur); ana satırda genel
  // ayara ve ses favoriyse favoriye de (ayarlar sayfasındaki gibi).
  _setTone(kind, patch) {
    const s = this.settings;
    const cur = this._rowState(kind);
    if (kind === 'main') {
      const out = { ...patch };
      for (const g of ['female', 'male']) {
        const f = s[favKey(g)];
        if (f && f.voice === cur.voice) out[favKey(g)] = { ...f, ...patch };
      }
      setSettings(out);
      return;
    }
    if (!cur.voice) { setSettings(patch); return; }
    const fav = normalizeFavorite({ voice: cur.voice, style: cur.style, pitch: cur.pitch, ...patch }, kind);
    if (fav) setSettings({ [favKey(kind)]: fav });
  }

  async _previewRow(kind, btn) {
    const s = this.settings;
    if (!s) return;
    if (this._preview?.btn === btn) { this._stopPreview(); return; }
    this._stopPreview();
    const cur = this._rowState(kind);
    const voice = cur.voice || (this._isMock() ? 'mock-beep' : DEFAULT_VOICE);
    btn.classList.add('ld-busy');
    btn.setAttribute('aria-busy', 'true');
    const token = {};
    this._previewToken = token;
    try {
      if (voice === 'system') {
        await sendBg({ type: 'tts.system.speak', text: PREVIEW_TEXT, rate: s.ttsSpeed, volume: Math.min(1, s.ttsVolume), voiceName: s.systemVoiceName || undefined });
        return;
      }
      const tone = normalizeTone({ style: cur.style, pitch: cur.pitch, quality: s.quality, blend: s.voiceBlend });
      const res = await sendBg({ type: 'tts.synthesize', text: PREVIEW_TEXT, voice, speed: s.ttsSpeed * styleSpeed(tone.style), tone, tag: 'panel-preview' });
      if (this._previewToken !== token) return;
      if (!res.ok || !res.result?.pcmBase64) throw new Error(res.error || 'Seslendirilemedi');
      const { pcmBase64, sampleRate } = res.result;
      const url = URL.createObjectURL(new Blob([int16ToWav(decodePcmBase64ToInt16(pcmBase64), sampleRate || 22050)], { type: 'audio/wav' }));
      const audio = new Audio(url);
      audio.volume = Math.min(1, s.ttsVolume);
      this._preview = { audio, url, btn };
      btn.textContent = '■';
      btn.setAttribute('aria-label', 'Örneği durdur');
      audio.onended = () => this._stopPreview();
      await audio.play();
    } catch (e) {
      this._say(`Örnek çalınamadı: ${e.message || e}`);
      this._stopPreview();
    } finally {
      btn.classList.remove('ld-busy');
      btn.removeAttribute('aria-busy');
    }
  }

  _stopPreview() {
    const p = this._preview;
    this._preview = null;
    if (!p) return;
    p.audio.pause();
    URL.revokeObjectURL(p.url);
    p.btn.textContent = '▶';
    p.btn.setAttribute('aria-label', 'Sesi dinle');
  }

  _say(text) { this.live.textContent = text; }

  // ---- ayar denetimleri ----

  _renderControls() {
    const s = this.settings;
    if (!s) return;
    this.mainSwitch.input.checked = s.enabled;
    const sys = s.voice === 'system';
    this.genderSwitch.input.checked = s.genderVoices && !sys;
    this.genderSwitch.input.disabled = sys;
    const auto = s.genderVoices && !sys;
    this.rows.female.el.hidden = !auto;
    this.rows.male.el.hidden = !auto;
    this.rows.main.el.hidden = auto;
    for (const kind of auto ? ['female', 'male'] : ['main']) this._renderRow(kind);
    for (const [k, r] of Object.entries(this.mix)) {
      if (document.activeElement === r.input) continue;
      r.input.value = String(s[k]);
      r.val.textContent = r.fmt(s[k]);
    }
    this.sepSwitch.input.checked = s.separation !== 'off';
    this.subSwitch.input.checked = s.showSubtitles;
  }

  _renderRow(kind) {
    const r = this.rows[kind];
    const cur = this._rowState(kind);
    const mock = this._isMock();
    const opt = (v) => h('option', {
      value: v.id,
      text: voiceName(v.id, this.voices) + (!mock && v.cached === false && v.id !== 'system' ? ' · indirilmedi' : ''),
    });
    const opts = [];
    if (kind !== 'main') opts.push(h('option', { value: '', text: cur.auto ? `Otomatik · ${voiceName(cur.auto, this.voices)}` : 'Otomatik' }));
    const list = this._voicesFor(kind);
    for (const v of list) opts.push(opt(v));
    if (cur.voice && !list.some((v) => v.id === cur.voice) && (kind === 'main' || cur.fav)) opts.push(opt({ id: cur.voice }));
    if (kind === 'main' && !cur.voice) opts.unshift(h('option', { value: '', text: 'Varsayılan' }));
    const want = kind === 'main' ? (cur.voice || '') : (cur.fav?.voice || '');
    const sig = opts.map((o) => `${o.value}=${o.textContent}`).join('|') + `#${want}`;
    if (r.select.dataset.sig !== sig && document.activeElement !== r.select) {
      r.select.replaceChildren(...opts);
      r.select.value = want;
      r.select.dataset.sig = sig;
    }
    r.select.dataset.voice = cur.voice || '';
    const def = this.voices.find((v) => v.id === cur.voice);
    const noTone = !cur.voice && kind !== 'main' ? 'Önce bir ses seçin' : cur.system ? 'Sistem sesinde üslup ve perde yok' : '';
    for (const x of r.radios) { x.input.checked = x.id === cur.style; x.input.disabled = !!cur.system; }
    if (document.activeElement !== r.pitch) {
      r.pitch.value = String(cur.pitch);
      r.pitchVal.textContent = fmtPitch(cur.pitch);
    }
    r.pitch.disabled = !!cur.system;
    const missing = !mock && def && def.cached === false && cur.voice !== 'system';
    r.play.disabled = missing || (!cur.voice && kind !== 'main' && !mock);
    r.play.title = missing ? 'Bu ses indirilmedi (Tüm ayarlar → İndirme)' : 'Dinle';
    const text = missing ? 'Bu ses henüz indirilmedi.' : (cur.system ? noTone : '');
    r.note.hidden = !text;
    r.note.textContent = text;
  }

  // ---- ses ayırma ----

  _bindSeparation(target) {
    if (this._sepTarget && this._sepFn) {
      try { this._sepTarget.removeEventListener('state', this._sepFn); } catch { /* yoksay */ }
    }
    this._sepTarget = target;
    this.sep = null;
    if (!target || typeof target.addEventListener !== 'function') { this._sepTarget = null; return; }
    this._sepFn = (e) => { this.sep = e?.detail || null; this._schedule(); };
    target.addEventListener('state', this._sepFn);
    const st = target.state ?? target.last ?? null;
    if (st && typeof st === 'object') this.sep = st;
  }

  // ---- model indirme ----

  _onProgress(p) {
    if (p.engine !== 'mt' && p.engine !== 'tts') return;
    if (p.done || p.error) delete this.progress[p.engine];
    else this.progress[p.engine] = { loaded: p.loaded || 0, total: p.total || 0, cached: !!p.cached };
    this._schedule();
  }

  // ---- çizim ----

  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); });
  }

  _render() {
    const { enabled, state, detail } = this.vm;
    const S = this.vm.session;
    const st = enabled ? state || 'preparing' : 'off';
    this.root.dataset.state = st;
    this.pill.dataset.state = st;
    // bekletmede ayırmanın ileri süresi: oturumdan, yoksa son ayırma olayından
    const hold = S?.hold ? { ...S.hold, aheadSec: S.hold.aheadSec ?? (Number.isFinite(this.sep?.aheadSec) ? this.sep.aheadSec : null) } : null;
    const notice = S?.notice?.text ? S.notice : null;
    const urgent = st === 'preparing' || st === 'warn' || st === 'error' || !!hold;
    this.root.classList.toggle('ld-sticky', urgent);

    // konuşan ses
    const sp = S?.speaking?.voice ? S.speaking : null;
    const vg = sp ? (sp.voice === 'system' ? null : voiceGender(this.settings || {}, sp.voice)) : null;
    const name = sp ? voiceName(sp.voice, this.voices) : '';
    this.now.hidden = !sp;
    this.now.dataset.voice = sp?.voice || '';
    this.now.dataset.idx = sp ? String(sp.idx) : '';
    this.now.dataset.gender = vg || '';
    this.nowName.textContent = name;
    this.pill.classList.toggle('ld-speaking', !!sp);
    this._wave(sp ? S.level : null, !!sp);

    // konuşanın cinsiyeti (ölçülen)
    const spk = S?.speaker?.gender && GENDER[S.speaker.gender] ? S.speaker : null;
    this.speakerChip.hidden = !spk || !this.settings?.genderVoices;
    if (spk) {
      this.speakerChip.textContent = GENDER[spk.gender].sign;
      this.speakerChip.dataset.gender = spk.gender;
      const tip = `Konuşan: ${GENDER[spk.gender].label.toLocaleLowerCase('tr')}${spk.hz ? ` (${spk.hz} Hz)` : ''}`;
      this.speakerChip.title = tip;
      this.speakerChip.setAttribute('aria-label', tip);
    }

    // hap metni
    let label = STATE_TEXT[st];
    if (hold) label = `Bekletiliyor · ${Math.ceil(hold.sec)} sn`;
    else if (st === 'preparing' && detail) label = `Hazırlanıyor · ${detail}`;
    else if ((st === 'warn' || st === 'error') && detail) label = detail;
    this.pillLabel.textContent = label;
    this.pillLabel.hidden = !!sp;
    this.pillSpin.hidden = st !== 'preparing';
    const pTitle = sp ? `Şu an konuşan: ${name}${vg ? ` (${GENDER[vg].label.toLocaleLowerCase('tr')})` : ''}` : label;
    this.pill.title = `${pTitle} — panel için tıklayın`;
    this.pill.setAttribute('aria-label', `LocaDub: ${pTitle}. Paneli ${this._open ? 'kapat' : 'aç'}`);
    const holdPct = hold ? this._holdPct(hold) : 0;
    this.pillBar.hidden = !hold;
    this.pillBar.firstChild.style.width = `${Math.round(holdPct * 100)}%`;

    if (!this._open) return;
    this.headState.textContent = sp ? `Konuşuyor · ${name}` : (enabled ? STATE_TEXT[st] + (detail && st !== 'active' ? ` · ${detail}` : '') : STATE_TEXT.off);
    this.notice.hidden = !notice;
    if (notice) { this.notice.textContent = notice.text; this.notice.dataset.kind = notice.kind || 'info'; }
    this._renderNowCard(sp, name, vg, spk);
    this._renderSteps(S);
    this.holdEl.hidden = !hold;
    if (hold) {
      const ahead = hold.aheadSec != null ? ` · ${Math.floor(hold.aheadSec)}/${this.settings?.prebufferSec ?? 20} sn hazır` : '';
      this.holdEl.firstChild.textContent = `Video bekletiliyor: ${Math.ceil(hold.sec)} sn (en çok ${Math.round(hold.maxSec)} sn)${ahead}`;
      this.holdEl.lastChild.firstChild.style.width = `${Math.round(holdPct * 100)}%`;
    }
  }

  _holdPct(hold) {
    if (hold.aheadSec != null) return Math.min(1, hold.aheadSec / (this.settings?.prebufferSec || 20));
    return Math.min(1, hold.sec / (hold.maxSec || 25));
  }

  _renderNowCard(sp, name, vg, spk) {
    const c = this.nowCard;
    c.hidden = !this.vm.enabled;
    if (c.hidden) return;
    const sig = `${sp?.voice || ''}|${vg}|${spk?.gender || ''}|${spk?.hz || ''}`;
    if (c.dataset.sig === sig) return;
    c.dataset.sig = sig;
    const gtxt = vg ? GENDER[vg].label : '';
    c.dataset.gender = vg || '';
    c.replaceChildren(...[
      h('span', { class: 'ld-nowcard-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'ld-nowcard-text' },
        h('span', { class: 'ld-nowcard-k', text: sp ? 'Şu an konuşan' : 'Sessiz' }),
        h('span', { class: 'ld-nowcard-v', text: sp ? `${name}${gtxt ? ` · ${gtxt}` : ''}` : 'Sıradaki cümle bekleniyor' })),
      spk ? h('span', { class: 'ld-nowcard-spk', 'data-gender': spk.gender, title: 'Videodan ölçülen konuşan' },
        `${GENDER[spk.gender].sign} ${spk.hz ? `${spk.hz} Hz` : GENDER[spk.gender].label}`) : null,
    ].filter(Boolean));
  }

  _renderSteps(S) {
    const steps = S?.steps || {};
    const pct = (p) => (p && p.total ? p.loaded / p.total : null);
    const set = (k, { status = 'wait', text = '', bar = null } = {}) => {
      const e = this.stepEls[k];
      e.li.dataset.status = status;
      e.icon.textContent = STEP_ICON[status] ?? '';
      e.meta.textContent = text;
      e.bar.hidden = bar == null;
      if (bar != null) e.bar.firstChild.style.width = `${Math.round(Math.min(1, Math.max(0, bar)) * 100)}%`;
    };
    if (!this.vm.enabled) {
      for (const k of Object.keys(this.stepEls)) set(k, { status: 'off', text: 'Kapalı' });
      return;
    }
    set('captions', steps.captions || { status: 'active', text: 'alınıyor…' });
    for (const k of ['mt', 'tts']) {
      const base = steps[k] || { status: 'active', text: 'yükleniyor…' };
      const p = this.progress[k];
      const f = base.status !== 'done' ? pct(p) : null;
      set(k, f != null && !p.cached ? { status: 'active', text: `indiriliyor %${Math.floor(f * 100)}`, bar: f } : base);
    }
    set('sep', this._sepStep());
    const c = steps.cache || { status: 'wait', text: '—' };
    set('cache', { ...c, bar: c.pct ?? null });
  }

  _sepStep() {
    const d = this.sep;
    if (this.settings?.separation === 'off') return { status: 'off', text: 'Kapalı' };
    if (!this._sepTarget || !d || !d.status) return { status: 'off', text: 'Kapalı' };
    const status = SEP_STATUS[d.status] || 'wait';
    const be = d.backend ? (/gpu/i.test(d.backend) ? 'WebGPU' : /wasm/i.test(d.backend) ? 'WASM' : String(d.backend)) : '';
    const ahead = Number.isFinite(d.aheadSec) ? `${Math.floor(d.aheadSec)} sn ileri` : '';
    let text = SEP_TEXT[d.status] || d.status;
    let bar = null;
    if (d.status === 'loading-model') {
      const p = Number(d.progress);
      if (Number.isFinite(p)) { text += ` %${Math.floor(p * 100)}`; bar = p; }
    } else if (d.status === 'buffering') {
      if (Number.isFinite(d.aheadSec)) bar = d.aheadSec / (this.settings?.prebufferSec || 20);
    } else if (d.status === 'error' && d.message) {
      text = d.message;
    }
    text = [text, d.status !== 'error' && d.status !== 'off' ? be : '', d.status === 'playing' || d.status === 'buffering' || d.status === 'waiting' ? ahead : '']
      .filter(Boolean).join(' · ');
    return { status, text, bar };
  }

  // Dalga: dublaj sesinin analizöründen (yoksa CSS animasyonu).
  _wave(node, on) {
    const an = on && !reduceMotion() ? analyserFor(node) : null;
    this.now.classList.toggle('ld-wave-css', on && !an);
    if (!an) {
      cancelAnimationFrame(this._waveRaf);
      this._waveRaf = 0;
      this._waveNode = null;
      return;
    }
    if (this._waveNode === an && this._waveRaf) return;
    this._waveNode = an;
    const buf = new Uint8Array(an.frequencyBinCount);
    const bands = [[1, 3], [3, 6], [6, 10], [10, 16], [16, 26]];
    const frame = () => {
      if (this._waveNode !== an) return;
      an.getByteFrequencyData(buf);
      for (let b = 0; b < BARS; b++) {
        const [lo, hi] = bands[b];
        let sum = 0;
        for (let i = lo; i < hi; i++) sum += buf[i];
        const v = Math.min(1, sum / (hi - lo) / 200);
        this.waveBars[b].style.transform = `scaleY(${(0.18 + 0.82 * v).toFixed(3)})`;
      }
      this._waveRaf = requestAnimationFrame(frame);
    };
    this._waveRaf = requestAnimationFrame(frame);
  }

  // ---- yerleşim ----

  _layout() {
    const p = this.player;
    const w = p.clientWidth || 640;
    const hgt = p.clientHeight || 360;
    const compact = w < 560 || hgt < 300;
    const tiny = w < 420 || hgt < 260; // mini oynatıcı ≈ 400×225
    this.root.classList.toggle('ld-compact', compact);
    this.root.classList.toggle('ld-tiny', tiny);
    this.root.classList.toggle('ld-large', hgt >= 900);
    // tam ekranda / gömülüde YouTube başlığı sol üstte: hap başlığın altına iner
    let top = 12;
    const ct = p.querySelector('.ytp-chrome-top');
    const title = ct?.querySelector('.ytp-title');
    if (ct && title && ct.offsetHeight > 0 && title.offsetHeight > 0 && getComputedStyle(title).visibility !== 'hidden') {
      top = Math.max(top, ct.offsetTop + ct.offsetHeight + 6);
    }
    // küçük oynatıcıda panel kontrol çubuğunun üstüne de uzanır (açıkken)
    const bottom = compact ? 0 : p.querySelector('.ytp-chrome-bottom')?.offsetHeight || 48;
    const pillH = tiny ? 28 : 32;
    this.root.style.setProperty('--ld-top', `${top}px`);
    this.root.style.setProperty('--ld-panel-top', `${top + pillH + 8}px`);
    this.root.style.setProperty('--ld-panel-max-h', `${Math.max(120, hgt - top - pillH - 8 - bottom - 12)}px`);
    this.root.style.setProperty('--ld-panel-w', `${Math.min(hgt >= 900 ? 380 : 344, w - 24)}px`);
  }
}
