// Otomatik (ASR) altyazı metnine çeviriden önce noktalama ve büyük harf kazandırma — model gerektirmeyen kurallar.
// YouTube otomatik altyazısı küçük harfli ve noktalamasızdır; OPUS-MT bu girdide belirgin kalite kaybeder
// (docs/MT-KIYAS.md). Model tabanlı geri kazanım: ./punct.js.

const HAS_UPPER = /\p{Lu}/u;
const HAS_PUNCT = /[.!?,;:]/;
const END = /[.!?…]["'”’)\]]*$/;

/** Metin otomatik altyazı biçiminde mi (büyük harf ve noktalama yok)? */
export function looksAsr(text) {
  const t = String(text ?? '');
  return /\p{L}/u.test(t) && !HAS_UPPER.test(t) && !HAS_PUNCT.test(t);
}

/** Kurallar: tek başına "i" ve kısaltmaları (i'm, i'll, i've, i'd) büyük, cümle başı büyük, sona nokta. */
export function restoreRules(text) {
  const t = String(text ?? '').trim();
  if (!looksAsr(t)) return t;
  let s = t.replace(/(^|[^\p{L}\p{N}'])i(?=('m|'ll|'ve|'d|'s)?(?![\p{L}\p{N}']))/gu, '$1I');
  s = s.replace(/^(\P{L}*)(\p{L})/u, (_, pre, c) => pre + c.toUpperCase());
  if (!END.test(s)) s += '.';
  return s;
}
