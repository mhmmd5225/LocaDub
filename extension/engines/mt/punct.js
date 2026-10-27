// Model tabanlı noktalama, büyük harf ve cümle sınırı: 1-800-BAD-CODE/punctuation_fullstop_truecase_english
// (Apache-2.0). Tek ONNX grafiği: input_ids [B, T] (küçük harfli SentencePiece kimlikleri, BOS/EOS ile) →
//   pre_preds [B, T]      alt parçadan önce eklenecek işaret (İngilizcede kullanılmaz)
//   post_preds [B, T]     alt parçadan sonra: <NULL> | <ACRONYM> (her harften sonra nokta) | . | , | ?
//   cap_preds [B, T, C]   alt parçanın her karakteri büyük mü
//   seg_preds [B, T]      alt parçadan sonra cümle bitiyor mu
// Çözüm sözcük düzeyinde yapılır: model sözcüğü tanımadıysa (<unk>) özgün yazılış korunur.
// ort enjekte edilir (işçide onnxruntime-web, testte onnxruntime-node).

import { parseSpmModel, SpmTokenizer } from './spm.js';

const REPO = '1-800-BAD-CODE/punctuation_fullstop_truecase_english';
const REVISION = 'b26fd1c40e88678859048898218ea4edcc24c84a'; // sabit sürüm: boyutlar ve çözüm mantığı bu sürüme göre
export const PUNCT_MODEL = {
  repo: `https://huggingface.co/${REPO}/resolve/${REVISION}/`,
  license: 'Apache-2.0 (1-800-BAD-CODE/punctuation_fullstop_truecase_english)',
  files: [
    { name: 'onnx', file: 'punct_cap_seg_en.onnx', size: 209532928 },
    { name: 'spm', file: 'spe_32k_lc_en.model', size: 587902 },
  ],
  maxLen: 256,
  postLabels: [null, '<ACRONYM>', '.', ',', '?'],
  preLabels: [null, '¿'],
};
export const punctUrl = (name) => PUNCT_MODEL.repo + PUNCT_MODEL.files.find((f) => f.name === name).file;
export const punctBytes = () => PUNCT_MODEL.files.reduce((n, f) => n + f.size, 0);

const SPACE = '▁';

/** Sözcükleri ayrı ayrı belirteçler (SentencePiece boşlukta böler, sonuç tüm metni belirteçlemekle aynıdır). */
export function tokenizeWords(tok, text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const ids = [];
  const map = []; // her alt parça: { w: sözcük sırası, unk }
  words.forEach((word, w) => {
    for (const id of tok.encode(word.toLowerCase())) {
      ids.push(id);
      map.push({ w, unk: id === tok.unkId });
    }
  });
  return { words, ids, map };
}

// Model harf düzeyinde karar verir; başlık biçimli metinde "BrEAkING" gibi karışık sonuçlar çıkabilir. Sözcüğün tüm
// harfleri büyükse (kısaltma: NASA, U.S., JO25) korunur; değilse yalnızca ilk harfin kararı uygulanır
// ("McDonald" gibi iç büyük harfli adlar küçülür; otomatik altyazıda nadir).
export function tidyCase(word) {
  const letters = [...word].filter((c) => /\p{L}/u.test(c));
  if (!letters.length || letters.every((c) => c !== c.toLowerCase())) return word;
  const lower = word.toLowerCase();
  const first = [...word].findIndex((c) => /\p{L}/u.test(c));
  return word[first] !== word[first].toLowerCase() ? lower.slice(0, first) + lower[first].toUpperCase() + lower.slice(first + 1) : lower;
}

/**
 * Model çıktısını özgün sözcüklere uygular (saf; testlerde sahte çıktıyla sınanır).
 * pred: { post:number[], cap:number[][] (alt parça × karakter; "▁" dahil), seg:number[] } — BOS/EOS çıkarılmış.
 * → cümle listesi
 */
