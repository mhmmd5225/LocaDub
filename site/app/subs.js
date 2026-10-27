// Kullanıcının verdiği İngilizce altyazıyı cümlelere çevirir (DOM yok; node testleriyle sınanır).
// Desteklenen biçimler: YouTube transkript paneli metni (yapıştırma), SRT, WebVTT, YouTube json3.
// Çıktı: mergeSentences ile aynı → [{ start, end, text }] (saniye).

import { parseJson3, mergeSentences, cleanText } from './ext/content/captions.js';

// "1:02:03.500", "02:03,5", "2:03" → ms
function clockMs(s) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(String(s).trim());
  if (!m) return NaN;
  const frac = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
  return ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + frac;
}

const stripTags = (s) => s.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '');

// SRT ve WebVTT: "00:00:01,000 --> 00:00:04,000" satırlı bloklar.
export function parseTimedBlocks(text) {
  const blocks = String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const cues = [];
  let prevLines = [];
  for (const b of blocks) {
    const lines = b.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [a, z] = lines[at].split('-->').map((x) => x.trim().split(/\s+/)[0]);
    const start = clockMs(a), end = clockMs(z);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    let body = lines.slice(at + 1).map((l) => stripTags(l).trim()).filter(Boolean);
    // YouTube'un otomatik VTT'si her parçada bir önceki satırı tekrarlar ("kayan" altyazı).
    while (body.length && prevLines.includes(body[0])) body.shift();
    if (body.length) prevLines = body;
    if (!body.length || end - start < 50) continue;
    const raw = body.join(' ');
    cues.push({ start, end, text: raw, speakerChange: /^\s*(>>|-\s)/.test(raw) });
  }
  return cues;
}

// YouTube "Transkripti göster" panelinden kopyalanan metin:
//   0:00            ya da   0:00 Metin
//   Metin
// Ekran okuyucu satırları ("5 saniye", "1 minute, 2 seconds") atlanır.
const TS_ONLY = /^(?:\d+:)?\d{1,2}:\d{2}$/;
const TS_LEAD = /^((?:\d+:)?\d{1,2}:\d{2})\s+(.+)$/;
const SPOKEN_TIME = /^(\d+\s*(saniye|dakika|saat|seconds?|minutes?|hours?)\s*(,|ve|and)?\s*)+$/i;

export function parseTranscript(text) {
  const entries = [];
  let cur = null;
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const l = line.trim();
    if (!l) continue;
    if (TS_ONLY.test(l)) {
      cur = { start: clockMs(l), parts: [] };
      entries.push(cur);
      continue;
    }
    const lead = TS_LEAD.exec(l);
    if (lead && Number.isFinite(clockMs(lead[1]))) {
      cur = { start: clockMs(lead[1]), parts: [lead[2]] };
      entries.push(cur);
      continue;
    }
    if (!cur || SPOKEN_TIME.test(l)) continue;
    cur.parts.push(l);
  }
  const list = entries.filter((e) => e.parts.length && Number.isFinite(e.start)).sort((a, b) => a.start - b.start);
  return list.map((e, i) => {
    const next = list[i + 1];
    // Bitiş: bir sonraki satırın başı; son satır ve uzun boşluklar metin uzunluğuyla sınırlanır.
    const est = Math.max(1500, e.parts.join(' ').length * 70);
    const end = next ? Math.min(next.start, e.start + Math.max(est, 6000)) : e.start + est;
    const raw = e.parts.join(' ');
    return { start: e.start, end: Math.max(end, e.start + 1), text: raw, speakerChange: /^\s*(>>|-\s)/.test(raw) };
  });
}

export function detectFormat(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (t.startsWith('{')) return 'json3';
  if (/^WEBVTT/.test(t) || /\d{1,2}:\d{2}[.,]\d{1,3}\s*-->/.test(t)) return 'timed';
  if (/(^|\n)\s*(?:\d+:)?\d{1,2}:\d{2}(\s|$)/.test(t)) return 'transcript';
  return null;
}

// → { sentences, format } ; tanınmazsa Error.
export function parseSubtitles(text) {
  const format = detectFormat(text);
  let cues;
  if (format === 'json3') {
    let json;
    try { json = JSON.parse(text); } catch { throw new Error('JSON altyazı okunamadı.'); }
    cues = parseJson3(json);
  } else if (format === 'timed') {
    cues = parseTimedBlocks(text);
  } else if (format === 'transcript') {
    cues = parseTranscript(text);
  } else {
    throw new Error('Altyazı biçimi tanınmadı. Zaman damgalı transkript, .srt, .vtt ya da json3 bekleniyor.');
  }
  // json3 cleanText'i kendisi uygular; diğerleri için ses etiketlerini ([Music] vb.) temizle.
  if (format !== 'json3') {
    cues = cues.map((c) => ({ ...c, text: cleanText(c.text) })).filter((c) => c.text);
  }
  const sentences = mergeSentences(cues);
  if (!sentences.length) throw new Error('Altyazıda okunabilir cümle bulunamadı.');
  return { sentences, format };
}
