// Dinleyici penceresi: YouTube videosunu ana oynatıcının önünden oynatır, bu sekmenin sesini yakalar
// (kullanıcı izniyle; yerel çalma kapatılır, yani pencere sessizdir) ve Whisper ile yazıya döker.
// Ana sayfayla (window.opener) postMessage ile konuşur:
//   ← { type:'main', t, playing }                       ana oynatıcının konumu
//   → { type:'cues', cues, coverage } | { type:'status', text, kind } | { type:'progress', … } | { type:'capturing' }

import { loadYouTubeApi } from './media.js';
import { SR, Coverage, Segmenter, Transcriber } from './asr.js';

const $ = (id) => document.getElementById(id);
const videoId = new URLSearchParams(location.search).get('v') || '';
const opener = window.opener;

const FAST_RATE = 1.25;  // ana oynatıcıya göre önde açılmak için
const LEAD_MIN = 40;     // sn; bu kadar önde değilse hızlı oynat
const LEAD_MAX = 150;    // sn; bu kadar öndeyse bekle
const LEAD_RESUME = 100;

function post(msg) {
  try { opener?.postMessage({ source: 'locadub-listener', ...msg }, location.origin); } catch { /* yoksay */ }
}
function status(text, kind = 'info') {
  $('status').textContent = text;
  $('status').dataset.kind = kind;
  post({ type: 'status', text, kind });
}

const coverage = new Coverage();
const transcriber = new Transcriber();
let player = null;
let main = { t: 0, playing: false };
let pausedByUs = false;
let endedFlushed = false;
let capturing = false;
const queue = [];
let busy = false;

// Pencereler sırayla yazıya dökülür; sonuç ana sayfaya gider.
const segmenter = new Segmenter((win) => { queue.push(win); pump(); });

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const win = queue.shift();
    try {
      const cues = await transcriber.transcribe(win);
      coverage.add(win.startVideo, win.startVideo + (win.audio.length / SR) * win.rate);
      post({ type: 'cues', cues, coverage: coverage.list });
      $('covered').textContent = coverage.list.map(([a, b]) => `${fmt(a)}–${fmt(b)}`).join(', ');
    } catch (e) {
      status('Konuşma tanıma hatası: ' + (e?.message || e), 'error');
    }
  }
  busy = false;
}

const fmt = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

window.addEventListener('message', (ev) => {
  if (ev.origin !== location.origin || ev.source !== opener || ev.data?.source !== 'locadub-main') return;
  if (ev.data.type === 'main') main = { t: Number(ev.data.t) || 0, playing: !!ev.data.playing };
});

// ---------- Oynatıcı ----------

async function setUpPlayer() {
  const YT = await loadYouTubeApi();
  await new Promise((resolve, reject) => {
    player = new YT.Player('player', {
      videoId,
      host: 'https://www.youtube-nocookie.com',
      playerVars: { playsinline: 1, rel: 0, cc_load_policy: 0, iv_load_policy: 3, origin: location.origin },
      events: {
        onReady: () => resolve(),
        onError: (e) => reject(new Error(`YouTube bu videoyu oynatmadı (hata ${e.data}).`)),
      },
    });
  });
}

const ytTime = () => { try { return player.getCurrentTime() || 0; } catch { return 0; } };
const ytState = () => { try { return player.getPlayerState(); } catch { return -1; } };
const ytRate = () => { try { return player.getPlaybackRate() || 1; } catch { return 1; } };

// Ana oynatıcının önünde kal: arada açık yoksa hızlan, çok öndeyse bekle, kapsanmamış yere sarılırsa oraya git.
function steer() {
  if (!capturing || !player) return;
  const pt = ytTime();
  const state = ytState();
  const dur = player.getDuration?.() || 0;
  if (coverage.until(main.t) < 0 && (main.t > pt + 2 || main.t < pt - 25)) {
    segmenter.flush();
    player.seekTo(Math.max(0, main.t - 1), true);
    return;
  }
  const u = coverage.until(pt);
  if (u > pt + 2 && pt >= main.t && u < dur - 1) {
    segmenter.flush();
    player.seekTo(u, true);
    return;
  }
  const lead = pt - main.t;
  if (state === 1 && lead > LEAD_MAX) { player.pauseVideo(); pausedByUs = true; }
  else if (state === 2 && pausedByUs && lead < LEAD_RESUME) { player.playVideo(); pausedByUs = false; }
  const want = lead < LEAD_MIN ? FAST_RATE : 1;
  if (state === 1 && ytRate() !== want && player.getAvailablePlaybackRates?.().includes(want)) player.setPlaybackRate(want);
  if (state === 0) {
    // Video bitti: yarım kalan son pencereyi de yazıya dök.
    if (!endedFlushed) { endedFlushed = true; segmenter.flush(); }
    if (!queue.length && !busy) status('Videonun sonuna kadar yazıya döküldü. Bu pencereyi açık tutun.', 'ok');
  } else endedFlushed = false;
}

