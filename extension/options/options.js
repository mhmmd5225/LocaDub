// Ayarlar sayfası: dört menü (İndirme, Seslendirme, AI Model, Diğer). Tüm paneller DOM'da kalır (hidden),
// böylece her id'ye bağlanan kod ve motor ilerleme mesajları hangi menü açık olursa olsun çalışır.

import { DEFAULTS, getSettings, setSettings, onSettingsChanged, secondVoice } from '../common/settings.js';
import { listCached, deleteByPrefix, fetchModel } from '../engines/common/model-cache.js';
import { PUNCT_MODEL, punctUrl, punctBytes } from '../engines/mt/punct.js';
import { clearTranscripts, transcriptStats } from '../common/transcript-store.js';
import { parseGlossary } from '../common/glossary.js';
import { buildReport } from '../common/diagnostics.js';

const $ = (id) => document.getElementById(id);
let settings = await getSettings();
let lists = { backends: [], voices: [], errors: {} };
let systemVoices = [];
let cached = []; // [{ url, size }]
// Kartlarda gösterilen indirme: motor → { id, loaded, total, error }
const downloads = { mt: null, tts: null, punct: null };

// Chrome Translator dil paketi kullanıcı etkileşimi ister: modülü önceden yükle, tıklamada doğrudan çağır.
let chromeTranslatorMod = null;
import('../engines/mt/chrome-translator.js').then((m) => { chromeTranslatorMod = m; }).catch(() => {});

