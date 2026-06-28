// Runner script (Node 20) embedded at deploy time into the container as /app/runner.cjs.
// Listens on PORT (default 8000), routes /{slug}/... to /app/src/{slug}/index.js,
// installs npm dependencies from package.json on first load, and supports either:
// - a plain exported handler(reqObj)
// - an Express app that calls app.listen() during module initialization

export const NODE_RUNNER_SOURCE = String.raw`
"use strict";
const http = require("http");
const path = require("path");
const fs = require("fs");
const { EventEmitter } = require("events");
const { execFileSync } = require("child_process");

const PORT = Number(process.env.PORT || 8000);
const ROOT = "/app/src";
const loadedEntries = new Map();

function isExpressApp(value) {
  return Boolean(value)
    && typeof value === "function"
    && typeof value.use === "function"
    && typeof value.handle === "function"
    && typeof value.listen === "function";
}

function makeStubServer(done) {
  const server = new EventEmitter();
  server.listen = () => server;
  server.close = () => server;
  server.address = () => ({ address: "0.0.0.0", family: "IPv4", port: 0 });
  if (typeof done === "function") process.nextTick(done);
  process.nextTick(() => server.emit("listening"));
  return server;
}

function hasDependencyEntries(pkg) {
  if (!pkg || typeof pkg !== "object") return false;
  const groups = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  return groups.some((key) => {
    const group = pkg[key];
    return group && typeof group === "object" && Object.keys(group).length > 0;
  });
}

function ensureNodeDependencies(dir) {
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) return;
  const nodeModulesPath = path.join(dir, "node_modules");
  if (fs.existsSync(nodeModulesPath)) return;

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch (e) {
    throw new Error("invalid package.json in " + dir + ": " + String(e && e.message || e));
  }

  if (!hasDependencyEntries(pkg)) return;

  const lockPath = path.join(dir, "package-lock.json");
  const args = fs.existsSync(lockPath)
    ? ["ci", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"]
    : ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"];

  console.log("[runner] installing npm dependencies for " + dir + " via npm " + args[0]);
  execFileSync("npm", args, { cwd: dir, stdio: "inherit" });
}

function resolveEntry(dir) {
  const manifestPath = path.join(dir, ".vortex-entrypoint");
  if (fs.existsSync(manifestPath)) {
    try {
      const raw = fs.readFileSync(manifestPath, "utf8").trim();
      if (raw) {
        const candidate = path.join(dir, raw);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch (e) {
      console.error("[runner] failed to read entrypoint manifest for " + dir + ":", e);
    }
  }

  const candidates = ["index.js", "index.cjs", "main.js", "handler.js"];
  for (const c of candidates) {
    const candidate = path.join(dir, c);
    if (fs.existsSync(candidate)) return candidate;
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js") || f.endsWith(".cjs"));
  if (files.length) return path.join(dir, files[0]);

  return null;
}

function loadModule(entry, dir) {
  ensureNodeDependencies(dir);

  let express = null;
  let restoreListen = null;
  let capturedExpressApp = null;

  try {
    try {
      express = require("express");
      if (express && express.application && typeof express.application.listen === "function") {
        restoreListen = express.application.listen;
        express.application.listen = function patchedListen() {
          capturedExpressApp = this;
          const server = makeStubServer();
          const args = Array.prototype.slice.call(arguments);
          const callback = args.find((arg) => typeof arg === "function");
          if (typeof callback === "function") process.nextTick(() => callback.call(server));
          return server;
        };
      }
    } catch (e) {
      // express is optional; ignore if not installed.
    }

    const mod = require(entry);
    let candidate = null;
    if (typeof mod === "function") candidate = mod;
    else if (mod && typeof mod.default === "function") candidate = mod.default;
    else if (mod && typeof mod.handler === "function") candidate = mod.handler;

    if (!candidate && capturedExpressApp) candidate = capturedExpressApp;
    if (!candidate) {
      return { __loadError: "Module has no supported export and did not capture an Express app" };
    }
    if (isExpressApp(candidate)) return { kind: "express", app: candidate };
    if (typeof candidate === "function") return { kind: "handler", handler: candidate };
    return { __loadError: "Unsupported export type from " + entry };
  } catch (e) {
    console.error("[runner] failed to load " + entry + ":", e);
    return { __loadError: String(e && e.stack || e) };
  } finally {
    if (restoreListen && express && express.application) {
      express.application.listen = restoreListen;
    }
  }
}

function loadHandler(slug) {
  const cached = loadedEntries.get(slug);
  if (cached) return cached;

  const dir = path.join(ROOT, slug);
  if (!fs.existsSync(dir)) return null;
  const entry = resolveEntry(dir);
  if (!entry) return null;

  const loaded = loadModule(entry, dir);
  if (!loaded || loaded.__loadError) return loaded;

  loadedEntries.set(slug, loaded);
  return loaded;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function corsHeaders(origin, requestedHeaders) {
  const headers = {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-api-key, x-admin-token, x-requested-with, accept, origin",
    "access-control-expose-headers": "*",
    "access-control-max-age": "86400",
  };
  if (requestedHeaders) headers["access-control-allow-headers"] = requestedHeaders;
  return headers;
}

function applyCors(res, origin, requestedHeaders) {
  const headers = corsHeaders(origin, requestedHeaders);
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
}

function sendHandlerResult(res, result, origin, requestedHeaders) {
  if (result && typeof result === "object") {
    const status = result.status || 200;
    const headers = Object.assign({}, result.headers || {}, corsHeaders(origin, requestedHeaders));
    res.writeHead(status, headers);
    const out = typeof result.body === "string" ? result.body
              : Buffer.isBuffer(result.body) ? result.body
              : result.body == null ? "" : JSON.stringify(result.body);
    res.end(out);
    return status;
  }

  if (typeof result === "string") {
    const headers = Object.assign({ "content-type": "text/plain" }, corsHeaders(origin, requestedHeaders));
    res.writeHead(200, headers);
    res.end(result);
    return 200;
  }

  const headers = Object.assign({ "content-type": "application/json" }, corsHeaders(origin, requestedHeaders));
  res.writeHead(200, headers);
  res.end(JSON.stringify(result ?? null));
  return 200;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || "/", "http://x");
    const origin = req.headers.origin || null;
    const requestedHeaders = req.headers["access-control-request-headers"] || null;

    if (u.pathname === "/__health" || u.pathname === "/health") {
      applyCors(res, origin, requestedHeaders);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", runtime: "node" }));
    }

    if (req.method === "OPTIONS") {
      const headers = corsHeaders(origin, requestedHeaders);
      res.writeHead(204, headers);
      return res.end();
    }

    const m = u.pathname.match(/^\/([^\/]+)(\/.*)?$/);
    if (!m) {
      applyCors(res, origin, requestedHeaders);
      res.writeHead(404);
      return res.end("Not found");
    }

    const slug = m[1];
    const subpath = m[2] || "/";
    const loaded = loadHandler(slug);
    if (!loaded) {
      applyCors(res, origin, requestedHeaders);
      res.writeHead(404);
      return res.end("Function '" + slug + "' not found");
    }
    if (loaded.__loadError) {
      applyCors(res, origin, requestedHeaders);
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "load_error", detail: loaded.__loadError }));
    }

    const started = Date.now();

    if (loaded.kind === "express") {
      applyCors(res, origin, requestedHeaders);
      const originalUrl = req.url;
      req.url = subpath + (u.search || "");
      res.on("finish", () => {
        console.log("[" + req.method + " " + originalUrl + "] -> " + res.statusCode + " in " + (Date.now() - started) + "ms");
      });
      loaded.app(req, res);
      return;
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
    const result = await loaded.handler(reqObj);
    const status = sendHandlerResult(res, result, origin, requestedHeaders);
    console.log("[" + req.method + " " + req.url + "] -> " + (status || 200) + " in " + (Date.now() - started) + "ms");
  } catch (e) {
    console.error("[runner] handler error:", e);
    if (!res.headersSent) applyCors(res, null, null);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e && e.message || e), stack: String(e && e.stack || "") }));
  }
});

server.listen(PORT, "0.0.0.0", () => console.log("[node-runner] listening on " + PORT));
`;
