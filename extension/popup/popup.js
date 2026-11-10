// Açılır pencere: dublajı aç/kapa, kısa durum, hızlı ses ayarları. Ayrıntılar ve modeller ayarlar sayfasında.

import { getSettings, setSettings, onSettingsChanged } from '../common/settings.js';
import { getDirHandle, permission } from '../common/self-update.js';
import { DOWNLOAD_URL, INSTALL_URL, updateFrom } from '../common/version.js';

let shownUpdate = null; // renderUpdate'in gösterdiği güncelleme (indirme / kurulum bağlantıları kaynağa göre)

const $ = (id) => document.getElementById(id);
$('ver').textContent = chrome.runtime.getManifest().version;
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

// ---------- Güncelleme ----------
// Arka plan sitedeki sürümü chrome.storage.local → update'e yazar; burada kurulu sürümle karşılaştırılır.

const STALE_MS = 12 * 3600 * 1000;

async function renderUpdate() {
  const { update, updateDismissed } = await chrome.storage.local.get(['update', 'updateDismissed']);
  const u = settings.checkUpdates ? updateFrom(update?.latest, chrome.runtime.getManifest().version) : null;
  $('update').hidden = !u || updateDismissed === u.version;
  shownUpdate = u;
  if (u) $('updateTitle').textContent = `Yeni sürüm: LocaDub ${u.version}${u.sizeMB ? ` (${u.sizeMB} MB)` : ''}`;
  // otomatik güncelleme klasörü seçiliyse tek tıkla güncelle (common/self-update.js; Ayarlar → Diğer)
  const dir = u ? await getDirHandle().catch(() => null) : null;
  $('updateNow').hidden = !dir;
  $('updateDownload').classList.toggle('btn-primary', !dir);
  $('updateHint').textContent = dir
    ? 'Şimdi güncelle: yeni sürüm indirilip eklenti klasörüne yazılır ve eklenti yeniden başlar (açık dublaj durur). Modeller ve ayarlar korunur.'
    : 'İndirdiğiniz klasörü eskisinin yerine koyup chrome://extensions sayfasında eklentiyi yenileyin. Modeller ve ayarlar korunur. Ayarlar → Güncelleme\'den eklenti klasörünü seçerseniz tek tıkla güncellenir.';
  return update;
}

$('updateNow').addEventListener('click', async () => {
  const btn = $('updateNow');
  btn.disabled = true;
  btn.textContent = 'Güncelleniyor…';
  try {
    const dir = await getDirHandle();
    // izin tarayıcı yeniden açılınca sıfırlanabilir: kullanıcı tıklaması burada, izni burada iste
    if (!dir || !(await permission(dir, true))) throw new Error('Klasöre yazma izni verilmedi');
    const res = await bg({ type: 'update.apply' });
    const r = res?.ok ? res.result : 'error: ' + (res?.error || '?');
    if (r !== 'started') throw new Error(r === 'current' ? 'Zaten güncel' : r === 'busy' ? 'Güncelleme zaten sürüyor' : String(r).replace(/^error: /, ''));
    btn.textContent = 'Eklenti yeniden başlıyor…';
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Şimdi güncelle';
    $('updateHint').textContent = 'Güncellenemedi: ' + (e?.message || e);
  }
});
$('updateDownload').addEventListener('click', () => chrome.tabs.create({ url: shownUpdate?.downloadUrl || DOWNLOAD_URL }));
$('updateHow').addEventListener('click', () => chrome.tabs.create({ url: shownUpdate?.installUrl || INSTALL_URL }));
$('updateLater').addEventListener('click', async () => {
  const { update } = await chrome.storage.local.get('update');
  await chrome.storage.local.set({ updateDismissed: update?.latest?.version || null });
  $('update').hidden = true;
});

renderUpdate().then((update) => {
  // Son denetim eskiyse (ya da hiç yapılmadıysa) şimdi denetle.
  if (settings.checkUpdates && !(Date.now() - (update?.checkedAt || 0) < STALE_MS)) {
    bg({ type: 'update.check' }).then(() => renderUpdate());
  }
});

// ---------- Ayarlar ----------

function bindRange(id, fmt) {
  const input = $(id), out = $(id + 'Out');
  const show = () => {
    out.textContent = fmt(Number(input.value));
    input.style.setProperty('--v', `${((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100}%`);
  };
  input.value = settings[id];
  show();
  input.addEventListener('input', show);
  input.addEventListener('change', () => setSettings({ [id]: Number(input.value) }));
}
bindRange('ttsVolume', (v) => `%${Math.round(v * 100)}`);
bindRange('originalVolume', (v) => `%${Math.round(v * 100)}`);

