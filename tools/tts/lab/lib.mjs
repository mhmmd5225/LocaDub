// Laboratuvar ortak yardımcıları: cümle listesi, WAV yazımı, RTF kaydı.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const MODELS = join(here, '.models');
export const OUT = join(here, 'out');

export const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
export const THREADS = Number(arg('--threads', process.env.THREADS || 4));
export const LIMIT = Number(arg('--limit', 0)); // 0 = tüm cümleler (hızlı deneme için)

export async function loadSentences() {
  const all = JSON.parse(await readFile(join(here, 'sentences.json'), 'utf8'));
  return LIMIT ? all.slice(0, LIMIT) : all;
}

/** 16-bit PCM mono WAV (Float32Array -> bayt). */
export function wavBytes(pcm, rate) {
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + pcm.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), 44 + i * 2);
  return buf;
}

/**
 * Bir adayın tüm cümlelerini sentezler. synth(text, sentence) -> { pcm: Float32Array, sampleRate }.
 * Çıktı: out/<id>/NN.wav ve out/<id>/stats.json (cümle başına süre, hesaplama süresi, RTF).
 * İlk cümleden önce ısınma çağrısı yapılır (ölçüme girmez).
 */
export async function runCandidate(id, meta, synth, { warmup = 'Merhaba.' } = {}) {
  const sentences = await loadSentences();
  const dir = join(OUT, id);
  await mkdir(dir, { recursive: true });
  if (warmup) await synth(warmup, { id: 0 });
  const rows = [];
  let aud = 0;
  let cmp = 0;
  let rate = 0;
  for (const s of sentences) {
    const t0 = performance.now();
    const { pcm, sampleRate } = await synth(s.text, s);
    const compute = (performance.now() - t0) / 1000;
    const seconds = pcm.length / sampleRate;
    rate = sampleRate;
    await writeFile(join(dir, `${String(s.id).padStart(2, '0')}.wav`), wavBytes(pcm, sampleRate));
    rows.push({ id: s.id, seconds, compute, rtf: compute / seconds });
    aud += seconds;
    cmp += compute;
    console.log(`[${id}] ${s.id} ${seconds.toFixed(2)} s ses, ${compute.toFixed(2)} s hesap, RTF ${(compute / seconds).toFixed(3)}`);
  }
  const stats = { id, ...meta, threads: THREADS, sampleRate: rate, totalAudio: aud, totalCompute: cmp, rtf: cmp / aud, rows };
  await writeFile(join(dir, `stats-t${THREADS}.json`), JSON.stringify(stats, null, 2));
  console.log(`== ${id}: ${aud.toFixed(1)} s ses / ${cmp.toFixed(1)} s hesap = RTF ${(cmp / aud).toFixed(3)} (iş parçacığı ${THREADS}, ${rate} Hz)`);
  return stats;
}

export { readFile };
