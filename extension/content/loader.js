// Klasik içerik betiği: ES module olan uygulamayı dinamik import ile yükler.
(async () => {
  try {
    const mod = await import(chrome.runtime.getURL('content/app.js'));
    await mod.start();
  } catch (e) {
    console.error('[yt-tr-dub] İçerik betiği başlatılamadı:', e);
  }
})();