// ---------- Ses yakalama ----------

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch.length) {
      const L = ch[0], R = ch[1] || ch[0];
      for (let i = 0; i < L.length; i++) {
        this.buf[this.n++] = (L[i] + R[i]) * 0.5;
        if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(4096); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('tap', Tap);`;

// Ortalama alarak 16 kHz'e indirger (konuşma için yeterli).
function makeResampler(fromRate) {
  const step = fromRate / SR;
  let pos = 0;
  let carry = new Float32Array(0);
  return (block) => {
    const src = new Float32Array(carry.length + block.length);
    src.set(carry); src.set(block, carry.length);
    const n = Math.floor((src.length - pos) / step);
    const out = new Float32Array(Math.max(0, n));
    for (let i = 0; i < n; i++) {
      const a = Math.floor(pos + i * step), b = Math.max(a + 1, Math.floor(pos + (i + 1) * step));
      let s = 0;
      for (let k = a; k < b; k++) s += src[k];
      out[i] = s / (b - a);
    }
    const used = Math.floor(pos + n * step);
    pos = pos + n * step - used;
    carry = src.slice(used);
    return out;
  };
}

async function startCapture() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('Bu tarayıcı sekme sesini yakalayamıyor. Masaüstünde Chrome ya da Edge kullanın.');
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser' },
    audio: { suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'exclude',
    systemAudio: 'exclude',
  });
  stream.getVideoTracks().forEach((t) => t.stop());
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('Ses paylaşılmadı. Yeniden deneyin ve "Sekme sesini de paylaş" seçeneğini açık bırakın.');
  track.addEventListener('ended', () => {
    capturing = false;
    segmenter.flush();
    status('Ses paylaşımı durduruldu. Dublaja devam etmek için yeniden başlatın.', 'error');
    $('go').hidden = false;
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
  const src = ctx.createMediaStreamSource(new MediaStream([track]));
  const tap = new AudioWorkletNode(ctx, 'tap');
  const resample = makeResampler(ctx.sampleRate);
  const blockSec = 4096 / ctx.sampleRate;
  tap.port.onmessage = (ev) => {
    const pcm = resample(ev.data);
    if (ytState() !== 1 || !pcm.length) return; // yalnızca oynarken
    const rate = ytRate();
    // Blok yakalandığında video bu bloğun sonundaydı (+ küçük yakalama gecikmesi).
    segmenter.push(pcm, Math.max(0, ytTime() - blockSec * rate - 0.12), rate);
  };
  src.connect(tap);
  // Düğüm çalışsın diye sessiz bir çıkışa bağla.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  tap.connect(mute).connect(ctx.destination);
  capturing = true;
}

$('go').addEventListener('click', async () => {
  $('go').disabled = true;
  try {
    await startCapture();
    $('go').hidden = true;
    post({ type: 'capturing' });
    status('Konuşma tanıma modeli yükleniyor…');
    await transcriber.load((p) => {
      post({ type: 'progress', ...p });
      if (p.total) status(`Konuşma tanıma modeli indiriliyor… %${Math.floor((p.loaded / p.total) * 100)}`);
    });
    player.setVolume(100);
    player.unMute();
    player.seekTo(Math.max(0, main.t - 1), true);
    player.playVideo();
    status('Video dinleniyor ve yazıya dökülüyor. Bu pencereyi kapatmayın ve küçültmeyin; arkada kalabilir.', 'ok');
  } catch (e) {
    const msg = e?.name === 'NotAllowedError' ? 'Ses paylaşımına izin verilmedi. Yeniden deneyin.'
      : e?.name === 'NotReadableError' ? 'Sekme sesi başlatılamadı (ses aygıtı bulunamadı). Bilgisayarın ses çıkışını kontrol edip yeniden deneyin.'
        : String(e?.message || e);
    status(msg, 'error');
  } finally {
    $('go').disabled = false;
  }
});

if (!opener) {
  status('Bu pencere LocaDub sayfasından açılmalıdır.', 'error');
  $('go').hidden = true;
} else if (!/^[\w-]{11}$/.test(videoId)) {
  status('Geçersiz video kimliği.', 'error');
  $('go').hidden = true;
} else {
  setUpPlayer().then(() => {
    $('go').disabled = false;
    status('Hazır. "Dinlemeyi başlat"a basın.');
    setInterval(steer, 500);
  }, (e) => status(e.message, 'error'));
}
window.addEventListener('beforeunload', () => post({ type: 'closed' }));
