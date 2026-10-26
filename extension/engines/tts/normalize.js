// Turkish text normalization for TTS: written Turkish (machine-translated from English YouTube captions) ->
// the way a Turkish speaker reads it aloud.
//
// The heavy lifting is trnorm (./trnorm/, generated from Harfiyen, MIT; originally ozguradmin/ahenk-turkish-tts,
// Apache-2.0): numbers ("3,5" -> üç buçuk, "1.250" -> bin iki yüz elli), ordinals ("3." -> üçüncü), "%20",
// times ("14:30'da" -> on dört otuzda), dates, money ("12,75 €"), units, abbreviations ("Dr.", "vb.", "TL"),
// phone numbers, URLs, acronyms ("AI" -> ey ay, "NASA" -> nasa) and suffix vowel harmony.
//
// This module adds what translated English subtitles bring in and trnorm does not cover:
//   - English number formats: "1,000,000" / "2,500 people" thousands commas, "1st/2nd/3rd/4th", "3 PM"
//   - more English acronyms read the English way (GPT, CPU, USB, ...)
//   - a lexicon of common English names and words left untranslated (Musk, SpaceX, New York ...)
//   - a conservative rule-based English -> Turkish respelling for other clearly-English words
//     (only ASCII words with letters/digraphs Turkish spelling never uses: w, x, q, th, sh, ch, ph, ck, ee, oo ...)

import { normalize as trnorm } from './trnorm/normalize.js';
import * as L from './trnorm/lexicon.js';
import { attachSuffix, ordinalToWords } from './trnorm/numbers.js';
import { trLower } from './trnorm/casing.js';

// ---------------------------------------------------------------- acronyms (read the English way)

const EXTRA_ACRONYMS = {
  GPT: 'ci pi ti', CPU: 'si pi yu', GPU: 'ci pi yu', USB: 'yu es bi', NFT: 'en ef ti', VR: 'vi ar',
  PC: 'pi si', DNA: 'di en ey', RNA: 'ar en ey', NBA: 'en bi ey', NFL: 'en ef el', MIT: 'em ay ti',
  UN: 'birleşmiş milletler', EU: 'avrupa birliği', BMW: 'be me ve', HBO: 'eyç bi o', ESPN: 'i es pi en',
  LLM: 'el el em', AGI: 'ey ci ay', ML: 'em el', iOS: 'ay o es', SQL: 'es kü el', AWS: 'ey dabılyu es',
  CEO: 'si i o', CTO: 'si ti o', CFO: 'si ef o', HR: 'eyç ar', PR: 'pi ar', DJ: 'di cey', FAQ: 'ef ey kü',
  WWII: 'ikinci dünya savaşı', WWI: 'birinci dünya savaşı', UFC: 'yu ef si', F1: 'formula bir',
  MVP: 'em vi pi', RPG: 'ar pi ci', FPS: 'ef pi es', PS5: 'pi es beş', PS4: 'pi es dört', NYC: 'nyu york',
  LA: 'el ey', UK: 'birleşik krallık', USA: 'amerika birleşik devletleri', US: 'amerika',
};
for (const [k, v] of Object.entries(EXTRA_ACRONYMS)) if (!Object.hasOwn(L.ACRONYMS, k)) L.ACRONYMS[k] = v;
// NB: trnorm's ACRONYMS is looked up at call time, so extending it here is enough.

// ---------------------------------------------------------------- English names / words left untranslated

