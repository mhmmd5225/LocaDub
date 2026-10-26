// Eklenti simgesini canvas ile çizer. Chrome'da çalıştırılır (Segoe UI / Roboto kalın yazı tipi gerekir):
//   const urls = drawAll();  // { 16: 'data:image/png;base64,…', 32: …, 48: …, 128: … }
// Çıktılar extension/icons/icon-<boyut>.png olarak kaydedilir.

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawIcon(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const s = size / 128; // tasarım 128 birimlik ızgarada
  ctx.scale(s, s);

  // Zemin: kırmızı geçişli yuvarlak kare
  const g = ctx.createLinearGradient(0, 0, 128, 128);
  g.addColorStop(0, '#ff5247');
  g.addColorStop(1, '#b3161b');
  roundRect(ctx, 4, 4, 120, 120, 28);
  ctx.fillStyle = g;
  ctx.fill();

  const font = (px) => `800 ${px}px "Segoe UI", Roboto, Arial, sans-serif`;
  if (size <= 16) {
    // Küçük boyutta yalnızca kalın "TR"
    ctx.fillStyle = '#fff';
    ctx.font = font(58);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('TR', 64, 70);
    return c.toDataURL('image/png');
  }

  // Konuşma balonu (kuyruğu sol altta)
  ctx.fillStyle = '#fff';
  roundRect(ctx, 16, 26, 76, 60, 16);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(28, 80);
  ctx.lineTo(24, 104);
  ctx.lineTo(48, 84);
  ctx.closePath();
  ctx.fill();

  // Balondaki "TR"
  ctx.fillStyle = '#c4191f';
  ctx.font = font(40);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('TR', 54, 58);

  // Ses dalgaları
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  for (const [r, w, a] of [[14, 7, 1], [26, 7, 0.75]]) {
    ctx.globalAlpha = a;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.arc(92, 56, r, -Math.PI / 3.2, Math.PI / 3.2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return c.toDataURL('image/png');
}

function drawAll() {
  const out = {};
  for (const n of [16, 32, 48, 128]) out[n] = drawIcon(n);
  return out;
}