async function bg(msg) {
  try {
    return (await chrome.runtime.sendMessage(msg)) ?? { ok: false, error: 'Boş yanıt' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

const fmtMB = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`);
const bytesMB = (b) => b / 1048576;

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k.startsWith('aria-')) e.setAttribute(k, v);
    else if (v !== undefined && v !== null && v !== false) e[k] = v;
  }
  e.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return e;
}

function confirmBox(text, yesLabel = 'Tamam') {
  const d = $('confirm');
  $('confirmText').textContent = text;
  $('confirmYes').textContent = yesLabel;
  d.showModal();
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true });
  });
}

// ---------- Menüler ----------

const TABS = ['indirme', 'seslendirme', 'ai-model', 'diger'];
// Eski bölüm adları yeni menülere eşlenir.
const ALIASES = { modeller: 'indirme', depolama: 'indirme', ses: 'seslendirme', genel: 'diger', sozluk: 'diger', durum: 'diger', gelistirici: 'diger' };
const devMode = () => new URLSearchParams(location.search).get('dev') === '1' || location.hash === '#gelistirici';

function tabFromHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  return TABS.includes(h) ? h : ALIASES[h] || null;
}

function selectTab(name, { focus = false, updateHash = false } = {}) {
  for (const t of TABS) {
    const on = t === name;
    const tab = $('tab-' + t);
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(t).hidden = !on;
    if (on && focus) tab.focus();
  }
  // Geçmişi şişirmemek için replaceState; geliştirici bağlantısı korunur.
  if (updateHash) history.replaceState(null, '', location.pathname + location.search + '#' + (name === 'diger' && devMode() ? 'gelistirici' : name));
  renderMockRow();
}

for (const t of TABS) $('tab-' + t).addEventListener('click', () => selectTab(t, { updateHash: true }));
$('tab-indirme').parentElement.addEventListener('keydown', (e) => {
  const i = TABS.indexOf(document.activeElement?.dataset?.tab);
  if (i < 0) return;
  const next = { ArrowRight: (i + 1) % TABS.length, ArrowLeft: (i + TABS.length - 1) % TABS.length, Home: 0, End: TABS.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  selectTab(TABS[next], { focus: true, updateHash: true });
});
window.addEventListener('hashchange', () => { const t = tabFromHash(); if (t) selectTab(t); });
// Menü içindeki ve şeritteki bağlantılar (#diger, #indirme) hashchange ile çalışır.

// ---------- Genel ve ses ayarları ----------

const RANGES = {
  ttsSpeed: (v) => `${v.toFixed(2)}×`,
  ttsVolume: (v) => `%${Math.round(v * 100)}`,
  originalVolume: (v) => `%${Math.round(v * 100)}`,
  lookaheadSec: (v) => `${v} sn`,
};

for (const [id, fmt] of Object.entries(RANGES)) {
  const input = $(id), out = $(id + 'Out');
  input.addEventListener('input', () => { out.textContent = fmt(Number(input.value)); });
  input.addEventListener('change', () => setSettings({ [id]: Number(input.value) }));
}

// Sözlük: yazarken kısa gecikmeyle kaydedilir.
for (const id of ['glossaryMt', 'glossaryTts']) {
  let t = null;
  const save = () => { clearTimeout(t); if ($(id).value !== settings[id]) setSettings({ [id]: $(id).value }); };
  $(id).addEventListener('input', () => { clearTimeout(t); t = setTimeout(save, 700); renderGlossaryNote(); });
  $(id).addEventListener('change', save);
}

function renderGlossaryNote() {
  const n = (id) => parseGlossary($(id).value).length;
  const a = n('glossaryMt'), b = n('glossaryTts');
  $('glossaryNote').textContent = a || b ? `${a} çeviri düzeltmesi, ${b} okunuş kuralı etkin.` : '';
}

$('speakerVoices').addEventListener('change', (e) => setSettings({ speakerVoices: e.target.checked }));
$('voice2').addEventListener('change', (e) => setSettings({ voice2: e.target.value || null }));

let speakerOpened = false; // konuşmacı bloğu, anahtar açıksa ilk çizimde açılır
// Test motoru gizlidir: #gelistirici / ?dev=1 ile ya da motor zaten test modundaysa (kapatılabilsin) görünür.
function renderMockRow() {
  $('mockRow').hidden = !(devMode() || settings.engineMode === 'mock');
}

function renderBasics() {
  renderMockRow();
  for (const id of ['glossaryMt', 'glossaryTts']) if (document.activeElement !== $(id)) $(id).value = settings[id];
  renderGlossaryNote();
  $('speakerVoices').checked = settings.speakerVoices;
  $('voice2Row').hidden = !settings.speakerVoices;
  if (settings.speakerVoices && !speakerOpened) { $('speakerBlock').open = true; speakerOpened = true; }
  $('enabled').checked = settings.enabled;
  $('enabledLabel').textContent = settings.enabled ? 'Dublaj açık' : 'Dublaj kapalı';
  $('showSubtitles').checked = settings.showSubtitles;
  $('checkUpdates').checked = settings.checkUpdates;
  $('mock').checked = settings.engineMode === 'mock';
  for (const [id, fmt] of Object.entries(RANGES)) {
    if (document.activeElement !== $(id)) $(id).value = settings[id];
    $(id + 'Out').textContent = fmt(Number(settings[id]));
  }
}

$('enabled').addEventListener('change', (e) => setSettings({ enabled: e.target.checked }));
$('showSubtitles').addEventListener('change', (e) => setSettings({ showSubtitles: e.target.checked }));
$('checkUpdates').addEventListener('change', (e) => setSettings({ checkUpdates: e.target.checked }));
$('mock').addEventListener('change', async (e) => {
  await setSettings({ engineMode: e.target.checked ? 'mock' : 'real', mtBackend: null, voice: null });
  await refreshModels();
});
$('fixAsrPunct').addEventListener('change', (e) => setSettings({ fixAsrPunct: e.target.checked }));
$('resetSettings').addEventListener('click', async () => {
  if (!(await confirmBox('Ayarlar varsayılana dönecek. Sözlük ve indirilen modeller silinmez.', 'Varsayılana döndür'))) return;
  const { enabled, modelsApproved, glossaryMt, glossaryTts, ...rest } = DEFAULTS; // sözlük kullanıcı verisidir, sıfırlanmaz
  await setSettings(rest);
});

// ---------- Modeller (İndirme menüsü) ----------

function cachedBytes(prefix) {
  if (!prefix) return 0;
  return cached.reduce((n, f) => (f.url.startsWith(prefix) ? n + f.size : n), 0);
}

function effectiveBackendId() {
  if (settings.mtBackend) return settings.mtBackend;
  return (lists.backends.find((b) => b.available) || lists.backends[0])?.id || null;
}

function effectiveVoiceId() {
  if (settings.voice) return settings.voice;
  return (lists.voices.find((v) => v.default && !v.system) || lists.voices.find((v) => v.available && !v.system))?.id || null;
}

function stateChips({ downloaded, partialBytes, inUse, dl, canDownload }) {
  const chips = [];
  if (dl && !dl.error) {
    const pct = dl.total ? Math.floor((dl.loaded / dl.total) * 100) : 0;
    chips.push(el('span', { class: 'chip busy', textContent: dl.total ? `İndiriliyor %${pct}` : 'Hazırlanıyor…' }));
  } else if (dl?.error) {
    chips.push(el('span', { class: 'chip err', textContent: 'Hata', title: dl.error }));
  } else if (downloaded) {
    chips.push(el('span', { class: 'chip ok', textContent: canDownload ? '✓ İndirildi' : '✓ Hazır' }));
  } else if (partialBytes > 0) {
    chips.push(el('span', { class: 'chip warn', textContent: 'Yarım kaldı' }));
  } else {
    chips.push(el('span', { class: 'chip', textContent: 'İndirilmedi' }));
  }
  if (inUse) chips.push(el('span', { class: 'chip use', textContent: downloaded ? 'Kullanılıyor' : 'Seçili' }));
  return chips;
}

function progressBar(dl) {
  if (!dl || dl.error || !dl.total) return null;
  const fill = el('div');
  fill.style.width = `${Math.floor((dl.loaded / dl.total) * 100)}%`;
  return el('div', { class: 'pbar' }, fill);
}

// Kısa adlar: satırlarda ve seçimlerde ayrıntı yerine yalnızca ad görünür.
const SHORT = { 'opus-mt': 'OPUS-MT', 'antalia-mini': 'Antalia Mini', 'ahenk-cep': 'Ahenk Cep' };
const isMock = () => settings.engineMode === 'mock';
const shortName = (m) => SHORT[m.id] || m.label.replace(/\s*\(.*\)\s*$/, '');
// Parantez içindeki açıklama ("erkek, hızlı") ikinci satır olur.
const subtitle = (m) => {
  const t = /\(([^)]*)\)/.exec(m.label)?.[1];
  return t ? t[0].toLocaleUpperCase('tr') + t.slice(1) : '';
};

// "İndirme menüsünden indirin." bağlantısı (hashchange menüyü açar).
const downloadHint = () => [el('a', { href: '#indirme', textContent: 'İndirme menüsünden indirin.' })];

// Kompakt model satırı: ad + rozetler | boyut | İndir / Sil.
function modelRow({ engine, id, name, kind, prefix, downloaded, sizeMB, inUse, canDownload = true, title }) {
  const dl = downloads[engine]?.id === id ? downloads[engine] : null;
  const have = cachedBytes(prefix);
  const busy = !!dl && !dl.error;
  const actions = [];
  if (canDownload && !downloaded && !busy) {
    actions.push(el('button', {
      class: 'small', textContent: have ? 'Devam et' : 'İndir', 'aria-label': `${name} modelini indir`,
      onclick: () => downloadModel(engine, id, sizeMB - bytesMB(have)),
    }));
  }
  if (canDownload && (downloaded || have > 0)) {
    actions.push(el('button', {
      class: 'small danger', textContent: 'Sil', 'aria-label': `${name} modelini sil`, disabled: busy,
      onclick: () => deleteModel(engine, id, name, prefix, inUse),
    }));
  }
  const sizeText = !sizeMB && !have ? ''
    : downloaded ? `${fmtMB(have ? bytesMB(have) : sizeMB)} diskte`
      : `${fmtMB(sizeMB)} indirme`;
  return el('div', { class: 'model' + (inUse ? ' in-use' : ''), title: title || undefined },
    el('div', { class: 'name' }, name, el('span', { class: 'kind', textContent: kind }), ...stateChips({ downloaded, partialBytes: have, inUse, dl, canDownload })),
    el('div', { class: 'meta' + (dl?.error ? ' err' : ''), textContent: dl?.error ? dl.error : sizeText, title: dl?.error || undefined }),
    el('div', { class: 'actions' }, ...actions),
    progressBar(dl),
  );
}

// Noktalama modeli: iki dosya da önbellekte mi; indirme bitince düzeltme kendiliğinden açılır.
const punctDownloaded = () => PUNCT_MODEL.files.every((f) => cached.some((c) => c.url === punctUrl(f.name)));

function punctRow() {
  const downloaded = punctDownloaded();
  return modelRow({
    engine: 'punct', id: 'punct-en', name: 'Noktalama modeli', kind: 'altyazı',
    prefix: PUNCT_MODEL.repo, downloaded, sizeMB: punctBytes() / 1e6, inUse: downloaded && settings.fixAsrPunct,
    title: 'Apache-2.0 · HuggingFace: 1-800-BAD-CODE',
  });
}

// İndirme menüsü: tek liste. İlerleme mesajları yalnızca bunu yeniden çizer.
function renderDownloads() {
  const useMt = effectiveBackendId();
  const useVoice = effectiveVoiceId();
  const mock = isMock();
  const rows = [];
  for (const b of lists.backends.filter((x) => x.id !== 'chrome-translator')) {
    rows.push(modelRow({
      engine: 'mt', id: b.id, name: shortName(b), kind: 'çeviri', prefix: b.cachePrefix,
      downloaded: !!b.downloaded || mock, canDownload: !mock, sizeMB: b.sizeMB, inUse: useMt === b.id,
      title: b.license ? `Lisans: ${b.license}` : undefined,
    }));
  }
  for (const v of lists.voices.filter((x) => !x.system)) {
    rows.push(modelRow({
      engine: 'tts', id: v.id, name: shortName(v), kind: 'ses', prefix: v.cachePrefix,
      downloaded: !!v.cached || mock, canDownload: !mock, sizeMB: v.sizeMB, inUse: useVoice === v.id,
      title: v.license ? `Lisans: ${v.license}` : undefined,
    }));
  }
  $('modelRows').replaceChildren(...rows);
  $('punctModels').replaceChildren(punctRow());
  const total = cached.reduce((n, f) => n + f.size, 0);
  $('dlSummary').textContent = total ? `${fmtMB(bytesMB(total))} indirildi` : 'Hiçbiri indirilmedi';
  renderPrepare();
  paintStrip();
}

// Radyo düğmelerini yeniden çizerken klavye odağı kaybolmasın.
function keepFocus(fn) {
  const key = document.activeElement?.dataset?.fk;
  fn();
  if (key) document.querySelector(`[data-fk="${key}"]`)?.focus();
}

function choice({ name, value, checked, disabled, title, note, extra, onchange }) {
  const input = el('input', { type: 'radio', name, value, checked, disabled: !!disabled, onchange });
  input.dataset.fk = `${name}:${value}`;
  return el('label', { class: 'choice' }, input,
    el('span', {}, el('b', { textContent: title }), note ? el('small', { textContent: note }) : null, extra || null));
}

// Seslendirme menüsü: ses seçimi.
function renderVoiceChoice() {
  const useVoice = effectiveVoiceId();
  const opts = [];
  for (const v of lists.voices.filter((x) => !x.system)) {
    const missing = !v.cached && !isMock();
    opts.push(choice({
      name: 'voice', value: v.id, checked: useVoice === v.id, title: shortName(v),
      note: [subtitle(v), missing ? 'indirilmedi' : ''].filter(Boolean).join(' · '),
      onchange: () => setSettings({ voice: v.id, systemVoiceName: null }),
    }));
  }
  const sel = $('systemVoice');
  opts.push(choice({
    name: 'voice', value: 'system', checked: useVoice === 'system', title: 'Sistem sesi',
    note: 'İndirme gerekmez, kalite daha düşük',
    onchange: () => setSettings({ voice: 'system', systemVoiceName: sel.value || null }),
  }));
  $('voiceChoice').replaceChildren(...opts);

  sel.replaceChildren(el('option', { value: '', textContent: systemVoices.length ? 'Otomatik (Türkçe sistem sesi)' : 'Türkçe sistem sesi bulunamadı' }),
    ...systemVoices.map((sv) => el('option', {
      value: sv.voiceName, textContent: `${sv.voiceName}${sv.remote ? ' (çevrimiçi)' : ''}`,
      selected: settings.systemVoiceName === sv.voiceName,
    })));
  $('systemVoiceRow').hidden = useVoice !== 'system';

  const v = lists.voices.find((x) => x.id === useVoice);
  $('voiceNote').replaceChildren(...(v && !v.system && !v.cached && !isMock() ? ['Bu ses henüz indirilmedi. ', ...downloadHint()] : []));
}
$('systemVoice').addEventListener('change', (e) => setSettings({ voice: 'system', systemVoiceName: e.target.value || null }));

// Chrome dil paketi iletisi yeniden çizimlerde kaybolmasın.
let chromeMsg = { text: '', err: false };
function setChromeMsg(note, text, err = false) {
  chromeMsg = { text, err };
  note.className = 'note' + (err ? ' err' : '');
  note.textContent = text;
}

// AI Model menüsü: çeviri motoru (Otomatik = mtBackend:null).
function renderMtChoice() {
  const auto = lists.backends.find((b) => b.available);
  const opts = [choice({
    name: 'mt', value: '', checked: !settings.mtBackend, title: 'Otomatik',
    note: `Hazırsa Chrome çevirmenini, değilse OPUS-MT'yi kullanır${auto ? ` (şu an: ${shortName(auto)})` : ''}`,
    onchange: () => setSettings({ mtBackend: null }),
  })];
  for (const b of lists.backends) {
    if (b.id === 'chrome-translator') {
      const ready = b.status === 'available';
      const note = el('span', { class: 'note', id: 'chromeNote' });
      setChromeMsg(note, chromeMsg.text, chromeMsg.err);
      const prep = !ready && b.available && !isMock()
        ? el('button', { type: 'button', class: 'small', textContent: 'Dil paketini hazırla', onclick: (e) => prepareChrome(e.target, note) })
        : null;
      opts.push(choice({
        name: 'mt', value: b.id, checked: settings.mtBackend === b.id, disabled: !b.available, title: 'Chrome çevirmeni',
        note: !b.available ? 'Bu Chrome sürümünde yok (Chrome 138+ gerekir)'
          : ready ? 'Cihaz üzerinde çalışır · dil paketini Chrome yönetir' : 'Cihaz üzerinde çalışır · EN→TR dil paketi gerekli',
        extra: prep || chromeMsg.text ? el('div', { class: 'row-act' }, prep, note) : null,
        onchange: () => setSettings({ mtBackend: b.id }),
      }));
    } else {
      opts.push(choice({
        name: 'mt', value: b.id, checked: settings.mtBackend === b.id, title: shortName(b),
        note: isMock() || !b.sizeMB ? 'Test motoru' : `Çevrimdışı çalışır · ${fmtMB(b.sizeMB)}${b.downloaded ? ' · indirildi' : ' · indirilmedi'}`,
        onchange: () => setSettings({ mtBackend: b.id }),
      }));
    }
  }
  $('mtChoice').replaceChildren(...opts);
}

