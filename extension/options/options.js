// Ayarlar sayfası: genel ayarlar, ses, model yönetimi (indir / sil / kullan), depolama ve durum.

import { DEFAULTS, getSettings, setSettings, onSettingsChanged, secondVoice } from '../common/settings.js';
import { listCached, deleteByPrefix } from '../engines/common/model-cache.js';
import { clearTranscripts, transcriptStats } from '../common/transcript-store.js';
import { parseGlossary } from '../common/glossary.js';
import { buildReport } from '../common/diagnostics.js';

const $ = (id) => document.getElementById(id);
let settings = await getSettings();
let lists = { backends: [], voices: [], errors: {} };
let systemVoices = [];
let cached = []; // [{ url, size }]
// Kartlarda gösterilen indirme: motor → { id, loaded, total, error }
const downloads = { mt: null, tts: null };

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
    else if (v !== undefined && v !== null && v !== false) e[k] = v;
  }
  e.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return e;
}

function confirmBox(text, yesLabel = 'Tamam') {
  const d = $('confirm');
  $('confirmText').textContent = text;
  $('confirmYes').textContent = yesLabel;
  // Kapanınca odak yeniden çizilmiş (kopmuş) düğmeye dönemez ve sayfa başa kayar: konumu koru.
  const y = scrollY;
  d.showModal();
  return new Promise((resolve) => {
    d.addEventListener('close', () => {
      scrollTo({ top: y, behavior: 'instant' });
      resolve(d.returnValue === 'yes');
    }, { once: true });
  });
}

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

function renderBasics() {
  for (const id of ['glossaryMt', 'glossaryTts']) if (document.activeElement !== $(id)) $(id).value = settings[id];
  renderGlossaryNote();
  $('speakerVoices').checked = settings.speakerVoices;
  $('voice2Row').hidden = !settings.speakerVoices;
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
$('resetSettings').addEventListener('click', async () => {
  if (!(await confirmBox('Genel ve ses ayarları varsayılana dönecek. İndirilen modeller silinmez.', 'Varsayılana döndür'))) return;
  const { enabled, modelsApproved, glossaryMt, glossaryTts, ...rest } = DEFAULTS; // sözlük kullanıcı verisidir, sıfırlanmaz
  await setSettings(rest);
});

// ---------- Modeller ----------

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
  if (inUse) chips.push(el('span', { class: 'chip use', textContent: 'Kullanılıyor' }));
  return chips;
}

function progressBar(dl) {
  if (!dl || dl.error || !dl.total) return null;
  const fill = el('div');
  fill.style.width = `${Math.floor((dl.loaded / dl.total) * 100)}%`;
  return el('div', { class: 'pbar' }, fill);
}

function modelCard({ engine, id, name, meta, prefix, downloaded, sizeMB, inUse, onUse, extra, canDownload = true }) {
  const dl = downloads[engine]?.id === id ? downloads[engine] : null;
  const have = cachedBytes(prefix);
  const busy = !!dl && !dl.error;
  const actions = [];
  if (canDownload && !downloaded && !busy) {
    actions.push(el('button', {
      class: 'small', textContent: have ? 'Devam et' : `İndir${sizeMB ? ` (${fmtMB(sizeMB)})` : ''}`,
      disabled: settings.engineMode === 'mock', onclick: () => downloadModel(engine, id, sizeMB - bytesMB(have)),
    }));
  }
  if (canDownload && (downloaded || have > 0)) {
    actions.push(el('button', { class: 'small danger', textContent: 'Sil', disabled: busy, onclick: () => deleteModel(engine, id, name, prefix, inUse) }));
  }
  if (!inUse && onUse) actions.push(el('button', { class: 'small secondary', textContent: 'Kullan', disabled: busy, onclick: onUse }));

  const sizeText = !sizeMB && !have ? ''
    : downloaded ? `${fmtMB(have ? bytesMB(have) : sizeMB)} diskte`
      : `${fmtMB(sizeMB)} indirme`;
  return el('div', { class: 'model' + (inUse ? ' in-use' : '') },
    el('div', { class: 'name' }, name, ...stateChips({ downloaded, partialBytes: have, inUse, dl, canDownload })),
    el('div', { class: 'actions' }, ...actions),
    el('div', { class: 'meta', textContent: [meta, sizeText].filter(Boolean).join(' · ') }),
    (extra || progressBar(dl)) ? el('div', { class: 'extra' }, extra || null, progressBar(dl)) : null,
  );
}

