// Sürüm karşılaştırma ve güncelleme bilgisi (saf; node testleriyle sınanır).
// Site, eklenti paketinin sürümünü <taban>/version.json içinde yayınlar ({ version, bytes, commit }; tools/site/build.py üretir).
// İki kaynak denenir: asıl adres ve GitHub Pages (asıl adres Netlify/DNS yüzünden eskide kalırsa güncelleme şeridi yine çalışsın).
// En yeni sürümü veren kaynak kazanır; indirme ve kurulum bağlantıları o kaynağın adresidir.

export const SITE_SOURCES = Object.freeze([
  { base: 'https://localdub.mhmmd.app/' },
  { base: 'https://mhmmd5225.github.io/LocaDub/' },
]);
export const VERSION_URL = SITE_SOURCES[0].base + 'version.json';
export const DOWNLOAD_URL = SITE_SOURCES[0].base + 'LocaDub.zip';
export const INSTALL_URL = SITE_SOURCES[0].base + '#kurulum';

/** Depodan okunan bağlantı yalnızca bilinen site adreslerinden biriyse güvenilir sayılır. */
export function isSiteUrl(u) {
  return typeof u === 'string' && SITE_SOURCES.some((s) => u.startsWith(s.base));
}

// "1.2.10" > "1.2.9"; eksik parçalar 0 sayılır. Sayısal olmayan parça içeren sürüm geçersizdir (null).
function parts(v) {
  const p = String(v ?? '').trim().split('.');
  if (!p.length || p.length > 4 || p.some((x) => !/^\d+$/.test(x))) return null;
  return p.map(Number);
}

/** a > b → 1, a < b → -1, eşit → 0; geçersiz sürümde 0 (güncelleme önerilmez). */
export function compareVersions(a, b) {
  const x = parts(a), y = parts(b);
  if (!x || !y) return 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Kaynak sonuçları [{ base, remote }] → en yeni geçerli sürüm { version, bytes, downloadUrl, installUrl } ya da null.
 * Eşit sürümde önce gelen kaynak (asıl adres) kalır.
 */
export function pickLatest(results) {
  let best = null;
  for (const { base, remote } of results || []) {
    if (!remote || typeof remote.version !== 'string' || !parts(remote.version)) continue;
    if (!best || compareVersions(remote.version, best.version) > 0) {
      best = { version: remote.version, bytes: Number(remote.bytes) || 0, downloadUrl: base + 'LocaDub.zip', installUrl: base + '#kurulum' };
    }
  }
  return best;
}

/** Kaynakları paralel dener (hata / zaman aşımı olan atlanır); fetchJson(url) → Promise<{ version, bytes }>. */
export async function checkSources(fetchJson, sources = SITE_SOURCES) {
  const results = await Promise.all(sources.map(async ({ base }) => {
    try { return { base, remote: await fetchJson(base + 'version.json') }; } catch { return { base, remote: null }; }
  }));
  return pickLatest(results);
}

/** version.json içeriği (ya da pickLatest sonucu) ve kurulu sürüm → gösterilecek güncelleme ya da null. */
export function updateFrom(remote, installed) {
  if (!remote || typeof remote.version !== 'string') return null;
  if (compareVersions(remote.version, installed) <= 0) return null;
  const mb = Number(remote.bytes) > 0 ? Math.round((remote.bytes / 1048576) * 10) / 10 : null;
  return {
    version: remote.version, sizeMB: mb,
    ...(isSiteUrl(remote.downloadUrl) ? { downloadUrl: remote.downloadUrl } : {}),
    ...(isSiteUrl(remote.installUrl) ? { installUrl: remote.installUrl } : {}),
  };
}
