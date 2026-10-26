// 'chrome-translator' backend: Chrome's built-in on-device Translator API (Chrome 138+).
// https://developer.chrome.com/docs/ai/translator-api
//
// Notes:
//  - Window contexts only (offscreen document, popup); not in workers.
//  - When the EN→TR language pack is 'downloadable'/'downloading', Translator.create() needs a user
//    activation. The offscreen document has none, so the popup should call prepareChromeTranslator()
//    from a click handler once; afterwards availability is 'available' and the offscreen document can
//    create translators freely.

export const label = 'Chrome yerleşik çeviri (cihaz üzerinde)';
const LANGS = { sourceLanguage: 'en', targetLanguage: 'tr' };

let translator = null;
let creating = null;

export function hasApi() {
  return typeof globalThis.Translator === 'function' || typeof globalThis.Translator?.availability === 'function';
}

/** 'available' | 'downloadable' | 'downloading' | 'unavailable' */
export async function availability() {
  if (!hasApi()) return 'unavailable';
  try {
    return await globalThis.Translator.availability(LANGS);
  } catch {
    return 'unavailable';
  }
}

function monitor(onProgress) {
  return (m) => {
    m.addEventListener('downloadprogress', (e) => {
      // e.loaded is a 0..1 fraction (total 1) in current Chrome.
      const frac = e.total && e.total !== 1 ? e.loaded / e.total : e.loaded;
      onProgress?.({ backend: 'chrome-translator', phase: 'download', loaded: Math.round(frac * 1000), total: 1000 });
    });
  };
}

/**
 * Call from a user gesture (e.g. a popup button) to download the EN→TR pack if needed.
 * Resolves with the final availability.
 */
export async function prepareChromeTranslator({ onProgress } = {}) {
  if (!hasApi()) return 'unavailable';
  const t = await globalThis.Translator.create({ ...LANGS, monitor: monitor(onProgress) });
  t.destroy?.();
  return availability();
}

export async function init({ onProgress } = {}) {
  if (translator) return { status: 'available' };
  if (creating) return creating;
  creating = (async () => {
    const status = await availability();
    if (status === 'unavailable') throw new Error('chrome-translator: EN→TR çeviri bu tarayıcıda yok (Chrome 138+ gerekir)');
    try {
      translator = await globalThis.Translator.create({ ...LANGS, monitor: monitor(onProgress) });
    } catch (e) {
      if (status !== 'available' && (e?.name === 'NotAllowedError' || /activation|gesture/i.test(e?.message ?? ''))) {
        throw Object.assign(
          new Error('chrome-translator: dil paketi henüz indirilmedi; açılır pencereden "Chrome çevirisini hazırla" ile bir kez indirin'),
          { name: 'NotAllowedError', needsUserActivation: true },
        );
      }
      throw e;
    }
    onProgress?.({ backend: 'chrome-translator', phase: 'ready', loaded: 1000, total: 1000 });
    return { status: 'available' };
  })();
  try {
    return await creating;
  } finally {
    creating = null;
  }
}

/** Translates cleaned-up spans one by one (the API has no batch call). */
export async function translate(texts, { signal } = {}) {
  if (!translator) throw new Error('chrome-translator: init() first');
  const out = [];
  for (const t of texts) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    out.push(t ? await translator.translate(t, { signal }) : '');
  }
  return out;
}

export async function dispose() {
  try {
    translator?.destroy?.();
  } finally {
    translator = null;
  }
}
