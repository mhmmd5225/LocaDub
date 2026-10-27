// Sürüm karşılaştırma ve güncelleme bilgisi (saf; node testleriyle sınanır).
// Site, eklenti paketinin sürümünü https://localdub.mhmmd.app/version.json içinde yayınlar
// ({ version, bytes, commit }; tools/site/build.py üretir).

export const VERSION_URL = 'https://localdub.mhmmd.app/version.json';
export const DOWNLOAD_URL = 'https://localdub.mhmmd.app/LocaDub.zip';
export const INSTALL_URL = 'https://localdub.mhmmd.app/#kurulum';

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

/** version.json içeriği ve kurulu sürüm → gösterilecek güncelleme ya da null. */
export function updateFrom(remote, installed) {
  if (!remote || typeof remote.version !== 'string') return null;
  if (compareVersions(remote.version, installed) <= 0) return null;
  const mb = Number(remote.bytes) > 0 ? Math.round((remote.bytes / 1048576) * 10) / 10 : null;
  return { version: remote.version, sizeMB: mb };
}