// AI Model menüsü: noktalama düzeltme (model yoksa kapalı, İndirme'ye yönlendirir).
function renderPunctToggle() {
  const have = punctDownloaded();
  $('fixAsrPunct').checked = have && settings.fixAsrPunct;
  $('fixAsrPunct').disabled = !have;
  $('punctNote').replaceChildren(...(have ? ['Yalnızca İngilizce otomatik altyazıda; çevrimdışı çalışır.'] : ['Model gerekir (≈ 210 MB). ', ...downloadHint()]));
}

function renderModels() {
  keepFocus(() => {
    renderDownloads();
    renderVoiceChoice();
    renderMtChoice();
    renderPunctToggle();
    renderVoice2();
  });
}

// İkinci konuşmacının sesi: birinci sesten farklı, indirilebilir sesler.
function renderVoice2() {
  const first = effectiveVoiceId();
  const want = secondVoice({ ...settings, voice: first });
  const voices = lists.voices.filter((v) => !v.system && v.id !== first);
  const sel = $('voice2');
  sel.replaceChildren(...voices.map((v) => el('option', {
    value: v.id, textContent: shortName(v) + (v.cached || isMock() ? '' : ' — indirilmedi'), selected: v.id === want,
  })));
  sel.disabled = !voices.length || first === 'system';
  const v = voices.find((x) => x.id === want);
  $('voice2Note').replaceChildren(...(first === 'system' ? ['Sistem sesi seçiliyken kullanılmaz.']
    : v && !v.cached && !isMock() ? ['Bu ses henüz indirilmedi. ', ...downloadHint()] : []));
}

