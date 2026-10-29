// Tanılama: son hatalar (halka tampon) ve kullanıcının sorun bildirirken kopyalayacağı rapor (saf; node testleriyle sınanır).
// Gizlilik: rapora video kimliği, YouTube adresi, altyazı ya da çeviri metni girmez; sözlükten yalnızca kural sayısı.

export const MAX_ERRORS = 10;

// YouTube adreslerini ve video kimliklerini siler; model (HuggingFace) adresleri kalır.
export function scrub(text) {
  return String(text ?? '')
    .replace(/https?:\/\/(?:[\w-]+\.)*(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\/\S*/gi, '<youtube-adresi>')
    .replace(/\b(v|videoId)([=:]\s*)[\w-]{11}\b/g, '$1$2…')
    .slice(0, 500);
}

/** Yeni hatayı ekler (ardışık aynı hata sayılır), en fazla MAX_ERRORS kayıt döner. */
export function pushError(list, { source, message, at = Date.now() }) {
  const msg = scrub(message);
  const out = Array.isArray(list) ? list.slice() : [];
  const last = out[out.length - 1];
  if (last && last.source === source && last.message === msg) {
    out[out.length - 1] = { ...last, at, count: (last.count || 1) + 1 };
  } else {
    out.push({ at, source: String(source || '?'), message: msg });
  }
  return out.slice(-MAX_ERRORS);
}

const SETTING_KEYS = ['enabled', 'engineMode', 'mtBackend', 'voice', 'systemVoiceName', 'speakerVoices', 'voice2', 'voice3', 'voice4',
  'speakerCount', 'voiceBlend', 'genderVoices', 'favFemale', 'favMale', 'style', 'pitch', 'quality', 'holdStart',
  'ttsSpeed', 'ttsVolume', 'originalVolume', 'lookaheadSec', 'showSubtitles', 'modelsApproved', 'checkUpdates'];

const iso = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * @param {{ version:string, browser:string, platform:string, settings:object, status?:object,
 *           models?:{ name:string, sizeMB:number }[], errors?:object[], glossary?:{ mt:number, tts:number },
 *           timings?:{ at:number, line:string }[],
 *           now?:number }} d
 */
export function buildReport(d) {
  const L = [];
  L.push(`LocaDub ${d.version} · ${d.browser} · ${d.platform}`);
  L.push(`Rapor: ${iso(d.now ?? Date.now())}`);
  L.push('', '[Ayarlar]');
  for (const k of SETTING_KEYS) if (d.settings && k in d.settings) L.push(`${k}: ${JSON.stringify(d.settings[k])}`);
  if (d.glossary) L.push(`sözlük: ${d.glossary.mt} çeviri düzeltmesi, ${d.glossary.tts} okunuş`);
  L.push('', '[Motorlar]');
  const st = d.status;
  if (!st) L.push('durum okunamadı');
  else {
    const one = (name, s) => `${name}: ${s?.ready ? 'hazır' : s?.loading ? 'yükleniyor' : 'yüklü değil'}` +
      `${s?.backend || s?.voice ? ` (${s.backend || s.voice})` : ''}${s?.error ? ` — hata: ${scrub(s.error)}` : ''}`;
    L.push(one('çeviri', st.mt), one('ses', st.tts));
    L.push(`crossOriginIsolated: ${!!st.crossOriginIsolated} · WebGPU: ${!!st.webgpu} · çekirdek: ${st.hardwareConcurrency ?? '?'}`);
  }
  L.push('', '[İndirilen modeller]');
  if (!d.models?.length) L.push('yok');
  for (const m of d.models || []) L.push(`${m.name}: ${m.sizeMB.toFixed(1)} MB`);
  L.push('', `[Başlangıç süreleri (${d.timings?.length || 0})]`);
  if (!d.timings?.length) L.push('yok');
  for (const t of d.timings || []) L.push(`${iso(t.at)} ${t.line}`);
  L.push('', `[Son hatalar (${d.errors?.length || 0})]`);
  if (!d.errors?.length) L.push('yok');
  for (const e of d.errors || []) L.push(`${iso(e.at)} ${e.source}${e.count > 1 ? ` ×${e.count}` : ''}: ${e.message}`);
  return L.join('\n');
}