function renderModels() {
  const err = Object.entries(lists.errors || {});
  $('listError').hidden = !err.length;
  $('listError').textContent = err.map(([k, e]) => `${k === 'mt' ? 'Çeviri' : 'Ses'} motoru: ${e}`).join('\n');

  // Çeviri
  const useMt = effectiveBackendId();
  const mt = [];
  for (const b of lists.backends) {
    if (b.id === 'chrome-translator') {
      const ready = b.status === 'available';
      const note = el('div', { class: 'note', id: 'chromeNote' });
      const prep = !ready && b.available && settings.engineMode !== 'mock'
        ? el('button', { class: 'small', textContent: 'Dil paketini hazırla', onclick: (e) => prepareChrome(e.target, note) })
        : null;
      const card = modelCard({
        engine: 'mt', id: b.id, name: b.label,
        meta: !b.available ? 'Bu Chrome sürümünde yok (Chrome 138+ gerekir)'
          : ready ? 'Chrome\'un cihaz üzerindeki çevirmeni · dil paketini Chrome yönetir' : 'Chrome\'un cihaz üzerindeki çevirmeni · EN→TR dil paketi gerekli',
        downloaded: ready, canDownload: false, inUse: useMt === b.id,
        onUse: b.available ? () => setSettings({ mtBackend: b.id }) : null,
        extra: note,
      });
      if (prep) card.querySelector('.actions').prepend(prep);
      mt.push(card);
    } else {
      mt.push(modelCard({
        engine: 'mt', id: b.id, name: b.label, meta: `Lisans: ${b.license || '—'}`,
        prefix: b.cachePrefix, downloaded: !!b.downloaded, sizeMB: b.sizeMB, inUse: useMt === b.id,
        onUse: () => setSettings({ mtBackend: b.id }),
      }));
    }
  }
  if (settings.mtBackend) {
    mt.push(el('div', { class: 'note' }, 'Çeviri motoru elle seçildi. ',
      el('button', { class: 'small secondary', textContent: 'Otomatik seçime dön', onclick: () => setSettings({ mtBackend: null }) })));
  }
  $('mtModels').replaceChildren(...mt);
  renderPrepare();

  // Seslendirme
  const useVoice = effectiveVoiceId();
  const tts = [];
  for (const v of lists.voices.filter((x) => !x.system)) {
    const g = v.gender === 'female' ? 'Kadın' : v.gender === 'male' ? 'Erkek' : '';
    tts.push(modelCard({
      engine: 'tts', id: v.id, name: v.label,
      meta: [g, `Lisans: ${v.license || '—'}`, v.default ? 'varsayılan' : ''].filter(Boolean).join(' · '),
      prefix: v.cachePrefix, downloaded: !!v.cached, sizeMB: v.sizeMB, inUse: useVoice === v.id,
      onUse: () => setSettings({ voice: v.id, systemVoiceName: null }),
      extra: v.attribution ? el('small', { textContent: `Atıf: ${v.attribution}. Ses yapay zekâ ile üretilir.` }) : null,
    }));
  }
  // Sistem sesi
  const sel = el('select', {
    onchange: (e) => setSettings({ voice: 'system', systemVoiceName: e.target.value || null }),
  });
  sel.append(el('option', { value: '', textContent: systemVoices.length ? 'Otomatik (Türkçe sistem sesi)' : 'Türkçe sistem sesi bulunamadı' }));
  for (const sv of systemVoices) {
    sel.append(el('option', {
      value: sv.voiceName, textContent: `${sv.voiceName}${sv.remote ? ' (çevrimiçi)' : ''}`,
      selected: settings.voice === 'system' && settings.systemVoiceName === sv.voiceName,
    }));
  }
  tts.push(modelCard({
    engine: 'tts', id: 'system', name: 'Sistem sesi',
    meta: 'Windows/Chrome\'un kendi Türkçe sesi · indirme gerekmez, kalite daha düşük',
    downloaded: true, canDownload: false, inUse: useVoice === 'system',
    onUse: () => setSettings({ voice: 'system', systemVoiceName: sel.value || null }),
    extra: sel,
  }));
  $('ttsModels').replaceChildren(...tts);
  renderVoice2();
}

// İkinci konuşmacının sesi: birinci sesten farklı, indirilebilir sesler.
function renderVoice2() {
  const first = effectiveVoiceId();
  const want = secondVoice({ ...settings, voice: first });
  const voices = lists.voices.filter((v) => !v.system && v.id !== first);
  const sel = $('voice2');
  sel.replaceChildren(...voices.map((v) => el('option', {
    value: v.id, textContent: v.label + (v.cached || settings.engineMode === 'mock' ? '' : ' — indirilmedi'), selected: v.id === want,
  })));
  sel.disabled = !voices.length || first === 'system';
  const v = voices.find((x) => x.id === want);
  $('voice2Note').textContent = first === 'system' ? 'Sistem sesi seçiliyken kullanılmaz.'
    : v && !v.cached && settings.engineMode !== 'mock' ? 'Bu ses henüz indirilmedi; Modeller bölümünden indirin.' : '';
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
  renderModels();
  await setSettings({ modelsApproved: true });
  const options = engine === 'mt' ? { backend: id } : { voice: id };
  const res = await bg({ type: 'engine.init', engine, options, userInitiated: true });
  downloads[engine] = res.ok ? null : { id, error: res.error };
  await refreshModels();
  renderStatus();
}