// Kullanılacak (seçili) modellerden indirilmemiş olanlar.
function missingSelected() {
  const out = [];
  const b = lists.backends.find((x) => x.id === effectiveBackendId());
  if (b && b.id !== 'chrome-translator' && !b.downloaded) out.push({ engine: 'mt', id: b.id, label: b.label, mb: b.sizeMB - bytesMB(cachedBytes(b.cachePrefix)) });
  const v = lists.voices.find((x) => x.id === effectiveVoiceId());
  if (v && !v.system && !v.cached) out.push({ engine: 'tts', id: v.id, label: v.label, mb: v.sizeMB - bytesMB(cachedBytes(v.cachePrefix)) });
  if (settings.speakerVoices && v && !v.system) {
    const v2 = lists.voices.find((x) => x.id === secondVoice({ ...settings, voice: v.id }));
    if (v2 && !v2.cached) out.push({ engine: 'tts', id: v2.id, label: v2.label, mb: v2.sizeMB - bytesMB(cachedBytes(v2.cachePrefix)) });
  }
  return out;
}

function renderPrepare() {
  const miss = settings.engineMode === 'mock' ? [] : missingSelected();
  const busy = !!(downloads.mt && !downloads.mt.error) || !!(downloads.tts && !downloads.tts.error);
  $('prepareBox').hidden = !miss.length && settings.modelsApproved;
  const mb = miss.reduce((n, m) => n + Math.max(0, m.mb), 0);
  $('prepareSelected').disabled = busy;
  $('prepareSelected').textContent = miss.length ? `Seçili modelleri indir (≈ ${fmtMB(mb)})` : 'Dublaj için modelleri onayla';
  $('prepareNote').textContent = miss.length ? miss.map((m) => m.label.replace(/\s*\(.*\)\s*$/, '')).join(' + ') : '';
}

