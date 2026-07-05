// Runner script (Python 3.12) embedded at deploy time into the container as /app/runner.py.
// Listens on PORT (default 8000), routes /{slug}/... to /app/src/{slug}/index.py
// which must define a `handler(req)` function.

export const PYTHON_RUNNER_SOURCE = String.raw`
import os, sys, json, importlib.util, traceback, threading, urllib.request, urllib.response, io, time, socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", "8000"))
ROOT = "/app/src"
LOG_INGEST_URL = os.environ.get("VORTEX_LOG_INGEST_URL", "")
LOG_TOKEN = os.environ.get("VORTEX_LOG_TOKEN", "")
REQUEST_CONTEXT = threading.local()

def redact_headers(headers):
    redacted = {}
    for key, value in headers.items():
        if key.lower() in {"authorization", "x-api-key", "x-admin-token", "x-vortex-log-token", "cookie", "set-cookie", "proxy-authorization"}:
            redacted[key] = "[redacted]"
        else:
            redacted[key] = value
    return redacted

def trim_log_text(value, limit=8000):
    text = value if isinstance(value, str) else str(value or "")
    if len(text) <= limit:
        return text
    return text[:limit] + "... [truncated %d chars]" % (len(text) - limit)

def send_runtime_log(entry):
    if not LOG_INGEST_URL or not LOG_TOKEN:
        return
    try:
        payload = json.dumps({
            "projectId": os.environ.get("PROJECT_ID", ""),
            "token": LOG_TOKEN,
            "level": entry.get("level", "info"),
            "source": entry.get("source", "runtime"),
            "message": entry.get("message", ""),
            "meta": entry.get("meta") or {},
        }).encode("utf-8")
        req = urllib.request.Request(
            LOG_INGEST_URL,
            data=payload,
            headers={
                "content-type": "application/json",
                "x-vortex-log-token": LOG_TOKEN,
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            resp.read()
    except Exception as e:
        print("[runner] failed to send runtime log:", e, flush=True)

def set_current_invocation(function_slug):
    REQUEST_CONTEXT.function = function_slug

def clear_current_invocation():
    if hasattr(REQUEST_CONTEXT, "function"):
        del REQUEST_CONTEXT.function

def get_current_invocation():
    return getattr(REQUEST_CONTEXT, "function", None)

def should_skip_outbound_log(target):
    if not target:
        return True
    if not LOG_INGEST_URL:
        return False
    try:
        return urlparse(str(target)).geturl() == urlparse(LOG_INGEST_URL).geturl()
    except Exception:
        return str(target) == LOG_INGEST_URL

def to_plain_headers(headers):
    if not headers:
        return {}
    if hasattr(headers, "items"):
        return {str(k): str(v) for k, v in headers.items()}
    return {str(k): str(v) for k, v in dict(headers).items()}

def trim_body(value):
    if value is None:
        return None
    if isinstance(value, bytes):
        return trim_log_text(value.decode("utf-8", errors="replace"))
    return trim_log_text(str(value))

def queue_outbound_log(method, target, request_headers, request_body, status, response_headers, response_body, error=None, duration_ms=0):
    function = get_current_invocation()
    if not function:
        return
    payload = {
        "level": "error" if error else ("warn" if (status or 200) >= 400 else "info"),
        "source": "outbound",
        "message": f"-> {method} {target} | <- {status if not error else 'ERR'} ({duration_ms}ms)",
        "meta": {
            "runtime": "python",
            "function": function,
            "kind": "outbound",
            "target": target,
            "request": {
                "method": method,
                "path": (urlparse(target).path + (f"?{urlparse(target).query}" if urlparse(target).query else "")) if target else "",
                "url": target,
                "headers": request_headers,
                "body": request_body,
            },
            "response": {
                "status": status,
                "headers": response_headers,
                "body": response_body,
            },
            "error": error,
            "durationMs": duration_ms,
        },
    }
    threading.Thread(target=send_runtime_log, args=(payload,), daemon=True).start()

def install_outbound_logging():
    original_urlopen = urllib.request.urlopen

    def logged_urlopen(url, data=None, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, *, cafile=None, capath=None, cadefault=False, context=None):
        target = getattr(url, "full_url", None) or getattr(url, "get_full_url", lambda: None)() or str(url)
        if should_skip_outbound_log(target) or not get_current_invocation():
            return original_urlopen(url, data=data, timeout=timeout, cafile=cafile, capath=capath, cadefault=cadefault, context=context)

        started = time.time()
        request_method = getattr(url, "get_method", lambda: "GET")()
        request_headers = redact_headers(to_plain_headers(getattr(url, "headers", {})))
        request_body = getattr(url, "data", data)
        try:
            response = original_urlopen(url, data=data, timeout=timeout, cafile=cafile, capath=capath, cadefault=cadefault, context=context)
            response_body = response.read()
            response_headers = redact_headers(to_plain_headers(getattr(response, "headers", {})))
            response_status = getattr(response, "status", None) or getattr(response, "code", None) or 200
            queue_outbound_log(
                request_method,
                target,
                request_headers,
                trim_body(request_body),
                response_status,
                response_headers,
                trim_body(response_body),
                duration_ms=int((time.time() - started) * 1000),
            )
            buffer = io.BytesIO(response_body)
            wrapped = urllib.response.addinfourl(buffer, response.headers, response.geturl(), response_status)
            if hasattr(response, "msg"):
                wrapped.msg = response.msg
            return wrapped
        except Exception as e:
            queue_outbound_log(
                request_method,
                target,
                request_headers,
                trim_body(request_body),
                None,
                {},
                None,
                error=str(e),
                duration_ms=int((time.time() - started) * 1000),
            )
            raise

    urllib.request.urlopen = logged_urlopen

    try:
        import requests

        original_session_request = requests.sessions.Session.request

        def logged_session_request(self, method, url, *args, **kwargs):
            if should_skip_outbound_log(url) or not get_current_invocation():
                return original_session_request(self, method, url, *args, **kwargs)

            started = time.time()
            try:
                response = original_session_request(self, method, url, *args, **kwargs)
                try:
                    response_body = trim_body(response.text)
                except Exception:
                    response_body = "[unreadable]"
                request_headers = redact_headers(to_plain_headers(getattr(response.request, "headers", kwargs.get("headers", {}))))
                request_body = trim_body(getattr(response.request, "body", kwargs.get("data") or kwargs.get("json")))
                response_headers = redact_headers(to_plain_headers(getattr(response, "headers", {})))
                queue_outbound_log(
                    str(method).upper(),
                    getattr(response.request, "url", url),
                    request_headers,
                    request_body,
                    getattr(response, "status_code", None),
                    response_headers,
                    response_body,
                    duration_ms=int((time.time() - started) * 1000),
                )
                return response
            except Exception as e:
                request_headers = redact_headers(to_plain_headers(kwargs.get("headers", {})))
                request_body = trim_body(kwargs.get("data") or kwargs.get("json"))
                queue_outbound_log(
                    str(method).upper(),
                    str(url),
                    request_headers,
                    request_body,
                    None,
                    {},
                    None,
                    error=str(e),
                    duration_ms=int((time.time() - started) * 1000),
                )
                raise

        requests.sessions.Session.request = logged_session_request
    except Exception:
        pass

install_outbound_logging()

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

            started_at = time.time()
            length = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(length).decode("utf-8") if length else ""
            query = {k: v[0] if len(v) == 1 else v for k, v in parse_qs(url.query).items()}
            request_headers = redact_headers(dict(self.headers))
            request_path = subpath + (("?" + url.query) if url.query else "")

            def emit_log(status, response_headers, response_body, error=None):
                duration = int((time.time() - started_at) * 1000)
                payload = {
                    "level": "error" if error else ("warn" if status >= 400 else "info"),
                    "source": "runtime",
                    "message": f"-> {self.command} {request_path} | <- {status if not error else 'ERR'} ({duration}ms)",
                    "meta": {
                        "runtime": "python",
                        "function": slug,
                        "request": {
                            "method": self.command,
                            "path": request_path,
                            "headers": request_headers,
                            "body": trim_log_text(body) if body else None,
                            "query": query,
                        },
                        "response": {
                            "status": status,
                            "headers": response_headers,
                            "body": response_body,
                        },
                        "durationMs": duration,
                    },
                }
                if error:
                    payload["meta"]["error"] = error
                threading.Thread(target=send_runtime_log, args=(payload,), daemon=True).start()

            req = {
                "method": self.command, "url": request_path,
                "path": subpath, "headers": request_headers, "query": query, "body": body,
            }
            set_current_invocation(slug)
            try:
                result = h(req)
                if isinstance(result, dict):
                    status = int(result.get("status", 200))
                    headers = result.get("headers") or {"content-type": "application/json"}
                    rbody = result.get("body", "")
                    if not isinstance(rbody, (str, bytes)):
                        rbody = json.dumps(rbody)
                    if isinstance(rbody, str):
                        rbody = rbody.encode("utf-8")
                    response_headers = {k: str(v) for k, v in headers.items()}
                    self.send_response(status)
                    for k, v in response_headers.items(): self.send_header(k, v)
                    self.send_header("content-length", str(len(rbody))); self.end_headers(); self.wfile.write(rbody)
                    emit_log(status, response_headers, trim_log_text(rbody.decode("utf-8", errors="replace")))
                elif isinstance(result, (str, bytes)):
                    rbody = result.encode("utf-8") if isinstance(result, str) else result
                    response_headers = {"content-type": "text/plain"}
                    self.send_response(200); self.send_header("content-type", "text/plain")
                    self.send_header("content-length", str(len(rbody))); self.end_headers(); self.wfile.write(rbody)
                    emit_log(200, response_headers, trim_log_text(rbody.decode("utf-8", errors="replace")))
                else:
                    rbody = json.dumps(result).encode("utf-8")
                    response_headers = {"content-type": "application/json"}
                    self.send_response(200); self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(rbody))); self.end_headers(); self.wfile.write(rbody)
                    emit_log(200, response_headers, trim_log_text(rbody.decode("utf-8", errors="replace")))
            finally:
                clear_current_invocation()
        except Exception as e:
            tb = traceback.format_exc()
            print("[runner] handler error:", tb, flush=True)
            body = json.dumps({"error": str(e), "stack": tb}).encode()
            self.send_response(500); self.send_header("content-type", "application/json")
            self.end_headers(); self.wfile.write(body)
            if "emit_log" in locals():
                emit_log(500, {"content-type": "application/json"}, trim_log_text(body.decode("utf-8", errors="replace")), str(e))

    def do_GET(self): self._serve()
    def do_POST(self): self._serve()
    def do_PUT(self): self._serve()
    def do_DELETE(self): self._serve()
    def do_PATCH(self): self._serve()
    def do_OPTIONS(self): self._serve()

print("[python-runner] listening on " + str(PORT), flush=True)
ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
`;
