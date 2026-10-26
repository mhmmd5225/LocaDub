// Input clean-up for YouTube captions (manual and automatic) before EN -> TR translation, and
// output tidy-up after. Pure functions; shared by every backend and tested in Node (tests/mt).
//
//  - Sound tags such as "[Music]", "[Applause]", "(laughs)" become Turkish tags ("[Müzik]") without
//    going through the model; unknown "[...]" tags are translated and kept in brackets.
//  - YouTube ASR quirks: "[ __ ]" (masked profanity), ">>" speaker changes, fillers ("um", "uh"),
//    stutters ("the the"), lower-case "i", no punctuation. We capitalise the first letter and add a
//    full stop (or a question mark for obvious questions) so Marian sees sentence-like input.
//  - "♪ lyrics ♪" are translated and the notes kept.
//  - Very long unpunctuated runs are cut into chunks (Marian degrades past ~50 words).
//
// Output convention (for the TTS / overlay): sound tags are always in [square brackets] and music
// notes are "♪"; a TTS should skip both.

const TAGS = {
  music: 'Müzik',
  'music playing': 'Müzik çalıyor',
  'upbeat music': 'Hareketli müzik',
  'soft music': 'Yumuşak müzik',
  'gentle music': 'Hafif müzik',
  'dramatic music': 'Dramatik müzik',
  'intense music': 'Gerilimli müzik',
  'suspenseful music': 'Gerilimli müzik',
  'sad music': 'Hüzünlü müzik',
  'background music': 'Arka plan müziği',
  'music continues': 'Müzik devam ediyor',
  'music ends': 'Müzik bitiyor',
  'music stops': 'Müzik duruyor',
  'instrumental music': 'Enstrümantal müzik',
  applause: 'Alkış',
  applauding: 'Alkış',
  clapping: 'Alkış',
  'audience applauding': 'Seyirciler alkışlıyor',
  laughter: 'Kahkahalar',
  'audience laughing': 'Seyirciler gülüyor',
  laughs: 'Gülüyor',
  laughing: 'Gülüyor',
  chuckles: 'Kıkırdıyor',
  chuckling: 'Kıkırdıyor',
  giggles: 'Kıkırdıyor',
  giggling: 'Kıkırdıyor',
  cheering: 'Tezahürat',
  cheers: 'Tezahürat',
  'crowd cheering': 'Kalabalık tezahürat ediyor',
  silence: 'Sessizlik',
  inaudible: 'Anlaşılmıyor',
  indistinct: 'Anlaşılmıyor',
  'indistinct chatter': 'Anlaşılmayan konuşmalar',
  'indistinct talking': 'Anlaşılmayan konuşmalar',
  crosstalk: 'Üst üste konuşma',
  foreign: 'Yabancı dil',
  'speaking foreign language': 'Yabancı dilde konuşuyor',
  'non english speech': 'Yabancı dilde konuşma',
  noise: 'Gürültü',
  'background noise': 'Arka plan gürültüsü',
  static: 'Parazit',
  sighs: 'İç çekiyor',
  sighing: 'İç çekiyor',
  coughs: 'Öksürüyor',
  coughing: 'Öksürüyor',
  gasps: 'Şaşkınlıkla soluyor',
  screams: 'Çığlık atıyor',
  screaming: 'Çığlıklar',
  whistling: 'Islık',
  whistles: 'Islık çalıyor',
  singing: 'Şarkı söylüyor',
  sings: 'Şarkı söylüyor',
  'sound effect': 'Ses efekti',
  'sound effects': 'Ses efektleri',
  beeping: 'Bip sesi',
  beep: 'Bip',
  'bell rings': 'Zil çalıyor',
  'phone ringing': 'Telefon çalıyor',
  'phone rings': 'Telefon çalıyor',
  'door opens': 'Kapı açılıyor',
  'door closes': 'Kapı kapanıyor',
  'door slams': 'Kapı çarpıyor',
  'knocking': 'Kapı çalınıyor',
  footsteps: 'Ayak sesleri',
  explosion: 'Patlama',
  thunder: 'Gök gürültüsü',
  'birds chirping': 'Kuş cıvıltıları',
  'dog barking': 'Köpek havlıyor',
  'engine revving': 'Motor sesi',
  groans: 'İnliyor',
  grunts: 'Homurdanıyor',
  sniffs: 'Burnunu çekiyor',
  crying: 'Ağlıyor',
  sobbing: 'Hıçkırıyor',
  breathing: 'Nefes sesi',
  'heavy breathing': 'Derin nefes alıyor',
  exhales: 'Nefes veriyor',
  inhales: 'Nefes alıyor',
  // Whisper-style placeholders: dropped.
  blank_audio: '',
  'blank audio': '',
  'no audio': '',
  'no speech': '',
};

