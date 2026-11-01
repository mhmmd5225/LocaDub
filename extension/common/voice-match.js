// Konuşmacıya benzeyen ses: konuşmacının ortanca perdesine (Hz) en yakın TTS sesi ve küçük bir perde ayarı.
// Saf hesap (Node testleri). Kulak benzerliği en çok perdeden algılar; konuşmacı tanıma vektörü (kimlik) dinleme
// testinde kulakla uyuşmadı (bkz. tools/voice-match.mjs). Perde ayarı yeniden örneklemeyle yapıldığından sınırlı
// tutulur ve her yarım tonu küçük bir cezayla öder: aynı yakınlıkta doğal (ayarsız) ses yeğlenir.

export const MATCH_MAX_PITCH = 2; // yarım ton
const PITCH_COST = 0.3; // ayarın yarım ton başına cezası (yarım ton farkı cinsinden)

const semis = (a, b) => 12 * Math.log2(a / b);

/**
 * hz: konuşmacının ortanca perdesi; pool: [{ id, f0 }] (aynı cinsiyetten, kullanılabilir sesler).
 * → { voice, pitch, diff } (pitch: tamsayı yarım ton; diff: kalan fark) ya da null. avoid: kaçınılacak ses kimlikleri (Set).
 */
export function matchVoice(hz, pool, { maxPitch = MATCH_MAX_PITCH, avoid = null } = {}) {
  const all = rank(hz, pool, maxPitch);
  if (!all.length) return null;
  // başka konuşmacının aldığı ses (ayarı ne olursa olsun; ±1–2 yarım ton ayırt ettirmez): neredeyse aynı
  // yakınlıkta (≤ 1 birim) farklı bir aday varsa o alınır, iki konuşmacı aynı sesle konuşmasın
  let best = all[0];
  if (avoid?.has(key(best))) best = all.find((c) => !avoid.has(key(c)) && c.cost <= all[0].cost + AVOID_SLACK) || best;
  return { voice: best.voice, pitch: best.pitch, diff: Math.round(best.diff * 100) / 100 };
}

const AVOID_SLACK = 1;
const key = (c) => c.voice;

function rank(hz, pool, maxPitch) {
  if (!(hz > 0)) return [];
  const out = [];
  for (const v of pool) {
    if (!(v.f0 > 0)) continue;
    const need = semis(hz, v.f0);
    // bu sesin en ucuz ayarı (ceza yüzünden tam farktan biraz az olabilir)
    let best = null;
    for (let p = -maxPitch; p <= maxPitch; p++) {
      const diff = need - p;
      const cost = Math.abs(diff) + PITCH_COST * Math.abs(p);
      if (!best || cost < best.cost - 1e-9) best = { voice: v.id, pitch: p, diff, cost };
    }
    out.push(best);
  }
  return out.sort((a, b) => a.cost - b.cost);
}

/** Kümenin sesi için gereken en az perde çerçevesi (50 ms; ≈ 3 sn ötümlü konuşma). */
export const MATCH_MIN_F0 = 60;

/**
 * Konuşmacı kümelerine kalıcı ses ataması. Küme yeterli perde kanıtı toplayınca (MATCH_MIN_F0) bir kez seçilir
 * ve video boyunca değişmez; aynı cinsiyetteki diğer konuşmacılardan farklı bir ses yeğlenir.
 * pool: [{ id, gender, f0 }] (indirilmiş sesler).
 */
export class VoiceAssigner {
  constructor(pool = []) {
    this.setPool(pool);
    this.byId = new Map(); // küme kimliği → { voice, pitch, diff, hz }
  }

  setPool(pool) {
    this.pool = (pool || []).filter((v) => v && v.f0 > 0 && (v.gender === 'female' || v.gender === 'male'));
  }

  /** O cinsiyet için seçim yapılabilir mi (en az iki ses: tek sesle "benzeyen" seçimin anlamı yok). */
  usable(gender) {
    return this.pool.filter((v) => v.gender === gender).length >= 2;
  }

  get(id) { return this.byId.get(id) || null; }

  /**
   * Kümeye ses ata (yoksa): { id, gender, hz, nf0 }. Yeni atama yapıldıysa atamayı, değilse null döndürür.
   */
  assign({ id, gender, hz, nf0 }) {
    if (id == null || this.byId.has(id) || !gender || !(hz > 0) || nf0 < MATCH_MIN_F0 || !this.usable(gender)) return null;
    const avoid = new Set([...this.byId.values()].filter((a) => a.gender === gender).map((a) => a.voice));
    const m = matchVoice(hz, this.pool.filter((v) => v.gender === gender), { avoid });
    if (!m) return null;
    const a = { ...m, gender, hz: Math.round(hz) };
    this.byId.set(id, a);
    return a;
  }

  reset() { this.byId.clear(); }
}
