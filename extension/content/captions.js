// Saf altyazı mantığı (DOM/chrome yok; node testleriyle sınanır).
// - pickTrack: İngilizce parça seçimi (manuel > otomatik)
// - buildJson3Url / mergeTimedTextParams: timedtext URL'si
// - parseJson3: YouTube json3 → zamanlı parçalar (cue)
// - mergeSentences: parçaları cümlelere birleştirme

const isEnglish = (code) => /^en(\b|[-_])/i.test(String(code || '')) || String(code || '').toLowerCase() === 'en';

function trackName(t) {
  if (!t?.name) return '';
  if (typeof t.name === 'string') return t.name;
  if (t.name.simpleText) return t.name.simpleText;
  if (Array.isArray(t.name.runs)) return t.name.runs.map((r) => r.text).join('');
  return '';
}

// captionTracks → { track, kind:'manual'|'asr'|'translated', tlang? } | null
export function pickTrack(tracks, { allowTranslated = true } = {}) {
  if (!Array.isArray(tracks) || !tracks.length) return null;
  const en = tracks.filter((t) => t && t.baseUrl && isEnglish(t.languageCode));
  const manual = en.filter((t) => t.kind !== 'asr');
  const score = (t) => {
    let s = 0;
    const code = String(t.languageCode).toLowerCase();
    if (code === 'en') s += 3; else if (code === 'en-us') s += 2; else if (code === 'en-gb') s += 1;
    if (t.isDefault) s += 0.5;
    if (/\b(sdh|cc)\b/i.test(trackName(t))) s -= 0.2; // SDH: ses etiketleri fazla
    return s;
  };
  const best = (arr) => arr.slice().sort((a, b) => score(b) - score(a))[0];
  if (manual.length) return { track: best(manual), kind: 'manual' };
  const asr = en.filter((t) => t.kind === 'asr');
  if (asr.length) return { track: best(asr), kind: 'asr' };
  if (allowTranslated) {
    // İngilizce yoksa: YouTube'un sunucu tarafı çevirisiyle (tlang=en) başka dil.
    const tr = tracks.find((t) => t && t.baseUrl && t.isTranslatable && t.kind !== 'asr') ||
      tracks.find((t) => t && t.baseUrl && t.isTranslatable);
    if (tr) return { track: tr, kind: 'translated', tlang: 'en' };
  }
  return null;
}

// baseUrl'e fmt=json3 (ve gerekirse tlang) ekler.
export function buildJson3Url(baseUrl, { tlang, origin = 'https://www.youtube.com' } = {}) {
  const u = new URL(baseUrl, origin);
  u.searchParams.set('fmt', 'json3');
  if (tlang) u.searchParams.set('tlang', tlang); else u.searchParams.delete('tlang');
  return u.toString();
}

// Oynatıcının kendi isteğinden (pot vb.) eksik parametreleri baseUrl'e taşır.
// Parça kimliği parametreleri (lang, kind, name, tlang, fmt, v) baseUrl'den korunur.
const TRACK_KEYS = new Set(['lang', 'kind', 'name', 'tlang', 'fmt', 'v']);
export function mergeTimedTextParams(baseUrl, capturedUrl, { origin = 'https://www.youtube.com' } = {}) {
  const base = new URL(baseUrl, origin);
  const cap = new URL(capturedUrl, origin);
  for (const [k, v] of cap.searchParams) {
    if (TRACK_KEYS.has(k)) continue;
    if (!base.searchParams.has(k) || k === 'pot' || k === 'potc') base.searchParams.set(k, v);
  }
  return base.toString();
}

// Ses etiketleri ve gereksiz boşlukları temizler.
export function cleanText(s) {
  return String(s || '')
    .replace(/\[[^\]]*\]|\([^)]*(music|applause|laughter|laughs|inaudible)[^)]*\)/gi, ' ')
    .replace(/[♪♫]+/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s*>>\s*/g, ' ') // konuşmacı değişimi işareti
    .replace(/\s+/g, ' ')
    .trim();
}

// json3 → [{ start, end, text }] (ms). ASR'de kelime bazında, manuelde olay bazında.
export function parseJson3(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const events = Array.isArray(data?.events) ? data.events : [];
  const words = [];
  for (const ev of events) {
    if (!Array.isArray(ev.segs)) continue;
    const t0 = Number(ev.tStartMs) || 0;
    const dur = Number(ev.dDurationMs) || 0;
    const evEnd = t0 + dur;
    const segs = ev.segs.filter((s) => s && typeof s.utf8 === 'string');
    const hasOffsets = segs.some((s) => s.tOffsetMs !== undefined);
    if (hasOffsets && segs.length > 1) {
      // Otomatik altyazı: her seg bir kelime
      for (const s of segs) {
        const raw = s.utf8.replace(/\n/g, ' ');
        if (!raw.trim()) continue;
        words.push({ start: t0 + (Number(s.tOffsetMs) || 0), end: evEnd, text: raw, speakerChange: /^\s*>>/.test(raw) });
      }
    } else {
      const raw = segs.map((s) => s.utf8).join('').replace(/\n/g, ' ');
      if (!raw.trim()) continue;
      words.push({ start: t0, end: evEnd, text: raw, speakerChange: /^\s*(>>|-\s)/.test(raw) });
    }
  }
  words.sort((a, b) => a.start - b.start);
  // Kelime bitişini bir sonraki kelimenin başlangıcıyla sınırla (ASR olayları üst üste biner).
  for (let i = 0; i < words.length - 1; i++) {
    const nx = words[i + 1].start;
    if (words[i].end > nx && nx > words[i].start) words[i].end = nx;
    if (words[i].end <= words[i].start) words[i].end = Math.max(words[i].start + 1, nx);
  }
  const out = [];
  for (const w of words) {
    const text = cleanText(w.text);
    if (!text) continue;
    out.push({ start: w.start, end: Math.max(w.end, w.start + 1), text, ...(w.speakerChange ? { speakerChange: true } : {}) });
  }
  return out;
}