$('prepareSelected').addEventListener('click', async () => {
  const miss = missingSelected();
  const mb = miss.reduce((n, m) => n + Math.max(0, m.mb), 0);
  if (mb > 1 && !(await confirmBox(`Yaklaşık ${fmtMB(mb)} bir kez indirilecek ve tarayıcıda saklanacak. Sonrasında internetsiz çalışır.`, 'İndir'))) return;
  await setSettings({ modelsApproved: true });
  // Sırayla: ilerleme okunur kalsın.
  for (const m of miss) await downloadModel(m.engine, m.id, 0);
  await refreshModels();
});

async function downloadModel(engine, id, remainingMB) {
  const mb = Math.max(0, remainingMB || 0);
  if (mb > 1) {
    const ok = await confirmBox(`Yaklaşık ${fmtMB(mb)} bir kez indirilecek ve tarayıcıda saklanacak. Sonrasında internetsiz çalışır.`, 'İndir');
    if (!ok) return;
  }
  downloads[engine] = { id, loaded: 0, total: 0 };
  renderDownloads();
  if (engine === 'punct') return downloadPunct(id);
  await setSettings({ modelsApproved: true });
  const options = engine === 'mt' ? { backend: id } : { voice: id };
  const res = await bg({ type: 'engine.init', engine, options, userInitiated: true });
  downloads[engine] = res.ok ? null : { id, error: res.error };
  await refreshModels();
  renderStatus();
}