/** Written form -> Turkish respelling. Matched case-insensitively for lowercase keys, exactly otherwise. */
export const ENGLISH_WORDS = {
  // people
  Elon: 'İlon', Musk: 'Mask', Steve: 'Stiv', Jobs: 'Cabs', Bill: 'Bil', Gates: 'Geyts', Zuckerberg: 'Zakırberg',
  Jeff: 'Cef', Bezos: 'Beyzos', Trump: 'Tramp', Biden: 'Baydın', Taylor: 'Teylır', Swift: 'Svift',
  Michael: 'Maykıl', Jackson: 'Cekson', John: 'Con', James: 'Ceyms', David: 'Deyvid', Smith: 'Smit',
  Johnson: 'Conson', Williams: 'Vilyıms', Brown: 'Braun', George: 'Corc', Charles: 'Çarlz', Peter: 'Pitır',
  Paul: 'Pol', Robert: 'Robırt', Richard: 'Riçırd', Thomas: 'Tomas', Altman: 'Oltmın', Jensen: 'Censın',
  Cook: 'Kuk', Pichai: 'Piçay', Warren: 'Vorın', Buffett: 'Bafit', Newton: 'Nyutın', Einstein: 'Aynştayn',
  Shakespeare: 'Şekspir', Joe: 'Co', Donald: 'Donıld', Ryan: 'Rayın',
  // places / organisations / products
  'New York': 'Nyu York', Washington: 'Vaşingtın', 'Los Angeles': 'Los Encılıs', 'San Francisco': 'San Fransisko',
  'Silicon Valley': 'Silikon Vadisi', Chicago: 'Şikago', Texas: 'Teksas', California: 'Kaliforniya',
  London: 'Londra', Hollywood: 'Holivud', Harvard: 'Harvırd', Stanford: 'Stenfırd', Oxford: 'Oksfırd',
  Cambridge: 'Keymbriç', SpaceX: 'Speyseks', Twitch: 'Tviç', TikTok: 'Tiktok', Reddit: 'Redit',
  Discord: 'Diskord', Steam: 'Stim', Minecraft: 'Maynkraft', Fortnite: 'Fortnayt', Roblox: 'Robloks',
  Sony: 'Soni', Boeing: 'Boing', Walmart: 'Volmart', Pixar: 'Piksar', Marvel: 'Marvıl', Batman: 'Betmen',
  Superman: 'Süpermen', 'Star Wars': 'Star Vors', 'Harry Potter': 'Heri Potır', Times: 'Tayms', Street: 'Strit',
  Wall: 'Vol', Journal: 'Cörnıl', 'White House': 'Beyaz Saray',
  // words that often survive translation
  okay: 'okey', wow: 'vav', cool: 'kul', baby: 'beybi', yeah: 'yea', hi: 'hay', bye: 'bay', thanks: 'tenks',
  sorry: 'sori', please: 'pliz', like: 'layk', subscribe: 'sabskrayb', share: 'şer', channel: 'çenıl',
  game: 'geym', gameplay: 'geympley', smartphone: 'smartfon', smartwatch: 'smartvaç', headset: 'hedset',
  keyboard: 'kiybord', mouse: 'maus', setup: 'setap', review: 'rivyu', unboxing: 'anboksing',
  tutorial: 'tutoriyıl', challenge: 'çelınç', prank: 'prenk', livestream: 'layvstrim', stream: 'strim',
  streamer: 'strimır', hashtag: 'heşteg', selfie: 'selfi', crypto: 'kripto', bitcoin: 'bitkoyn',
  blockchain: 'blokçeyn', machine: 'maşin', learning: 'lörning', deep: 'dip', chip: 'çip', chips: 'çips',
  'machine learning': 'maşin lörning', 'deep learning': 'dip lörning', 'open source': 'opın sors',
  The: 'Dı', the: 'dı', of: 'ov', and: 'end',
};

const escapeRe = (s) => s.replace(/[\^$\\.*+?()[\]{}|/]/g, '\\$&');
const W = '\\p{L}\\p{N}_';
const LET = 'A-Za-zÇĞİÖŞÜçğıöşüÂÎÛâîû';

