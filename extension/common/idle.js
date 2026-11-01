// Boşta kaynak bırakma (offscreen.js): son motor isteğinden IDLE_UNLOAD_MS sonra çeviri / seslendirme / konuşmacı motorları bellekten
// ve (WebGPU oturumları için) ekran kartı belleğinden boşaltılır; sonraki istek motoru yeniden yükler. Canlı dublaj oturumu oynarken
// `engine.keepalive` ile süreyi uzatır. Saf karar işlevi: Node testleriyle sınanır.

export const IDLE_UNLOAD_MS = 3 * 60 * 1000;
export const IDLE_CHECK_MS = 30 * 1000;

/** loaded: bellekte en az bir motor var; active: sürmekte olan istek sayısı. */
export function shouldUnload({ now, lastActive, active = 0, loaded, idleMs = IDLE_UNLOAD_MS }) {
  return !!loaded && active === 0 && now - lastActive >= idleMs;
}
