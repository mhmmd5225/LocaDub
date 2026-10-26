// Açılır pencere: dublajı aç/kapa, kısa durum, hızlı ses ayarları. Ayrıntılar ve modeller ayarlar sayfasında.

import { getSettings, setSettings, onSettingsChanged } from '../common/settings.js';

const $ = (id) => document.getElementById(id);
let settings = await getSettings();
let lists = null; // engine.list sonucu (model adları için)
const progress = { mt: null, tts: null };

async function bg(msg) {
  try {
    return (await chrome.runtime.sendMessage(msg)) ?? { ok: false, error: 'Boş yanıt' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function openOptions(hash = '') {
  if (!hash) { chrome.runtime.openOptionsPage(); return; }
  chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html' + hash) });
}

// ---------- Ayarlar ----------

function bindRange(id, fmt) {
  const input = $(id), out = $(id + 'Out');
  const show = () => { out.textContent = fmt(Number(input.value)); };
  input.value = settings[id];
  show();
  input.addEventListener('input', show);
  input.addEventListener('change', () => setSettings({ [id]: Number(input.value) }));
}
bindRange('ttsVolume', (v) => `%${Math.round(v * 100)}`);
bindRange('originalVolume', (v) => `%${Math.round(v * 100)}`);

$('enabled').addEventListener('change', (e) => setSettings({ enabled: e.target.checked }));
$('openOptions').addEventListener('click', () => openOptions());

// ---------- Seslendirme seçimi ----------
// İndirilmiş sesler ve Türkçe sistem sesleri seçilebilir; indirilmemiş olanlar ayarlar sayfasına yönlendirir
// (sormadan indirme başlamasın).

let systemVoices = [];
const MORE = '__more__';

function option(value, label, { selected = false, disabled = false } = {}) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  o.selected = selected;
  o.disabled = disabled;
  return o;
}

function renderVoices() {
  const sel = $('voice');
  sel.replaceChildren();
  const voices = (lists?.voices || []).filter((v) => !v.system);
  const current = settings.voice || voices.find((v) => v.default)?.id || null;
  const gender = (v) => (v.gender === 'female' ? 'kadın' : v.gender === 'male' ? 'erkek' : '');
  const name = (v) => String(v.label).replace(/\s*\(.*\)\s*$/, '');

  const ready = voices.filter((v) => v.cached || settings.engineMode === 'mock');
  const missing = voices.filter((v) => !ready.includes(v));
  if (ready.length) {
    const g = document.createElement('optgroup');
    g.label = 'İndirilmiş sesler';
    for (const v of ready) g.append(option(v.id, `${name(v)}${gender(v) ? ` · ${gender(v)}` : ''}`, { selected: current === v.id }));
    sel.append(g);
  }
  const sys = document.createElement('optgroup');
  sys.label = 'Sistem sesleri (indirme yok)';
  if (systemVoices.length) {
    for (const sv of systemVoices) {
      sys.append(option('system:' + sv, sv.replace(/^Microsoft\s+/, '').replace(/\s*-\s*Turkish.*$/i, ''),
        { selected: settings.voice === 'system' && settings.systemVoiceName === sv }));
    }
  } else {
    sys.append(option('system:', 'Türkçe sistem sesi', { selected: settings.voice === 'system' }));
  }
  sel.append(sys);
  if (missing.length) {
    const g = document.createElement('optgroup');
    g.label = 'İndirilmemiş';
    for (const v of missing) g.append(option(MORE + v.id, `${name(v)} — ${Math.round(v.sizeMB)} MB, ayarlardan indir`));
    sel.append(g);
  }
  // Seçili ses indirilmemişse (ör. silindi) listede yine görünsün.
  if (current && current !== 'system' && !ready.some((v) => v.id === current)) {
    const v = voices.find((x) => x.id === current);
    if (v) sel.prepend(option(v.id, `${name(v)} (indirilmedi)`, { selected: true }));
  }
}

$('voice').addEventListener('change', (e) => {
  const v = e.target.value;
  if (v.startsWith(MORE)) {
    renderVoices(); // seçimi geri al
    openOptions('#modeller');
  } else if (v.startsWith('system:')) {
    setSettings({ voice: 'system', systemVoiceName: v.slice(7) || null });
  } else {
    setSettings({ voice: v, systemVoiceName: null });
  }
});

async function loadSystemVoices() {
  try {
    const all = await chrome.tts.getVoices();
    systemVoices = all.filter((v) => v.lang && /^tr\b/i.test(v.lang)).map((v) => v.voiceName);
  } catch {
    systemVoices = [];
  }
}

// ---------- Durum ----------

function modelNames() {
  if (!lists) return '';
  const b = lists.backends.find((x) => x.id === settings.mtBackend) || lists.backends.find((x) => x.available);
  const v = settings.voice === 'system' ? { label: 'Sistem sesi' }
    : lists.voices.find((x) => x.id === settings.voice) || lists.voices.find((x) => x.default) || lists.voices[0];
  const short = (s) => String(s || '').replace(/\s*\(.*\)\s*$/, '');
  return [b && `Çeviri: ${short(b.label)}`, v && `Ses: ${short(v.label)}`].filter(Boolean).join(' · ');
}

function show(kind, title, detail = '', action = null, pct = null) {
  $('state').dataset.kind = kind;
  $('stateTitle').textContent = title;
  $('stateDetail').textContent = detail;
  const bar = $('stateBar');
  bar.hidden = pct === null;
  if (pct !== null) bar.firstElementChild.style.width = `${pct}%`;
  const btn = $('stateAction');
  btn.hidden = !action;
  if (action) { btn.textContent = action.label; btn.onclick = action.run; }
}

async function render() {
  $('enabled').checked = settings.enabled;
  const res = await bg({ type: 'engine.status' });
  const st = res.ok ? res.result : null;
  const dl = Object.values(progress).filter((p) => p && !p.done && !p.error && !p.cached && p.total);

  if (settings.engineMode === 'mock') {
    show('warn', 'Test motoru açık', 'Sahte çeviri ve bip sesi kullanılıyor.', { label: 'Ayarlara git', run: () => openOptions('#genel') });
  } else if (dl.length) {
    const L = dl.reduce((n, p) => n + p.loaded, 0), T = dl.reduce((n, p) => n + p.total, 0);
    const pct = Math.floor((L / T) * 100);
    show('info', `Modeller indiriliyor… %${pct}`, `${Math.round(L / 1048576)} / ${Math.round(T / 1048576)} MB`, null, pct);
  } else if (st && (st.mt.error || st.tts.error)) {
    show('err', 'Motor hatası', st.mt.error || st.tts.error, { label: 'Ayrıntılar', run: () => openOptions('#durum') });
  } else if (!settings.modelsApproved) {
    show('warn', 'Modeller indirilmedi', 'Dublaj için çeviri ve ses modellerinin bir kez indirilmesi gerekiyor.',
      { label: 'Modelleri indir', run: () => openOptions('#modeller') });
  } else if (!settings.enabled) {
    show('off', 'Dublaj kapalı', modelNames() || 'Açmak için anahtarı ya da videodaki TR düğmesini kullanın.');
  } else {
    show('ok', 'Dublaj açık', modelNames() || 'İngilizce altyazılı bir YouTube videosu açın.');
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'engine.progress' || msg.target) return false;
  progress[msg.engine] = msg;
  render();
  return false;
});

onSettingsChanged((s) => {
  settings = s;
  for (const id of ['ttsVolume', 'originalVolume']) {
    if (document.activeElement !== $(id)) { $(id).value = s[id]; $(id).dispatchEvent(new Event('input')); }
  }
  render();
  renderVoices();
});

try {
  // Yalnızca yakın zamandaki kayıtlar: yarıda kalmış eski bir indirme "sürüyor" görünmesin.
  const { progress: stored = {} } = await chrome.storage.session.get('progress');
  for (const [k, p] of Object.entries(stored)) if (p && Date.now() - (p.at || 0) < 15000) progress[k] = p;
} catch { /* yoksay */ }
render();
renderVoices();
Promise.all([bg({ type: 'engine.list' }), loadSystemVoices()]).then(([r]) => {
  if (r.ok) lists = r.result;
  render();
  renderVoices();
});