async function deleteModel(engine, id, name, prefix, inUse) {
  const extra = inUse ? ' Bu model şu an kullanılıyor; dublaj için yeniden indirmeniz gerekecek.' : '';
  if (!(await confirmBox(`"${name}" bilgisayardan silinecek.${extra}`, 'Sil'))) return;
  await bg({ type: 'engine.reset', engine });
  await deleteByPrefix(prefix);
  // Kullanılan model silindiyse dublaj sormadan yeniden indirmesin.
  if (inUse) await setSettings({ modelsApproved: false });
  await refreshModels();
  renderStatus();
}

async function prepareChrome(btn, note) {
  const mod = chromeTranslatorMod || (await import('../engines/mt/chrome-translator.js').catch(() => null));
  if (!mod?.prepareChromeTranslator) {
    note.className = 'note err';
    note.textContent = 'Chrome çevirmen modülü yüklenemedi.';
    return;
  }
  btn.disabled = true;
  note.className = 'note';
  note.textContent = 'Dil paketi hazırlanıyor…';
  try {
    const r = await mod.prepareChromeTranslator({
      onProgress: (p) => {
        const pct = p?.total ? Math.floor((p.loaded / p.total) * 100) : Math.floor((p?.loaded || 0) * 100);
        note.textContent = `Dil paketi indiriliyor… %${Math.min(100, pct)}`;
      },
    });
    note.textContent = r === 'available' ? 'Hazır.' : `Durum: ${r}. İndirme sürüyorsa biraz sonra sayfayı yenileyin.`;
    await refreshModels();
  } catch (e) {
    note.className = 'note err';
    note.textContent = 'Hazırlanamadı: ' + (e?.message || e);
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
  renderModels();
  if (msg.done || msg.error) { refreshModels(); renderStatus(); }
  return false;
});

// ---------- Depolama ----------

async function refreshCache() {
  try {
    cached = await listCached();
    const total = cached.reduce((n, f) => n + f.size, 0);
    $('cacheTotal').textContent = fmtMB(bytesMB(total));
    $('cacheFiles').textContent = String(cached.length);
    const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
    $('usageTotal').textContent = est ? fmtMB(bytesMB(est.usage || 0)) : '—';
    const tr = await transcriptStats(chrome.storage.local);
    $('trVideos').textContent = String(tr.videos);
    $('trVideos').title = tr.bytes ? fmtMB(bytesMB(tr.bytes)) : '';
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
  await setSettings({ modelsApproved: false });
  $('clearAll').disabled = false;
  $('storageNote').textContent = res.ok ? 'Tüm modeller silindi.' : 'Silinemedi: ' + res.error;
  await refreshModels();
  renderStatus();
});

// ---------- Durum ----------

function line(cls, text) {
  return el('span', { class: cls, textContent: text });
}

async function renderStatus() {
  const res = await bg({ type: 'engine.status' });
  const box = $('status');
  box.replaceChildren();
  if (!res.ok) { box.append(line('err', 'Motor durumu okunamadı: ' + res.error)); return; }
  const st = res.result;
  const one = (label, s, extra) => {
    if (s.error) return line('err', `${label}: hata — ${s.error}`);
    if (s.ready) return line('ok', `${label}: belleğe yüklü${extra ? ' (' + extra + ')' : ''}`);
    if (s.loading) return line('warn', `${label}: yükleniyor…`);
    return line('', `${label}: yüklü değil (dublaj başlayınca yüklenir)`);
  };
  box.append(one('Çeviri', st.mt, st.mt.backend || (st.mt.mode === 'mock' ? 'test' : '')), '\n');
  box.append(settings.voice === 'system'
    ? line('ok', 'Ses: sistem sesi')
    : one('Ses', st.tts, st.tts.voice || (st.tts.mode === 'mock' ? 'test' : '')), '\n');
  box.append(line(st.crossOriginIsolated ? '' : 'warn',
    `Çoklu iş parçacığı: ${st.crossOriginIsolated ? 'açık' : 'kapalı'} · WebGPU: ${st.webgpu ? 'var' : 'yok'} · ${st.hardwareConcurrency} çekirdek`));
  box.append('\n', line(settings.modelsApproved ? 'ok' : 'warn',
    settings.modelsApproved ? 'Model indirme onayı: verildi' : 'Model indirme onayı: yok (dublaj, modeller indirilene kadar bekler)'));
}
$('refreshStatus').addEventListener('click', () => { renderStatus(); refreshModels(); });

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

// ---------- Sekme vurgusu ----------

const tabLinks = [...document.querySelectorAll('.tabs a')];
const spy = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    for (const a of tabLinks) a.classList.toggle('on', a.getAttribute('href') === '#' + en.target.id);
  }
}, { rootMargin: '-120px 0px -60% 0px' });
for (const a of tabLinks) spy.observe(document.querySelector(a.getAttribute('href')));

// ---------- Başlat ----------

onSettingsChanged((s, keys) => {
  settings = s;
  renderBasics();
  renderModels();
  if (keys.some((k) => ['voice', 'mtBackend', 'engineMode', 'modelsApproved'].includes(k))) renderStatus();
});
renderBasics();
refreshModels();
renderStatus();
