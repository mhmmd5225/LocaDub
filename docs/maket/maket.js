// Maket yardımcıları: tema seçici ve kaydırıcı dolgusu. Ürün kodu değildir.
(() => {
  const root = document.documentElement;
  const KEY = 'locadub-maket-tema';
  const q = new URLSearchParams(location.search).get('tema');
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { /* özel pencere */ }
  const map = { acik: 'light', koyu: 'dark', light: 'light', dark: 'dark' };
  const apply = (t) => {
    if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
    document.querySelectorAll('.mk-theme button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.t || 'system') === (t || 'system'))));
  };
  apply(map[q] || saved || 'system');
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.mk-theme button');
    if (!b) return;
    const t = b.dataset.t || 'system';
    try { localStorage.setItem(KEY, t); } catch (err) { /* yok say */ }
    apply(t);
  });

  // Kaydırıcı dolgusu ve çıktı
  const fmt = (r) => {
    const v = +r.value, min = +r.min || 0, max = +r.max || 100;
    r.style.setProperty('--v', `${((v - min) / (max - min)) * 100}%`);
    const out = r.id && document.querySelector(`output[for="${r.id}"]`);
    if (out) {
      const u = r.dataset.unit || '';
      out.textContent = u === '%' ? `%${Math.round(v * 100)}` : u === 'x' ? `${v.toFixed(2).replace('.', ',')}×` : u === 'st' ? `${v > 0 ? '+' : ''}${String(v).replace('.', ',')}` : `${v} ${u}`.trim();
    }
  };
  const init = () => {
    document.querySelectorAll('.range').forEach(fmt);
    document.querySelectorAll('.mk-theme button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.t || 'system') === (root.dataset.theme || 'system'))));
  };
  document.addEventListener('input', (e) => { if (e.target.classList.contains('range')) fmt(e.target); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