// Dublaj durumu sekmeye özeldir: açılır pencere etkin sekmedeki içerik betiğiyle konuşur (YouTube dışında depoya yazar).
let tabEnabled = null; // null: etkin sekmede eklenti yok
async function tabMsg(m) {
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    return t?.id ? await chrome.tabs.sendMessage(t.id, m) : null;
  } catch { return null; }
}
async function refreshTab() { const r = await tabMsg({ type: 'dub.state' }); tabEnabled = r ? !!r.enabled : null; }
$('enabled').addEventListener('change', async (e) => {
  const r = await tabMsg({ type: 'dub.set', enabled: e.target.checked });
  if (!r) setSettings({ enabled: e.target.checked });
  await refreshTab();
  render();
});
$('separation').checked = settings.separation !== 'off';
$('separation').addEventListener('change', (e) => setSettings({ separation: e.target.checked ? 'auto' : 'off' }));
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
  const short = (s) => s.replace(/^Microsoft\s+/, '').replace(/\s*-\s*Turkish.*$/i, '');

  const ready = voices.filter((v) => v.cached || settings.engineMode === 'mock');
  const missing = voices.filter((v) => !ready.includes(v));
  if (ready.length) {
    const g = document.createElement('optgroup');
    g.label = 'İndirilmiş';
    // Supertonic hazır seslerinin adı cinsiyeti zaten söyler
    for (const v of ready) g.append(option(v.id, `${name(v)}${gender(v) && !v.pack ? ` · ${gender(v)}` : ''}`, { selected: current === v.id }));
    sel.append(g);
  }
  const sys = document.createElement('optgroup');
  sys.label = 'Sistem (indirmesiz)';
  if (systemVoices.length) {
    for (const { voiceName: sv, remote } of systemVoices) {
      // Çevrimiçi sistem sesinde metin sağlayıcının sunucusuna gidebilir; ayarlar sayfasıyla aynı uyarı.
      sys.append(option('system:' + sv, `${short(sv)}${remote ? ' (çevrimiçi)' : ''}`,
        { selected: settings.voice === 'system' && settings.systemVoiceName === sv }));
    }
  } else {
    sys.append(option('system:', 'Türkçe sistem sesi', { selected: settings.voice === 'system' }));
  }
  sel.append(sys);
  if (missing.length) {
    const g = document.createElement('optgroup');
    g.label = 'İndirilmemiş';
    // bir paketin sesleri tek indirmedir: paket bir kez listelenir
    const packs = new Set();
    for (const v of missing) {
      if (v.pack && packs.has(v.pack)) continue;
      if (v.pack) packs.add(v.pack);
      g.append(option(MORE + v.id, `${v.pack ? 'Supertonic 3, 10 ses' : name(v)} (indir)`));
    }
    sel.append(g);
  }
  // Seçili ses indirilmemişse (ör. silindi) listede yine görünsün.
  if (current && current !== 'system' && !ready.some((v) => v.id === current)) {
    const v = voices.find((x) => x.id === current);
    if (v) sel.prepend(option(v.id, `${name(v)} (indir)`, { selected: true }));
  }
}

$('voice').addEventListener('change', (e) => {
  const v = e.target.value;
  if (v.startsWith(MORE)) {
    renderVoices(); // seçimi geri al
    openOptions('#indirme');
  } else if (v.startsWith('system:')) {
    setSettings({ voice: 'system', systemVoiceName: v.slice(7) || null });
  } else {
    setSettings({ voice: v, systemVoiceName: null });
  }
});

async function loadSystemVoices() {
  try {
    const all = await chrome.tts.getVoices();
    systemVoices = all.filter((v) => v.lang && /^tr\b/i.test(v.lang)).map((v) => ({ voiceName: v.voiceName, remote: !!v.remote }));
  } catch { // günlüğe yazılmaz: liste boş görünür (beklenen)
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

const DOT = { ok: 'ok', info: 'prep', warn: 'warn', err: 'err', off: '' };

function show(kind, title, detail = '', action = null, pct = null) {
  $('state').dataset.kind = kind;
  $('stateDot').className = `dot ${DOT[kind] || ''}`.trim();
  $('stateTitle').textContent = title;
  $('stateDetail').textContent = detail;
  const bar = $('stateBar');
  bar.hidden = pct === null;
  if (pct !== null) bar.style.setProperty('--v', `${pct}%`);
  const btn = $('stateAction');
  btn.hidden = !action;
  if (action) { btn.textContent = action.label; btn.onclick = action.run; }
}

async function render() {
  await refreshTab();
  const on = tabEnabled ?? settings.enabled;
  $('enabled').checked = on;
  $('tabHint').textContent = tabEnabled === null ? 'Bu sekmede video yok; genel ayar' : 'Yalnız bu sekmeyi etkiler';
  const res = await bg({ type: 'engine.status' });
  const st = res.ok ? res.result : null;
  const dl = Object.values(progress).filter((p) => p && !p.done && !p.error && !p.cached && p.total);

  if (settings.engineMode === 'mock') {
    show('warn', 'Test motoru açık', 'Sahte çeviri ve bip sesi kullanılıyor.', { label: 'Ayarlara git', run: () => openOptions('#diger') });
  } else if (dl.length) {
    const L = dl.reduce((n, p) => n + p.loaded, 0), T = dl.reduce((n, p) => n + p.total, 0);
    const pct = Math.floor((L / T) * 100);
    show('info', `Modeller indiriliyor… %${pct}`, `${Math.round(L / 1048576)} / ${Math.round(T / 1048576)} MB`, null, pct);
  } else if (st && (st.mt.error || st.tts.error)) {
    show('err', 'Motor hatası', st.mt.error || st.tts.error, { label: 'Ayrıntılar', run: () => openOptions('#ai-model') });
  } else if (!settings.modelsApproved) {
    show('warn', 'Modeller indirilmedi', 'Dublaj için çeviri ve ses modellerinin bir kez indirilmesi gerekiyor.',
      { label: 'Modelleri indir', run: () => openOptions('#indirme') });
  } else if (!on) {
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
  $('separation').checked = s.separation !== 'off';
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
