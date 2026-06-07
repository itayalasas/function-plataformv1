// Runner script (Python 3.12) embedded at deploy time into the container as /app/runner.py.
// Listens on PORT (default 8000), routes /{slug}/... to /app/src/{slug}/index.py
// which must define a `handler(req)` function.

export const PYTHON_RUNNER_SOURCE = String.raw`
import os, sys, json, importlib.util, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", "8000"))
ROOT = "/app/src"

def load_handler(slug):
    d = os.path.join(ROOT, slug)
    if not os.path.isdir(d):
        return None, "not_found"
    manifest = os.path.join(d, ".vortex-entrypoint")
    if os.path.exists(manifest):
        try:
            with open(manifest, "r", encoding="utf-8") as fh:
                raw = fh.read().strip()
            if raw:
                candidate = os.path.join(d, raw)
                if os.path.exists(candidate):
                    try:
                        spec = importlib.util.spec_from_file_location("user_" + slug, candidate)
                        mod = importlib.util.module_from_spec(spec)
                        sys.path.insert(0, d)
                        spec.loader.exec_module(mod)
                        h = getattr(mod, "handler", None) or getattr(mod, "main", None)
                        if h is not None:
                            return h, None
                    except Exception as e:
                        return None, "load_error: " + str(e) + "\n" + traceback.format_exc()
        except Exception as e:
            print("[runner] failed to read entrypoint manifest for", slug, ":", e, flush=True)
    candidates = ["index.py", "main.py", "handler.py", "app.py"]
    entry = None
    for c in candidates:
        if os.path.exists(os.path.join(d, c)):
            entry = os.path.join(d, c); break
    if not entry:
        for f in os.listdir(d):
            if f.endswith(".py"):
                entry = os.path.join(d, f); break
    if not entry:
        return None, "no_python_file"
    try:
        spec = importlib.util.spec_from_file_location("user_" + slug, entry)
        mod = importlib.util.module_from_spec(spec)
        sys.path.insert(0, d)
        spec.loader.exec_module(mod)
        h = getattr(mod, "handler", None) or getattr(mod, "main", None)
        if h is None:
            return None, "no_handler_function"
        return h, None
    except Exception as e:
        return None, "load_error: " + str(e) + "\n" + traceback.format_exc()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.command, fmt % args), flush=True)

    def _serve(self):
        try:
            url = urlparse(self.path)
            if url.path in ("/__health", "/health"):
                body = json.dumps({"status": "ok", "runtime": "python"}).encode()
                self.send_response(200); self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body); return

            parts = url.path.lstrip("/").split("/", 1)
            slug = parts[0] if parts and parts[0] else ""
            subpath = "/" + (parts[1] if len(parts) > 1 else "")
            if not slug:
                self.send_response(404); self.end_headers(); self.wfile.write(b"Not found"); return

            h, err = load_handler(slug)
            if h is None:
                msg = json.dumps({"error": "function_not_loaded", "slug": slug, "detail": err}).encode()
                self.send_response(404 if err == "not_found" else 500); self.send_header("content-type", "application/json")
                self.end_headers(); self.wfile.write(msg); return

            length = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(length).decode("utf-8") if length else ""
            query = {k: v[0] if len(v) == 1 else v for k, v in parse_qs(url.query).items()}
            req = {
                "method": self.command, "url": subpath + (("?" + url.query) if url.query else ""),
                "path": subpath, "headers": dict(self.headers), "query": query, "body": body,
            }
            result = h(req)
            if isinstance(result, dict):
                status = int(result.get("status", 200))
                headers = result.get("headers") or {"content-type": "application/json"}
                rbody = result.get("body", "")
                if not isinstance(rbody, (str, bytes)):
                    rbody = json.dumps(rbody)
                if isinstance(rbody, str):
                    rbody = rbody.encode("utf-8")
                self.send_response(status)
                for k, v in headers.items(): self.send_header(k, str(v))
                self.send_header("content-length", str(len(rbody))); self.end_headers(); self.wfile.write(rbody)
            elif isinstance(result, (str, bytes)):
                rbody = result.encode("utf-8") if isinstance(result, str) else result
                self.send_response(200); self.send_header("content-type", "text/plain")
                self.send_header("content-length", str(len(rbody))); self.end_headers(); self.wfile.write(rbody)
            else:
                rbody = json.dumps(result).encode("utf-8")
                self.send_response(200); self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(rbody))); self.end_headers(); self.wfile.write(rbody)
        except Exception as e:
            tb = traceback.format_exc()
            print("[runner] handler error:", tb, flush=True)
            body = json.dumps({"error": str(e), "stack": tb}).encode()
            self.send_response(500); self.send_header("content-type", "application/json")
            self.end_headers(); self.wfile.write(body)

    def do_GET(self): self._serve()
    def do_POST(self): self._serve()
    def do_PUT(self): self._serve()
    def do_DELETE(self): self._serve()
    def do_PATCH(self): self._serve()
    def do_OPTIONS(self): self._serve()

print("[python-runner] listening on " + str(PORT), flush=True)
ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
`;