// Noktalama modeli doğrudan bu sayfadan indirilir (ortak önbellek); bitince düzeltme açılır.
async function downloadPunct(id) {
  const total = punctBytes();
  let base = 0;
  try {
    for (const f of PUNCT_MODEL.files) {
      await fetchModel(punctUrl(f.name), { onProgress: (p) => { downloads.punct = { id, loaded: base + p.loaded, total }; renderDownloads(); } });
      base += f.size;
    }
    await setSettings({ fixAsrPunct: true });
    downloads.punct = null;
  } catch (e) {
    downloads.punct = { id, error: e?.message || String(e) };
  }
  await refreshModels();
}

async function deleteModel(engine, id, name, prefix, inUse) {
  const extra = inUse ? ' Bu model şu an kullanılıyor; dublaj için yeniden indirmeniz gerekecek.' : '';
  if (!(await confirmBox(`"${name}" bilgisayardan silinecek.${extra}`, 'Sil'))) return;
  await bg({ type: 'engine.reset', engine });
  await deleteByPrefix(prefix);
  // Kullanılan model silindiyse dublaj sormadan yeniden indirmesin.
  if (engine === 'punct') await setSettings({ fixAsrPunct: false });
  else if (inUse) await setSettings({ modelsApproved: false });
  await refreshModels();
  renderStatus();
}