const ABBREV = /\b(mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|u\.s|u\.k|no|vol|fig|inc|ltd|co)\.$/i;
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;

function endsSentence(text) {
  const t = text.trim();
  if (!SENTENCE_END.test(t)) return false;
  if (ABBREV.test(t)) return false;
  if (/\b[A-Z]\.$/.test(t)) return false; // baş harf: "J."
  return true;
}

// Bir parçanın içindeki cümle sonlarında böler; zamanı karakter oranıyla dağıtır.
export function splitCue(c) {
  const pieces = [];
  for (const part of c.text.split(/(?<=[.!?…]["'”’)\]]*)\s+/)) {
    const s = part.trim();
    if (!s) continue;
    // Kısaltma/baş harf bitişiyse bir öncekiyle birleştir
    if (pieces.length && !endsSentence(pieces[pieces.length - 1])) pieces[pieces.length - 1] += ' ' + s;
    else pieces.push(s);
  }
  if (pieces.length <= 1) return [c];
  const total = pieces.reduce((n, p) => n + p.length, 0) || 1;
  const dur = c.end - c.start;
  let t = c.start;
  return pieces.map((p, i) => {
    const end = i === pieces.length - 1 ? c.end : Math.round(t + (dur * p.length) / total);
    const piece = { start: Math.round(t), end, text: p, ...(i === 0 && c.speakerChange ? { speakerChange: true } : {}) };
    t = end;
    return piece;
  });
}

// Konuşmacı sayacının döngüsü: 2, 3 ve 4'ün ortak katı. Ses = sayaç mod speakerCount (settings.js), böylece
// konuşmacı sayısı değişince önbellekteki cümleler yeniden kurulmaz; eski önbellekteki 0/1 değerleri de geçerli kalır.
export const SPEAKER_CYCLE = 12;

// Parçaları cümlelere birleştirir. Sonuç saniye cinsinden: [{ start, end, text, speaker? }]
// speaker: konuşmacı değişimi (>>) sayacı, her değişimde bir artar (mod SPEAKER_CYCLE); yalnızca 0 değilse yazılır.
// Altyazı kimin konuştuğunu söylemez: iki kişilik konuşmada 0 ↔ 1 doğru eşleşir, daha fazlasında sıra tahminidir.
export function mergeSentences(rawCues, { pauseMs = 700, maxMs = 12000, minSplitMs = 4000 } = {}) {
  const out = [];
  let cur = null;
  let speaker = 0;
  const cues = [];
  for (const c of rawCues || []) if (c && c.text) cues.push(...splitCue(c));
  const flush = () => {
    if (cur && cur.parts.length) {
      const text = cur.parts.join(' ').replace(/\s+([,.!?;:…])/g, '$1').replace(/\s+/g, ' ').trim();
      if (text) out.push({ start: cur.start / 1000, end: cur.end / 1000, text, ...(cur.speaker ? { speaker: cur.speaker } : {}) });
    }
    cur = null;
  };
  for (const c of cues || []) {
    if (!c || !c.text) continue;
    if (c.speakerChange) speaker = (speaker + 1) % SPEAKER_CYCLE;
    if (cur) {
      const gap = c.start - cur.end;
      const wouldBe = c.end - cur.start;
      if (gap > pauseMs || c.speakerChange) flush();
      else if (wouldBe > maxMs) {
        // Uzun cümle: son virgülde bölmeyi dene
        const idx = lastCommaSplit(cur, minSplitMs);
        if (idx > 0) {
          const head = { start: cur.start, end: cur.times[idx - 1].end, parts: cur.parts.slice(0, idx), times: cur.times.slice(0, idx), speaker: cur.speaker };
          const tail = { start: cur.times[idx].start, end: cur.end, parts: cur.parts.slice(idx), times: cur.times.slice(idx), speaker: cur.speaker };
          cur = head; flush(); cur = tail;
          if (c.end - cur.start > maxMs) flush();
        } else flush();
      }
    }
    if (!cur) cur = { start: c.start, end: c.end, parts: [], times: [], speaker };
    cur.parts.push(c.text);
    cur.times.push({ start: c.start, end: c.end });
    cur.end = Math.max(cur.end, c.end);
    if (endsSentence(c.text)) flush();
  }
  flush();
  return out;
}

function lastCommaSplit(cur, minSplitMs) {
  for (let i = cur.parts.length - 1; i > 0; i--) {
    if (/[,;:]$/.test(cur.parts[i - 1].trim()) && cur.times[i - 1].end - cur.start >= minSplitMs) return i;
  }
  return -1;
}
