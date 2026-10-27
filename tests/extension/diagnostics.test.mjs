// common/diagnostics.js: hata tamponu, gizlilik süzgeci ve rapor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ERRORS, buildReport, pushError, scrub } from '../../extension/common/diagnostics.js';

test('scrub: YouTube adresleri ve video kimlikleri silinir, model adresleri kalır', () => {
  assert.equal(scrub('fetch https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&pot=x failed'), 'fetch <youtube-adresi> failed');
  assert.equal(scrub('videoId: dQw4w9WgXcQ yok'), 'videoId: … yok');
  assert.equal(scrub('HTTP 404: https://huggingface.co/a/b.onnx'), 'HTTP 404: https://huggingface.co/a/b.onnx');
  assert.equal(scrub('x'.repeat(900)).length, 500);
});

test('pushError: ardışık aynı hata sayılır, en fazla MAX_ERRORS', () => {
  let l = [];
  l = pushError(l, { source: 'mt.translate', message: 'A', at: 1 });
  l = pushError(l, { source: 'mt.translate', message: 'A', at: 2 });
  assert.deepEqual(l, [{ at: 2, source: 'mt.translate', message: 'A', count: 2 }]);
  for (let i = 0; i < 20; i++) l = pushError(l, { source: 's', message: 'E' + i, at: 10 + i });
  assert.equal(l.length, MAX_ERRORS);
  assert.equal(l[l.length - 1].message, 'E19');
});

test('buildReport: ayarlar, motorlar, modeller, hatalar; sözlük metni girmez', () => {
  const text = buildReport({
    version: '0.1.0', browser: 'Chrome 141.0.1', platform: 'Windows 15.0', now: Date.UTC(2026, 9, 27),
    settings: { engineMode: 'real', voice: 'antalia-mini', glossaryMt: 'gizli => metin', speakerVoices: true },
    status: { mt: { ready: true, backend: 'opus-mt' }, tts: { loading: true }, crossOriginIsolated: true, webgpu: false, hardwareConcurrency: 8 },
    models: [{ name: 'Antalia Mini', sizeMB: 23.4 }],
    errors: [{ at: Date.UTC(2026, 9, 27, 1), source: 'mt.translate', message: 'boom', count: 3 }],
    glossary: { mt: 1, tts: 0 },
  });
  assert.match(text, /^LocaDub 0\.1\.0 · Chrome 141\.0\.1 · Windows 15\.0/);
  assert.match(text, /voice: "antalia-mini"/);
  assert.match(text, /çeviri: hazır \(opus-mt\)/);
  assert.match(text, /ses: yükleniyor/);
  assert.match(text, /Antalia Mini: 23\.4 MB/);
  assert.match(text, /mt\.translate ×3: boom/);
  assert.match(text, /sözlük: 1 çeviri düzeltmesi, 0 okunuş/);
  assert.doesNotMatch(text, /gizli/);
});
