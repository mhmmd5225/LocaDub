"""Serves the project read-only and accepts POST /save/icon-<n>.png (PNG bytes) into extension/icons/."""
import http.server, os, re, sys

ROOT = sys.argv[1]
OUT = os.path.join(ROOT, 'extension', 'icons')


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def do_POST(self):
        m = re.fullmatch(r'/save/(icon-(16|32|48|128)\.png)', self.path)
        n = int(self.headers.get('content-length', 0))
        body = self.rfile.read(n)
        if not m or not body.startswith(b'\x89PNG'):
            self.send_response(400); self.end_headers(); return
        os.makedirs(OUT, exist_ok=True)
        with open(os.path.join(OUT, m.group(1)), 'wb') as f:
            f.write(body)
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')


http.server.ThreadingHTTPServer(('127.0.0.1', 8765), H).serve_forever()