function buildEnglish() {
  const table = new Map();
  for (const [k, v] of Object.entries(ENGLISH_WORDS)) {
    table.set(k, v);
    if (k === k.toLowerCase()) {
      // lowercase key: also Capitalized and ALL CAPS forms
      table.set(k[0].toUpperCase() + k.slice(1), v[0].toLocaleUpperCase('tr') + v.slice(1));
    }
  }
  // trnorm already knows some of these (Google, YouTube ...): let it handle those
  for (const k of Object.keys(L.FOREIGN_NAMES)) table.delete(k);
  const alt = [...table.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  const re = new RegExp(`(?<![${W}@./:'])(${alt})(?:'([${LET}]+))?(?![${W}]|'[^${LET}]|[./:][${W}])`, 'gu');
  return [table, re];
}
const [EN_TABLE, EN_RE] = buildEnglish();

function passEnglishWords(text) {
  return text.replace(EN_RE, (m, word, suf) => {
    const spoken = EN_TABLE.get(word);
    if (spoken === undefined) return m;
    return suf ? `${spoken}'${suf}` : spoken;
  });
}

// ---------------------------------------------------------------- rule-based English respelling

// "th"/"sh" only at a word edge: Turkish has them inside words (Fethiye, ishal, tashih)
const EN_MARKERS = /w|x|q|^th|th$|^sh|sh$|ch|ph|ck|ee|oo|ou|gh|tion|[^aeiou]y$/i;
const TR_LETTERS = /[çğıöşüÇĞİÖŞÜâîû]/;
const KNOWN_FOREIGN = new Set(Object.keys(L.FOREIGN_NAMES).map((k) => k.toLowerCase()));
// Turkish words that happen to contain a marker (keep them as written)
const TR_EXCEPTIONS = new Set(['saat', 'taahhüt', 'kooperatif', 'koordinat', 'zoologi', 'teessüf', 'vaat', 'temmuz']);

const RESPELL_RULES = [
  [/tion/g, 'şın'], [/sion/g, 'jın'], [/ture/g, 'çır'], [/ough/g, 'of'], [/augh/g, 'of'], [/igh/g, 'AY'],
  [/gh/g, ''], [/sch/g, 'ş'], [/sh/g, 'ş'], [/tch/g, 'ç'], [/ch/g, 'ç'], [/th/g, 't'], [/ph/g, 'f'], [/ck/g, 'k'],
  [/wh/g, 'v'], [/ew/g, 'yu'], [/qu/g, 'kv'], [/x/g, 'ks'], [/w/g, 'v'], [/q/g, 'k'], [/ee/g, 'i'], [/ea/g, 'i'], [/oo/g, 'u'],
  [/ou/g, 'au'], [/ey$/g, 'i'], [/ay/g, 'ey'], [/ai/g, 'ey'], [/oa/g, 'o'], [/c(?=[eiy])/g, 's'], [/c/g, 'k'],
  [/j/g, 'c'], [/(?<=[^aeiou])y(?=[^aeiou]|$)/g, 'i'], [/(?<=[^aeiou]{1}[aeiou][^aeiou])e$/g, ''], [/(.)\1/g, '$1'],
];

/** "Brooklyn" -> "Bruklin", "Wright" -> "Rayt"-ish: approximate, only for words that cannot be Turkish. */
export function respellEnglish(word) {
  let w = word.toLowerCase();
  if (w.startsWith('wr')) w = w.slice(1);
  if (w.startsWith('kn')) w = w.slice(1);
  for (const [re, to] of RESPELL_RULES) w = w.replace(re, to);
  w = w.toLowerCase(); // 'AY' (from igh) was protected from the ay -> ey rule
  if (!w) return word;
  return word[0] === word[0].toUpperCase() ? w[0].toLocaleUpperCase('tr') + w.slice(1) : w;
}

function looksEnglish(word) {
  if (word.length < 3 || TR_LETTERS.test(word) || !/^[A-Za-z]+$/.test(word)) return false;
  if (word === word.toUpperCase()) return false; // acronyms: trnorm spells them
  const low = word.toLowerCase();
  if (KNOWN_FOREIGN.has(low) || TR_EXCEPTIONS.has(low)) return false;
  return EN_MARKERS.test(low);
}

function passEnglishRespell(text) {
  return text.replace(new RegExp(`(?<![${W}@./:'])([A-Za-z]+)(?=('[${LET}]+)?(?![${W}]|[./:][${W}]))`, 'gu'), (m, word) =>
    looksEnglish(word) ? respellEnglish(word) : m,
  );
}

// ---------------------------------------------------------------- English number formats

// "1,000,000" / "2,500 kişi" (English thousands) -> "1.000.000" so trnorm reads a whole number.
// Not when followed by another comma-number ("1,2,3" lists) or a decimal tail.
const EN_THOUSANDS_RE = /(?<![\d.,])(\d{1,3})((?:,\d{3})+)(?![\d]|[.,]\d)/g;
// "1st", "22nd", "3rd", "4th" -> ordinal words
const EN_ORDINAL_RE = /(?<![\p{L}\p{N}])(\d{1,4})(st|nd|rd|th)(?![\p{L}\p{N}])/giu;
// "3 PM", "10:30 a.m." -> "öğleden sonra 3", "öğleden önce 10:30"
const AMPM_RE = /(?<![\p{L}\p{N}])(\d{1,2}(?::\d{2})?)\s?([AaPp])\.?\s?[Mm]\.?(?![\p{L}\p{N}])/gu;

function passEnglishNumbers(text) {
  // a lone "3,141" could be a Turkish decimal, but in text translated from English thousands are far likelier
  text = text.replace(EN_THOUSANDS_RE, (m, head, groups) => head + groups.replace(/,/g, '.'));
  text = text.replace(EN_ORDINAL_RE, (m, n) => ordinalToWords(BigInt(n)));
  text = text.replace(AMPM_RE, (m, t, ap) => `${ap.toLowerCase() === 'a' ? 'öğleden önce' : 'öğleden sonra'} ${t.includes(':') ? t : t + ':00'}`);
  return text;
}

// ---------------------------------------------------------------- misc cleanup for subtitles

function passSubtitleNoise(text) {
  return text
    .replace(/\[(?:music|müzik|applause|alkış|laughter|gülüşmeler|kahkaha)\]/giu, ' ')
    .replace(/[♪♫]+/g, ' ')
    .replace(/>>+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Written Turkish -> spoken Turkish, for the TTS models. Keeps case and punctuation (prosody cues).
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  if (!text) return '';
  let t = String(text).normalize('NFC');
  t = passSubtitleNoise(t);
  t = passEnglishNumbers(t);
  t = passEnglishWords(t);
  t = passEnglishRespell(t);
  try {
    t = trnorm(t);
  } catch (e) {
    // never fail synthesis on odd input: read what we have
    console.warn('[tts] trnorm failed, reading text as written', e);
  }
  return t;
}

export { trnorm, attachSuffix, trLower };
