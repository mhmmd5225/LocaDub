// Konuşmacı vektöründen cinsiyet puanı: doğrusal (lojistik regresyon) katman, ağırlıklar gender-<model>.json
// (tools/spk-eval.mjs --train-gender, LibriSpeech test-clean). Puan logit: > 0 kadın, < 0 erkek.

/** head: { w:number[], b:number }, v: birim vektör → logit. */
export function genderScore(head, v) {
  if (!head?.w || head.w.length !== v.length) return null;
  let z = head.b || 0;
  for (let i = 0; i < v.length; i++) z += head.w[i] * v[i];
  return z;
}