async function prepareChrome(btn, note) {
  const mod = chromeTranslatorMod || (await import('../engines/mt/chrome-translator.js').catch(() => null));
  if (!mod?.prepareChromeTranslator) {
    setChromeMsg(note, 'Chrome çevirmen modülü yüklenemedi.', true);
    return;
  }
  btn.disabled = true;
  setChromeMsg(note, 'Dil paketi hazırlanıyor…');
  try {
    const r = await mod.prepareChromeTranslator({
      onProgress: (p) => {
        const pct = p?.total ? Math.floor((p.loaded / p.total) * 100) : Math.floor((p?.loaded || 0) * 100);
        setChromeMsg(note, `Dil paketi indiriliyor… %${Math.min(100, pct)}`);
      },
    });
    setChromeMsg(note, r === 'available' ? 'Hazır.' : `Durum: ${r}. İndirme sürüyorsa biraz sonra sayfayı yenileyin.`);
    await refreshModels();
  } catch (e) {
    setChromeMsg(note, 'Hazırlanamadı: ' + (e?.message || e), true);
    btn.disabled = false;
  }
}

async function loadSystemVoices() {
  try {
    const voices = await chrome.tts.getVoices();
    return voices.filter((v) => v.lang && /^tr\b/i.test(v.lang)).map((v) => ({ voiceName: v.voiceName, remote: !!v.remote }));
  } catch {
    return [];
  }
}

async function refreshModels() {
  const [res, sys] = await Promise.all([bg({ type: 'engine.list' }), loadSystemVoices(), refreshCache()]);
  systemVoices = sys;
  lists = res.ok ? res.result : { backends: [], voices: [], errors: { mt: res.error } };
  renderModels();
}

// Dublaj ya da bu sayfa bir modeli yüklerken gelen ilerleme.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'engine.progress' || msg.target) return false;
  const e = msg.engine;
  const id = downloads[e]?.id || (e === 'mt' ? effectiveBackendId() : effectiveVoiceId());
  if (msg.done) downloads[e] = null;
  else if (msg.error) downloads[e] = { id, error: msg.error };
  else if (!msg.cached) downloads[e] = { id, loaded: msg.loaded, total: msg.total };
  renderDownloads();
  if (msg.done || msg.error) { refreshModels(); renderStatus(); }
  return false;
});

// ---------- Önbellek ----------

async function refreshCache() {
  try {
    cached = await listCached();
    const tr = await transcriptStats(chrome.storage.local);
    $('clearTranscripts').textContent = `Çeviri önbelleğini temizle (${tr.videos} video)`;
    $('clearTranscripts').title = tr.bytes ? fmtMB(bytesMB(tr.bytes)) : '';
    $('clearTranscripts').disabled = !tr.videos;
  } catch (e) {
    $('storageNote').textContent = 'Önbellek okunamadı: ' + e.message;
  }
}

$('clearTranscripts').addEventListener('click', async () => {
  const n = await clearTranscripts(chrome.storage.local);
  $('storageNote').textContent = `${n} videonun saklanan çevirisi silindi. Bu videolar yeniden çevrilecek.`;
  await refreshCache();
});

$('clearAll').addEventListener('click', async () => {
  if (!(await confirmBox('İndirilen tüm modeller silinecek. Dublaj için yeniden indirmeniz gerekecek.', 'Tümünü sil'))) return;
  $('clearAll').disabled = true;
  const res = await bg({ type: 'models.clear' });
  await setSettings({ modelsApproved: false, fixAsrPunct: false });
  $('clearAll').disabled = false;
  $('storageNote').textContent = res.ok ? 'Tüm modeller silindi.' : 'Silinemedi: ' + res.error;
  await refreshModels();
  renderStatus();
});

// ---------- Hata şeridi ----------

