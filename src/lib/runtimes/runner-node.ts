// Runner script (Node 20) embedded at deploy time into the container as /app/runner.cjs.
// Listens on PORT (default 8000), routes /{slug}/... to /app/src/{slug}/index.js
// which must export a default async function handler(req).

export const NODE_RUNNER_SOURCE = String.raw`
"use strict";
const http = require("http");
const path = require("path");
const fs = require("fs");

const PORT = Number(process.env.PORT || 8000);
const ROOT = "/app/src";

function loadHandler(slug) {
  const dir = path.join(ROOT, slug);
  if (!fs.existsSync(dir)) return null;
  const manifestPath = path.join(dir, ".vortex-entrypoint");
  let manifestEntry = null;
  if (fs.existsSync(manifestPath)) {
    try {
      const raw = fs.readFileSync(manifestPath, "utf8").trim();
      if (raw) {
        const candidate = path.join(dir, raw);
        if (fs.existsSync(candidate)) manifestEntry = candidate;
      }
    } catch (e) {
      console.error("[runner] failed to read entrypoint manifest for " + slug + ":", e);
    }
  }
  if (manifestEntry) {
    try {
      Object.keys(require.cache).forEach(k => { if (k.startsWith(dir)) delete require.cache[k]; });
      const mod = require(manifestEntry);
      const handler = typeof mod === "function" ? mod : (mod.default || mod.handler || null);
      if (handler) return handler;
    } catch (e) {
      console.error("[runner] failed to load manifest entrypoint " + manifestEntry + ":", e);
    }
  }
  // Try common entrypoints
  const candidates = ["index.js", "index.cjs", "main.js", "handler.js"];
  let entry = null;
  for (const c of candidates) {
    if (fs.existsSync(path.join(dir, c))) { entry = path.join(dir, c); break; }
  }
  if (!entry) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".js") || f.endsWith(".cjs"));
    if (files.length) entry = path.join(dir, files[0]);
  }
  if (!entry) return null;
  // bust cache for hot-iter on same boot (not needed but safe)
  Object.keys(require.cache).forEach(k => { if (k.startsWith(dir)) delete require.cache[k]; });
  try {
    const mod = require(entry);
    return typeof mod === "function" ? mod : (mod.default || mod.handler || null);
  } catch (e) {
    console.error("[runner] failed to load " + entry + ":", e);
    return { __loadError: String(e && e.stack || e) };
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/__health" || u.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", runtime: "node" }));
    }
    const m = u.pathname.match(/^\/([^\/]+)(\/.*)?$/);
    if (!m) { res.writeHead(404); return res.end("Not found"); }
    const slug = m[1];
    const subpath = m[2] || "/";
    const handler = loadHandler(slug);
    if (!handler) { res.writeHead(404); return res.end("Function '" + slug + "' not found"); }
    if (handler.__loadError) {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "load_error", detail: handler.__loadError }));
    }
    const body = await parseBody(req);
    const query = Object.fromEntries(u.searchParams.entries());
    const reqObj = {
      method: req.method,
      url: subpath + (u.search || ""),
      path: subpath,
      headers: req.headers,
      query,
      body,
    };
    const started = Date.now();
    const result = await handler(reqObj);
    if (result && typeof result === "object") {
      const status = result.status || 200;
      const headers = result.headers || { "content-type": "application/json" };
      res.writeHead(status, headers);
      const out = typeof result.body === "string" ? result.body
                : Buffer.isBuffer(result.body) ? result.body
                : result.body == null ? "" : JSON.stringify(result.body);
      res.end(out);
    } else if (typeof result === "string") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(result);
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result ?? null));
    }
    console.log("[" + req.method + " " + req.url + "] -> " + (result?.status || 200) + " in " + (Date.now() - started) + "ms");
  } catch (e) {
    console.error("[runner] handler error:", e);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e && e.message || e), stack: String(e && e.stack || "") }));
  }
});

server.listen(PORT, "0.0.0.0", () => console.log("[node-runner] listening on " + PORT));
`;
