// Kişisel sözlük: kullanıcının "kaynak => hedef" kuralları (saf; node testleriyle sınanır).
//   - Çeviri düzeltmeleri: Türkçe çeviriye uygulanır (altyazı ve ses).
//   - Okunuşlar: yalnızca seslendirmeden önce uygulanır (altyazıda yazılış kalır).
// Kural biçimi (satır başına bir kural, # ile yorum):
//   yapay zeka => yapay zekâ      tam sözcük/sözcük grubu, büyük-küçük harf duyarsız (Türkçe I/İ doğru)
//   zeka* => zekâ*                * : sözcüğün devamını (ekleri) korur → "zekanın" → "zekânın"
// Eşleşme sözcük sınırındadır: "GPT'yi" içindeki "GPT" eşleşir, "GPTX" eşleşmez.

const MAX_RULES = 500;

const LOWER = { I: 'ı', İ: 'i' };
const UPPER = { i: 'İ', ı: 'I' };
const trLower = (c) => LOWER[c] ?? c.toLowerCase();
const trUpper = (c) => UPPER[c] ?? c.toUpperCase();
const escape = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Bir harfin Türkçe ve Latin büyük/küçük biçimlerini kapsayan karakter sınıfı.
function charClass(c) {
  if (/\s/.test(c)) return '\\s+';
  const set = new Set([c, trLower(c), trUpper(c), c.toLowerCase(), c.toUpperCase()]);
  if (set.size === 1) return escape(c);
  return '[' + [...set].map((x) => (/[\]\\^-]/.test(x) ? '\\' + x : x)).join('') + ']';
}

/** Metin → [{ re, to, keepTail }] (geçersiz satırlar atlanır). */
export function parseGlossary(text) {
  const rules = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(.+?)\s*=>\s*(.*)$/.exec(line);
    if (!m) continue;
    let from = m[1].trim();
    let to = m[2].trim();
    const keepTail = from.endsWith('*');
    if (keepTail) { from = from.slice(0, -1).trim(); to = to.replace(/\*$/, ''); }
    if (!from) continue;
    const body = [...from.replace(/\s+/g, ' ')].map(charClass).join('');
    const tail = keepTail ? '([\\p{L}\\p{N}]*)' : '';
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${body}${tail}(?![\\p{L}\\p{N}])`, 'gu');
    rules.push({ re, to, keepTail });
    if (rules.length >= MAX_RULES) break;
  }
  // Uzun kurallar önce: "yapay zeka" "zeka"dan önce uygulanır.
  return rules.sort((a, b) => b.re.source.length - a.re.source.length);
}

export function applyGlossary(text, rules) {
  let s = String(text ?? '');
  if (!s || !rules?.length) return s;
  for (const r of rules) {
    r.re.lastIndex = 0;
    s = s.replace(r.re, (_, tail) => (r.keepTail ? r.to + (tail || '') : r.to));
  }
  return s;
}

// Aynı metin için kuralları yeniden derlememek üzere tek girdilik önbellekli derleyici.
export function glossaryCompiler() {
  let lastText = null, lastRules = [];
  return (text) => {
    if (text !== lastText) { lastText = text; lastRules = parseGlossary(text); }
    return lastRules;
  };
}