// Yalnızca motor/model hatası ya da uyarı varken görünür; teknik ayrıntılar tanılama raporundadır.
let statusIssues = [];
const DL_LABELS = { mt: 'Çeviri modeli', tts: 'Ses modeli', punct: 'Noktalama modeli' };

function line(cls, text) {
  return el('span', { class: cls, textContent: text });
}

function paintStrip() {
  const issues = [...statusIssues];
  for (const [k, e] of Object.entries(lists.errors || {})) issues.push({ cls: 'err', text: `${k === 'mt' ? 'Çeviri' : 'Ses'} motoru: ${e}` });
  for (const [k, d] of Object.entries(downloads)) if (d?.error) issues.push({ cls: 'err', text: `${DL_LABELS[k]} indirilemedi: ${d.error}` });
  $('statusBar').hidden = !issues.length;
  const box = $('status');
  box.replaceChildren(...issues.flatMap((x, i) => [i ? ' · ' : '', line(x.cls, x.text)]));
  box.title = issues.map((x) => x.text).join('\n');
}

async function renderStatus() {
  const res = await bg({ type: 'engine.status' });
  statusIssues = [];
  if (!res.ok) statusIssues.push({ cls: 'err', text: 'Motor durumu okunamadı: ' + res.error });
  else {
    const st = res.result;
    if (st.mt.error) statusIssues.push({ cls: 'err', text: `Çeviri: hata — ${st.mt.error}` });
    if (settings.voice !== 'system' && st.tts.error) statusIssues.push({ cls: 'err', text: `Ses: hata — ${st.tts.error}` });
  }
  paintStrip();
}

// ---------- Tanılama ----------

async function browserInfo() {
  const uad = navigator.userAgentData;
  if (uad?.getHighEntropyValues) {
    try {
      const h = await uad.getHighEntropyValues(['fullVersionList', 'platformVersion']);
      const b = (h.fullVersionList || []).find((x) => /Chrome|Edge|Opera|Brave/i.test(x.brand)) || h.fullVersionList?.[0];
      return { browser: b ? `${b.brand} ${b.version}` : 'Chromium', platform: `${uad.platform} ${h.platformVersion || ''}`.trim() };
    } catch { /* yoksay */ }
  }
  const m = /Chrome\/([\d.]+)/.exec(navigator.userAgent);
  return { browser: m ? 'Chrome ' + m[1] : navigator.userAgent, platform: navigator.platform || '?' };
}

async function diagnosticsReport() {
  const [status, errors, info] = await Promise.all([bg({ type: 'engine.status' }), bg({ type: 'diag.errors' }), browserInfo()]);
  const models = [...lists.backends, ...lists.voices]
    .filter((m) => m.cachePrefix && cachedBytes(m.cachePrefix) > 0)
    .map((m) => ({ name: m.label, sizeMB: bytesMB(cachedBytes(m.cachePrefix)) }));
  return buildReport({
    version: chrome.runtime.getManifest().version, ...info, settings,
    status: status.ok ? status.result : null, models, errors: errors.ok ? errors.result : [],
    glossary: { mt: parseGlossary(settings.glossaryMt).length, tts: parseGlossary(settings.glossaryTts).length },
  });
}

$('copyDiag').addEventListener('click', async () => {
  const text = await diagnosticsReport();
  $('diagText').textContent = text;
  try {
    await navigator.clipboard.writeText(text);
    $('diagNote').textContent = 'Kopyalandı.';
  } catch {
    $('diagNote').textContent = 'Kopyalanamadı; aşağıdaki metni elle seçip kopyalayın.';
    document.querySelector('.diag').open = true;
  }
});
document.querySelector('.diag').addEventListener('toggle', async (e) => {
  if (e.target.open) $('diagText').textContent = await diagnosticsReport();
});

// ---------- Başlat ----------

onSettingsChanged((s, keys) => {
  settings = s;
  renderBasics();
  renderModels();
  if (keys.some((k) => ['voice', 'mtBackend', 'engineMode', 'modelsApproved'].includes(k))) renderStatus();
});
$('aboutVersion').textContent = 'Sürüm ' + chrome.runtime.getManifest().version;
selectTab(tabFromHash() || 'indirme');
renderBasics();
refreshModels();
renderStatus();