export function decode(tok, { words, ids, map }, pred, postLabels = PUNCT_MODEL.postLabels) {
  const out = words.map((w) => ({ text: w, post: null, end: false }));
  const chars = words.map((w) => [...w.toLowerCase()]);
  const offset = new Array(words.length).fill(0); // sözcük içinde sıradaki karakter
  ids.forEach((id, i) => {
    const { w, unk } = map[i];
    const raw = unk ? '' : tok.piece(id);
    const sp = raw.startsWith(SPACE) ? 1 : 0; // büyük harf tahminleri "▁" karakterini de sayar
    const n = [...raw].length - sp;
    const label = postLabels[pred.post[i]] ?? null;
    if (!unk) {
      for (let c = 0; c < n; c++) {
        const k = offset[w] + c;
        if (pred.cap[i]?.[c + sp] && k < chars[w].length) chars[w][k] = chars[w][k].toUpperCase();
        if (label === '<ACRONYM>' && k < chars[w].length) chars[w][k] += '.';
      }
      offset[w] += n;
    }
    if (label && label !== '<ACRONYM>') out[w].post = label; // sözcük sonundaki etiket kalır
    if (pred.seg[i]) out[w].end = true;
  });
  const sentences = [];
  let cur = [];
  out.forEach((o, w) => {
    // Model sözcüğü tanıdıysa onun yazılışı; <unk> içeriyorsa özgün sözcük (yalnızca ilk harf büyütülebilir).
    const hasUnk = map.some((m) => m.w === w && m.unk);
    let text = hasUnk ? words[w] : tidyCase(chars[w].join(''));
    if (hasUnk && chars[w][0] && chars[w][0] !== chars[w][0].toLowerCase()) text = text[0].toUpperCase() + text.slice(1);
    if (o.post && !/[.,?!]$/.test(text)) text += o.post;
    cur.push(text);
    if (o.end) { sentences.push(cur.join(' ')); cur = []; }
  });
  if (cur.length) sentences.push(cur.join(' '));
  return sentences;
}

export class PunctRestorer {
  /** @param ort onnxruntime (web ya da node) @param onnx ArrayBuffer|Uint8Array @param spm ArrayBuffer|Uint8Array */
  static async create(ort, { onnx, spm, sessionOptions } = {}) {
    const r = new PunctRestorer();
    r.ort = ort;
    r.tok = new SpmTokenizer(parseSpmModel(new Uint8Array(spm)));
    r.bos = r.tok.model?.bosId ?? 1;
    r.eos = r.tok.model?.eosId ?? 2;
    r.session = await ort.InferenceSession.create(new Uint8Array(onnx), sessionOptions);
    return r;
  }

  /** Metin → noktalanmış metin (cümleler boşlukla birleştirilir). Uzun metin parçalara bölünür. */
  async restore(text) {
    const enc = tokenizeWords(this.tok, text);
    if (!enc.ids.length) return String(text ?? '');
    const max = PUNCT_MODEL.maxLen - 2;
    const pred = { post: [], cap: [], seg: [] };
    for (let a = 0; a < enc.ids.length; a += max) {
      const part = enc.ids.slice(a, a + max);
      const input = [this.bos, ...part, this.eos];
      const feeds = { input_ids: new this.ort.Tensor('int64', BigInt64Array.from(input.map(BigInt)), [1, input.length]) };
      const r = await this.session.run(feeds);
      const T = input.length;
      const C = r.cap_preds.dims[2];
      const post = r.post_preds.data, seg = r.seg_preds.data, cap = r.cap_preds.data;
      for (let t = 1; t < T - 1; t++) {
        pred.post.push(Number(post[t]));
        pred.seg.push(Number(seg[t]));
        const row = [];
        for (let c = 0; c < C; c++) row.push(Number(cap[t * C + c]));
        pred.cap.push(row);
      }
    }
    return decode(this.tok, enc, pred).join(' ');
  }

  async release() {
    await this.session?.release?.();
    this.session = null;
  }
}
