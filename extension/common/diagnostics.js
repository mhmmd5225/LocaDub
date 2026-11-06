// Tanılama: son hatalar (halka tampon) ve kullanıcının sorun bildirirken kopyalayacağı rapor (saf; node testleriyle sınanır).
// Gizlilik: rapora video kimliği, YouTube adresi, altyazı ya da çeviri metni girmez; sözlükten yalnızca kural sayısı.

import { integratedHint } from './gpu.js';
export const MAX_ERRORS = 50;

// YouTube adreslerini ve video kimliklerini siler; model (HuggingFace) adresleri kalır.
export function scrub(text) {
  return String(text ?? '')
    .replace(/https?:\/\/(?:[\w-]+\.)*(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\/\S*/gi, '<youtube-adresi>')
    .replace(/\b(v|videoId)([=:]\s*)[\w-]{11}\b/g, '$1$2…')
    .slice(0, 500);
}

/**
 * Yeni hatayı ekler: aynı (kaynak, ileti) daha önce varsa (ardışık olmasa da) tek kayıtta sayılır ve en sona alınır;
 * en fazla MAX_ERRORS kayıt döner.
 */
export function pushError(list, { source, message, at = Date.now() }) {
  const msg = scrub(message);
  const src = String(source || '?');
  const out = Array.isArray(list) ? list.slice() : [];
  const i = out.findIndex((e) => e.source === src && e.message === msg);
  if (i >= 0) {
    const [prev] = out.splice(i, 1);
    out.push({ ...prev, at, count: (prev.count || 1) + 1 });
  } else {
    out.push({ at, source: src, message: msg });
  }
  return out.slice(-MAX_ERRORS);
}

const SETTING_KEYS = ['enabled', 'engineMode', 'mtBackend', 'voice', 'systemVoiceName', 'speakerVoices', 'voice2', 'voice3', 'voice4',
  'speakerCount', 'voiceBlend', 'genderVoices', 'matchVoices', 'favFemale', 'favMale', 'style', 'pitch', 'quality', 'holdStart', 'separation', 'sepBackend', 'sepQuality', 'gpuPreference', 'prebufferSec',
  'ttsSpeed', 'ttsVolume', 'originalVolume', 'lookaheadSec', 'showSubtitles', 'modelsApproved', 'checkUpdates'];

const iso = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');

const num = (v) => (Number.isFinite(v) ? v : null);
const sn = (v) => `${Math.round(v * 10) / 10}`.replace(/\.0$/, '');

/**
 * [Ses ayırma] satırları. sep: null/undefined → açık YouTube sekmesi yok; { off:true } → kapalı;
 * değilse son durum { status, backend, model, aheadSec, rtf, batch, chunkSec, streaming, holds, holdMs, lastError }.
 */
export function separationLines(sep) {
  if (!sep) return ['yok (açık YouTube sekmesi yok)'];
  if (sep.off || !sep.status || sep.status === 'off') return ['kapalı'];
  const a = [`durum: ${sep.status}`, `arka uç: ${scrub(sep.backend || '?')}`, `model: ${scrub(sep.model || '?')}`];
  if (num(sep.batch) != null) a.push(`toplu: ${sep.batch}`);
  if (num(sep.chunkSec) != null) a.push(`parça: ${sn(sep.chunkSec)} sn`);
  if (typeof sep.streaming === 'boolean') a.push(`akış: ${sep.streaming ? 'evet' : 'hayır'}`);
  const b = [];
  if (num(sep.rtf) > 0) b.push(`hız: ${sep.rtf.toFixed(2)} rtf (${(1 / sep.rtf).toFixed(1)}× gerçek zaman)`);
  else b.push('hız: ölçülmedi');
  if (num(sep.aheadSec) != null) b.push(`ileride hazır: ${sep.aheadSec.toFixed(1)} sn`);
  const c = [];
  if (num(sep.holds) != null) c.push(`bekleme: ${sep.holds} kez, toplam ${Math.round((num(sep.holdMs) || 0) / 1000)} sn`);
  c.push(`son hata: ${sep.lastError ? scrub(sep.lastError) : 'yok'}`);
  const out = [a.join(' · '), b.join(' · '), c.join(' · ')];
  if (sep.gpuAdapter) out.push(`ekran kartı: ${scrub(sep.gpuAdapter)}`);
  if (num(sep.rtf) > 1.2 && sep.status !== 'error') out.push(`öneri: ayırma yetişemiyor (${sep.rtf.toFixed(1)} rtf); ayarlarda 'Hızlı' ayırma kalitesini ya da WebNN (NPU/GPU) arka ucunu deneyin`);
  if (sep.backend === 'webgpu' && integratedHint(sep.gpuAdapter, num(sep.rtf))) out.push('uyarı: Intel ekran kartı kullanılıyor ve ayırma yetişemiyor; dizüstünüzde harici kart varsa chrome://flags/#force-high-performance-gpu bayrağını Etkin yapıp Chrome\'u yeniden başlatın (Chrome Windows\'ta WebGPU kart tercihini yok sayar)');
  if (sep.autoPick) {
    const a = sep.autoPick;
    const ms = a.cached ? 'önceki ölçüm' : `WebGPU ${a.webgpu ?? '?'} ms/pencere · WebNN-GPU ${a.webnn ?? 'kurulamadı'}${a.webnn != null ? ' ms/pencere' : ''}`;
    out.push(`otomatik kart seçimi: ${a.chosen === 'webnn' ? 'WebNN-GPU (harici kart olabilir)' : 'WebGPU'} (${ms})${a.reason ? ' — ' + scrub(a.reason) : ''}`);
  }
  if (sep.webnn?.requested) {
    const w = sep.webnn;
    out.push(`webnn (${scrub(w.device || 'npu')}): ${w.used ? 'kullanıldı' : `kullanılamadı${w.step ? ` (${scrub(w.step)} adımı)` : ''}${w.reason ? ' — ' + scrub(w.reason) : ''}`}`);
  }
  if (sep.fallbackReason) out.push(`ekran kartı sorunu: ${scrub(sep.fallbackReason)}`);
  return out;
}

const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

/**
 * [Bellek] satırları. sep: diag.separation cevabı (kapalıyken de { off, memory }); memory: { sentences, blobs, audioSec, heapMB,
 * packetBytes, packets, pcmBytes, sepSec, origSec } (ayırma alanları yalnız ayırma varken).
 */
export function memoryLines(sep) {
  const m = sep?.memory;
  if (!m) return ['yok (açık YouTube sekmesi yok)'];
  const a = [];
  if (num(m.heapMB) != null) a.push(`JS yığını: ${m.heapMB} MB`);
  a.push(`cümle: ${m.sentences ?? 0}`, `cümle sesi: ${m.blobs ?? 0} blob, ${sn(m.audioSec || 0)} sn`);
  const L = [a.join(' · ')];
  if (m.longTasks) L.push(`ana iş parçacığı takılmaları (>50 ms): ${m.longTasks.n} kez, toplam ${sn((m.longTasks.ms || 0) / 1000)} sn, en uzun ${m.longTasks.max || 0} ms`);
  if (num(m.packetBytes) != null) {
    L.push([`ayırma paketleri: ${mb(m.packetBytes)} (${m.packets ?? 0} paket)`, `ayrılmış PCM: ${sn(m.sepSec || 0)} sn`,
      `orijinal PCM: ${sn(m.origSec || 0)} sn`, `PCM belleği: ${mb(m.pcmBytes || 0)}`,
      `GPU hız sınırı beklemesi: ${sn(m.paceIdleSec || 0)} sn`].join(' · '));
  }
  return L;
}

/**
 * @param {{ version:string, browser:string, platform:string, settings:object, status?:object,
 *           models?:{ name:string, sizeMB:number }[], errors?:object[], glossary?:{ mt:number, tts:number },
 *           timings?:{ at:number, line:string }[], separation?:object|null, bench?:string[], benchAt?:number,
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
    L.push(`crossOriginIsolated: ${!!st.crossOriginIsolated} · WebGPU API: ${st.webgpu ? 'var' : 'yok'} · WebNN API: ${st.webnn ? 'var' : 'yok'} · çekirdek: ${st.hardwareConcurrency ?? '?'}`);
  }
  L.push('', '[Ses ayırma]', ...separationLines(d.separation));
  L.push('', '[Bellek]', ...memoryLines(d.separation));
  if (d.bench?.length) L.push('', `[Hız testi${d.benchAt != null ? ` (${iso(d.benchAt)})` : ''}]`, ...d.bench.map((l) => scrub(String(l))));
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