const tagKey = (s) => s.toLowerCase().replace(/[^a-z_ ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Turkish tag for a known sound tag ("Music", "(laughs)"), '' for placeholders, undefined if unknown. */
export function soundTag(inner) {
  const k = tagKey(inner);
  if (k in TAGS) return TAGS[k];
  // "music playing softly", "laughs nervously": fall back on the first known word pair/word.
  const words = k.split(' ');
  if (words.length > 1 && `${words[0]} ${words[1]}` in TAGS) return TAGS[`${words[0]} ${words[1]}`];
  if (words.length > 1 && words[0] in TAGS && TAGS[words[0]]) return TAGS[words[0]];
  return undefined;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeEntities(s) {
  return s
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_m, e) => ENTITIES[e])
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)));
}

const SLANG = [
  [/\bgonna\b/gi, 'going to'],
  [/\bwanna\b/gi, 'want to'],
  [/\bgotta\b/gi, 'got to'],
  [/\bkinda\b/gi, 'kind of'],
  [/\bsorta\b/gi, 'sort of'],
  [/\blemme\b/gi, 'let me'],
  [/\bgimme\b/gi, 'give me'],
  [/\bdunno\b/gi, "don't know"],
  [/\boutta\b/gi, 'out of'],
  [/(^|\s)'?(?:cause|cuz|coz)\b/gi, '$1because'],
  [/\by'know\b/gi, 'you know'],
  [/\bya know\b/gi, 'you know'],
  [/\bok\b/g, 'okay'],
];

const FILLERS = /(^|[\s,])(?:u+m+|u+h+m*|e+r+m+|e+r+|h+m+|m+h+m+|m{2,})(?=[\s,.!?]|$)[,]?/gi;
const STUTTER = /^(the|a|an|i|i'm|and|to|of|in|on|it|it's|is|we|you|so|but|or|this|my|for|with|be|was|are|if|they|he|she|what|like)$/i;
const AUX = "(?:do|does|did|is|are|was|were|can|could|would|will|should|shall|have|has|may|might|am|isn't|aren't|don't|doesn't|didn't|can't|won't|wouldn't|couldn't|shouldn't|haven't|hasn't|wasn't|weren't)";
const PRON = '(?:you|we|they|i|he|she|it|there|this|that|these|those|anyone|anybody|someone|everyone)';
const WH = '(?:what|why|how|where|when|who|which|whose)';
const QUESTION = new RegExp(`^(?:${AUX}\\s+${PRON}\\b|${WH}(?:\\s+(?:much|many|long|often|far|old|kind of|else))?\\s+(?:${AUX}|'s|'re)\\b|${WH}'s\\b|right$)`, 'i');

const capFirst = (s) => s.replace(/^(\P{L}*)(\p{L})/u, (_m, pre, c) => pre + c.toUpperCase());
const capFirstTr = (s) => s.replace(/^(\P{L}*)(\p{L})/u, (_m, pre, c) => pre + c.toLocaleUpperCase('tr-TR'));

/**
 * Cleans one span of caption text (no tags) so it reads like a sentence.
 * @param {string} s
 * @param {{sentence?:boolean}} [o]  sentence=false: no terminal punctuation (bracket content)
 */
export function cleanText(s, { sentence = true } = {}) {
  let t = ` ${s} `;
  t = t.replace(FILLERS, '$1');
  for (const [re, rep] of SLANG) t = t.replace(re, rep);
  // ASR stutters on function words: "the the", "i i i", "and and" (not "no no", "bye bye", "la la").
  t = t.replace(/\b([\p{L}']+)(?:\s+\1\b)+/giu, (m, w) => (STUTTER.test(w) ? w : m));
  t = t.replace(/\bi\b/g, 'I');
  t = t.replace(/\s+([,.!?;:])/g, '$1').replace(/([,.!?;:]){2,}/g, (m) => (m.includes('...') ? '...' : m[0]));
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/^[,.;:!?\-–—\s]+/, '').replace(/[,;:\-–—\s]+$/, '');
  if (!t || !/[\p{L}\p{N}]/u.test(t)) return '';
  t = capFirst(t);
  if (sentence && !/[.!?…]["'”’)\]]*$/.test(t)) t += QUESTION.test(t) ? '?' : '.';
  return t;
}

const MAX_WORDS = 45;
const BREAK_BEFORE = /^(and|but|so|because|then|which|when|while|if|or|since|although|though|until|unless|whereas)$/i;

/** Splits very long text into chunks of at most MAX_WORDS words at a sensible place. */
export function chunkLong(text) {
  const words = text.split(' ');
  if (words.length <= MAX_WORDS) return [text];
  const out = [];
  let start = 0;
  while (words.length - start > MAX_WORDS) {
    const ideal = start + Math.min(Math.ceil((words.length - start) / Math.ceil((words.length - start) / 35)), MAX_WORDS);
    let cut = -1;
    for (let d = 0; d <= 12 && cut < 0; d++) {
      for (const i of [ideal - d, ideal + d]) {
        if (i <= start + 8 || i >= words.length - 3 || i - start > MAX_WORDS) continue;
        if (/[,;:.!?]$/.test(words[i - 1]) || BREAK_BEFORE.test(words[i])) { cut = i; break; }
      }
    }
    if (cut < 0) cut = Math.min(ideal, start + MAX_WORDS);
    out.push(words.slice(start, cut).join(' '));
    start = cut;
  }
  out.push(words.slice(start).join(' '));
  return out;
}

/**
 * Splits one caption sentence into parts: literal Turkish tags and spans to translate.
 * @returns {{parts:({lit:string}|{mt:string, bracket?:boolean})[], note:boolean}}
 */
export function analyze(raw) {
  let s = decodeEntities(String(raw ?? ''))
    .replace(/[‘’‛ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[​-‍﻿]/g, '')
    // Not in the opus-mt vocabulary (would become <unk>): dashes, ellipsis, most accented letters.
    .replace(/\s*[–—―]\s*/g, ' - ')
    .replace(/…/g, '...')
    .replace(/[\p{L}][̀-ͯ]*/gu, (c) => (/[çşğöüÇŞĞÖÜ]/.test(c.normalize('NFC')) ? c : c.normalize('NFD').replace(/[̀-ͯ]/g, '')))
    .replace(/\s+/g, ' ');
  s = s.replace(/\[\s*_+\s*\]/g, ' '); // YouTube's masked profanity
  s = s.replace(/(^|\s)>>+\s*/g, ' ').replace(/^\s*[-–—]\s+/, '');
  const note = /[♪♫♬]/.test(s);
  s = s.replace(/[♪♫♬]+/g, ' ').trim();

  const parts = [];
  const re = /\[([^\]]*)\]|\(([^)]*)\)/g;
  let last = 0;
  let m;
  const pushText = (txt) => {
    const t = txt.trim();
    if (t) for (const chunk of chunkLong(t)) parts.push({ raw: chunk });
  };
  while ((m = re.exec(s))) {
    const inner = (m[1] ?? m[2]).trim();
    const known = soundTag(inner);
    if (m[2] !== undefined && known === undefined) continue; // ordinary parenthesis: leave in the text
    pushText(s.slice(last, m.index));
    last = re.lastIndex;
    if (known !== undefined) {
      if (known) parts.push({ lit: `[${known}]` });
    } else if (inner) {
      const t = cleanText(inner, { sentence: false });
      if (t) parts.push({ mt: t, bracket: true });
    }
  }
  pushText(s.slice(last));
  for (const p of parts) {
    if ('raw' in p) {
      p.mt = cleanText(p.raw);
      delete p.raw;
    }
  }
  return { parts: parts.filter((p) => p.lit || p.mt), note };
}

/** Tidies a Turkish translation. */
export function tidyTurkish(s, { bracket = false } = {}) {
  let t = String(s ?? '').replace(/[’‘ʼ]/g, "'").replace(/\s+/g, ' ').trim();
  t = t.replace(/\s+([,.!?;:…])/g, '$1').replace(/([(\[«"])\s+/g, '$1');
  if (bracket) t = t.replace(/[.!]+$/, '');
  return capFirstTr(t);
}

/**
 * Prepares a batch: the unique spans to translate and how to put the results back together.
 * @param {string[]} sentences
 * @returns {{units:string[], plan:ReturnType<typeof analyze>[] & any}}
 */
export function prepareBatch(sentences) {
  const units = [];
  const index = new Map();
  const plan = sentences.map((s) => {
    const a = analyze(s);
    for (const p of a.parts) {
      if (!p.mt) continue;
      if (!index.has(p.mt)) {
        index.set(p.mt, units.length);
        units.push(p.mt);
      }
      p.unit = index.get(p.mt);
    }
    return a;
  });
  return { units, plan };
}

/** Puts translated units back into sentences (same length/order as the input to prepareBatch). */
export function finishBatch(plan, translations) {
  return plan.map(({ parts, note }) => {
    const out = parts
      .map((p) => {
        if (p.lit) return p.lit;
        const t = tidyTurkish(translations[p.unit], { bracket: p.bracket });
        return t && p.bracket ? `[${t}]` : t;
      })
      .filter(Boolean)
      .join(' ');
    if (note) return out ? `♪ ${out} ♪` : '♪';
    return out;
  });
}
