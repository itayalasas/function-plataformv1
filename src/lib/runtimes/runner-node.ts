// Runner script (Node 20) embedded at deploy time into the container as /app/runner.cjs.
// Listens on PORT (default 8000), routes /{slug}/... to /app/src/{slug}/index.js,
// installs npm dependencies from package.json on first load, and supports either:
// - a plain exported handler(reqObj)
// - an Express app that calls app.listen() during module initialization

export const NODE_RUNNER_SOURCE = String.raw`
"use strict";
const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");
const { EventEmitter } = require("events");
const { AsyncLocalStorage } = require("async_hooks");
const { execFileSync } = require("child_process");

const PORT = Number(process.env.PORT || 8000);
const ROOT = "/app/src";
const loadedEntries = new Map();
const LOG_INGEST_URL = process.env.VORTEX_LOG_INGEST_URL || "";
const LOG_TOKEN = process.env.VORTEX_LOG_TOKEN || "";
const outboundContext = new AsyncLocalStorage();

function toBuffer(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === "string") return Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8");
  return Buffer.from(String(chunk ?? ""), "utf8");
}

function isExpressApp(value) {
  return Boolean(value)
    && typeof value === "function"
    && typeof value.use === "function"
    && typeof value.handle === "function"
    && typeof value.listen === "function";
}

function redactHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (/^(authorization|x-api-key|x-admin-token|x-vortex-log-token|cookie|set-cookie|proxy-authorization)$/i.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = value;
  }
  return out;
}

function trimLogText(value, limit = 8000) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "... [truncated " + String(text.length - limit) + " chars]";
}

function installResponseCapture(res) {
  const chunks = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = function patchedWrite(chunk, encoding, callback) {
    if (chunk !== undefined && chunk !== null) chunks.push(toBuffer(chunk, encoding));
    return originalWrite(chunk, encoding, callback);
  };

  res.end = function patchedEnd(chunk, encoding, callback) {
    if (chunk !== undefined && chunk !== null) chunks.push(toBuffer(chunk, encoding));
    return originalEnd(chunk, encoding, callback);
  };

  return () => trimLogText(Buffer.concat(chunks).toString("utf8"));
}

async function sendRuntimeLog(entry) {
  if (!LOG_INGEST_URL || !LOG_TOKEN) return;
  try {
    await fetch(LOG_INGEST_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vortex-log-token": LOG_TOKEN,
      },
      body: JSON.stringify({
        projectId: process.env.PROJECT_ID || "",
        token: LOG_TOKEN,
        level: entry.level,
        source: entry.source,
        message: entry.message,
        meta: entry.meta,
      }),
    });
  } catch (error) {
    console.error("[runner] failed to send runtime log:", error);
  }
}

function getCurrentInvocation() {
  return outboundContext.getStore() || null;
}

function toPlainHeaders(headers) {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) {
    const out = {};
    for (const pair of headers) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      out[String(pair[0])] = String(pair[1]);
    }
    return out;
  }
  if (typeof headers === "object") {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
      out[key] = Array.isArray(value) ? value.map((item) => String(item)).join(", ") : String(value);
    }
    return out;
  }
  return {};
}

function trimMaybeBody(body, limit = 8000) {
  if (body == null) return null;
  if (Buffer.isBuffer(body)) return trimLogText(body.toString("utf8"), limit);
  if (body instanceof Uint8Array) return trimLogText(Buffer.from(body).toString("utf8"), limit);
  return trimLogText(String(body), limit);
}

function shouldSkipOutboundLog(target) {
  if (!target) return true;
  if (!LOG_INGEST_URL) return false;
  try {
    return new URL(target).href === new URL(LOG_INGEST_URL).href;
  } catch {
    return target === LOG_INGEST_URL;
  }
}

function queueOutboundLog({
  method,
  target,
  requestHeaders,
  requestBody,
  status,
  responseHeaders,
  responseBody,
  error,
  durationMs,
}: {
  method: string;
  target: string;
  requestHeaders: Record<string, unknown>;
  requestBody: string | null;
  status: number | null;
  responseHeaders: Record<string, unknown>;
  responseBody: string | null;
  error?: string | null;
  durationMs: number;
}) {
  const invocation = getCurrentInvocation();
  if (!invocation) return;

  void sendRuntimeLog({
    level: error ? "error" : (status || 200) >= 400 ? "warn" : "info",
    source: "outbound",
    message: "-> " + method + " " + target + " | <- " + (error ? "ERR" : String(status || 0)) + " (" + durationMs + "ms)",
    meta: {
      runtime: "node",
      function: invocation.function,
      kind: "outbound",
      target,
      request: {
        method,
        path: (() => {
          try {
            const u = new URL(target);
            return u.pathname + u.search;
          } catch {
            return target;
          }
        })(),
        url: target,
        headers: requestHeaders,
        body: requestBody,
      },
      response: {
        status: status,
        headers: responseHeaders,
        body: responseBody,
      },
      error: error || null,
      durationMs,
    },
  });
}

function installFetchOutboundLogging() {
  if (typeof global.fetch !== "function") return;
  const originalFetch = global.fetch.bind(global);
  global.fetch = async function patchedFetch(input, init) {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    const target = request.url;
    if (shouldSkipOutboundLog(target) || !getCurrentInvocation()) {
      return originalFetch(input, init);
    }

    const started = Date.now();
    const requestHeaders = redactHeaders(Object.fromEntries(request.headers.entries()));
    let requestBody = null;
    if (!["GET", "HEAD"].includes(request.method)) {
      try {
        requestBody = trimMaybeBody(await request.clone().text());
      } catch {
        requestBody = "[unreadable]";
      }
    }

    try {
      const response = await originalFetch(request);
      let responseBody = null;
      try {
        responseBody = trimMaybeBody(await response.clone().text());
      } catch {
        responseBody = "[unreadable]";
      }
      queueOutboundLog({
        method: request.method,
        target,
        requestHeaders,
        requestBody,
        status: response.status,
        responseHeaders: redactHeaders(Object.fromEntries(response.headers.entries())),
        responseBody,
        durationMs: Date.now() - started,
      });
      return response;
    } catch (error) {
      queueOutboundLog({
        method: request.method,
        target,
        requestHeaders,
        requestBody,
        status: null,
        responseHeaders: {},
        responseBody: null,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      });
      throw error;
    }
  };
}

function normalizeHttpOptions(args, protocol) {
  const input = args[0];
  const extra = args.length > 1 && args[1] && typeof args[1] === "object" && !Array.isArray(args[1]) ? args[1] : {};
  if (input instanceof URL) {
    return {
      target: input.toString(),
      method: String(extra.method || "GET").toUpperCase(),
      headers: toPlainHeaders(extra.headers || {}),
      options: input,
    };
  }
  if (typeof input === "string") {
    try {
      const url = new URL(input);
      if (extra && typeof extra === "object") {
        if (typeof extra.path === "string") url.pathname = extra.path.startsWith("/") ? extra.path : "/" + extra.path;
        if (typeof extra.search === "string") url.search = extra.search;
        if (typeof extra.method === "string") url.method = extra.method;
      }
      return {
        target: url.toString(),
        method: String(extra.method || "GET").toUpperCase(),
        headers: toPlainHeaders(extra.headers || {}),
        options: input,
      };
    } catch {
      return {
        target: protocol + "//localhost" + (input.startsWith("/") ? input : "/" + input),
        method: String(extra.method || "GET").toUpperCase(),
        headers: toPlainHeaders(extra.headers || {}),
        options: input,
      };
    }
  }
  if (input && typeof input === "object") {
    const protocolValue = typeof input.protocol === "string" ? input.protocol : protocol;
    const host = typeof input.host === "string"
      ? input.host
      : typeof input.hostname === "string"
        ? String(input.hostname) + (input.port ? ":" + String(input.port) : "")
        : "localhost";
    const pathValue = typeof input.path === "string"
      ? input.path
      : typeof input.pathname === "string"
        ? input.pathname + (typeof input.search === "string" ? input.search : "")
        : "/";
    return {
      target: protocolValue + "//" + host + (pathValue.startsWith("/") ? pathValue : "/" + pathValue),
      method: String(extra.method || input.method || "GET").toUpperCase(),
      headers: toPlainHeaders(extra.headers || input.headers || {}),
      options: input,
    };
  }
  return { target: null, method: String(extra.method || "GET").toUpperCase(), headers: toPlainHeaders(extra.headers || {}), options: input };
}

function patchClientModule(module, protocol) {
  const originalRequest = module.request.bind(module);
  const originalGet = module.get.bind(module);

  const patchedRequest = function () {
    const args = Array.prototype.slice.call(arguments);
    const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
    const normalized = normalizeHttpOptions(args, protocol);
    if (!normalized.target || shouldSkipOutboundLog(normalized.target) || !getCurrentInvocation()) {
      return callback ? originalRequest.apply(module, [...args, callback]) : originalRequest.apply(module, args);
    }

    const started = Date.now();
    const requestChunks = [];
    let finished = false;

    const finish = (status, responseHeaders, responseBody, error) => {
      if (finished) return;
      finished = true;
      queueOutboundLog({
        method: normalized.method,
        target: normalized.target,
        requestHeaders: normalized.headers,
        requestBody: requestChunks.length ? trimMaybeBody(Buffer.concat(requestChunks)) : null,
        status,
        responseHeaders: responseHeaders || {},
        responseBody,
        error,
        durationMs: Date.now() - started,
      });
    };

    const req = originalRequest.call(module, ...args);
    const originalWrite = req.write.bind(req);
    const originalEnd = req.end.bind(req);

    req.write = function patchedWrite(chunk, encoding, callback) {
      if (chunk !== undefined && chunk !== null) requestChunks.push(toBuffer(chunk, encoding));
      return originalWrite(chunk, encoding, callback);
    };

    req.end = function patchedEnd(chunk, encoding, callback) {
      if (chunk !== undefined && chunk !== null) requestChunks.push(toBuffer(chunk, encoding));
      return originalEnd(chunk, encoding, callback);
    };

    req.on("response", (res) => {
      const responseChunks = [];
      res.on("data", (chunk) => {
        if (chunk !== undefined && chunk !== null) responseChunks.push(toBuffer(chunk));
      });
      res.on("end", () => {
        finish(
          typeof res.statusCode === "number" ? res.statusCode : null,
          redactHeaders(res.headers || {}),
          trimMaybeBody(Buffer.concat(responseChunks)),
          null,
        );
      });
      res.on("error", (error) => {
        finish(
          typeof res.statusCode === "number" ? res.statusCode : null,
          redactHeaders(res.headers || {}),
          trimMaybeBody(Buffer.concat(responseChunks)),
          error instanceof Error ? error.message : String(error),
        );
      });
      if (callback) callback(res);
    });

    req.on("error", (error) => {
      finish(null, {}, null, error instanceof Error ? error.message : String(error));
    });

    return req;
  };

  const patchedGet = function () {
    const req = patchedRequest.apply(module, arguments);
    req.end();
    return req;
  };

  module.request = patchedRequest;
  module.get = patchedGet;
}

function installNodeOutboundLogging() {
  installFetchOutboundLogging();
  patchClientModule(http, "http:");
  patchClientModule(https, "https:");
}

installNodeOutboundLogging();

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
    const requestChunks = [];
    req.on("data", (chunk) => {
      if (chunk !== undefined && chunk !== null) requestChunks.push(toBuffer(chunk));
    });
    const getRequestBody = () => trimLogText(Buffer.concat(requestChunks).toString("utf8"));
    const getResponseBody = installResponseCapture(res);
    const requestHeaders = redactHeaders(req.headers);

    const invocationContext = { function: slug };

    await outboundContext.run(invocationContext, async () => {
      if (loaded.kind === "express") {
        applyCors(res, origin, requestedHeaders);
        const originalUrl = req.url;
        req.url = subpath + (u.search || "");
        res.on("finish", () => {
          const duration = Date.now() - started;
          const responseBody = getResponseBody();
          void sendRuntimeLog({
            level: res.statusCode >= 400 ? "warn" : "info",
            source: "runtime",
            message: "-> " + req.method + " " + originalUrl + " | <- " + res.statusCode + " (" + duration + "ms)",
            meta: {
              runtime: "node",
              function: slug,
              request: {
                method: req.method,
                path: originalUrl,
                headers: requestHeaders,
                body: getRequestBody() || null,
                query: Object.fromEntries(u.searchParams.entries()),
              },
              response: {
                status: res.statusCode,
                headers: redactHeaders(res.getHeaders()),
                body: responseBody,
              },
              durationMs: duration,
            },
          });
          console.log("[" + req.method + " " + originalUrl + "] -> " + res.statusCode + " in " + duration + "ms");
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
      const duration = Date.now() - started;
      const responseBody = getResponseBody();
      void sendRuntimeLog({
        level: (status || 200) >= 400 ? "warn" : "info",
        source: "runtime",
        message: "-> " + req.method + " " + req.url + " | <- " + (status || 200) + " (" + duration + "ms)",
        meta: {
          runtime: "node",
          function: slug,
          request: {
            method: req.method,
            path: req.url,
            headers: requestHeaders,
            body: body ? trimLogText(body) : null,
            query,
          },
          response: {
            status: status || 200,
            headers: redactHeaders(res.getHeaders()),
            body: responseBody,
          },
          durationMs: duration,
        },
      });
      console.log("[" + req.method + " " + req.url + "] -> " + (status || 200) + " in " + duration + "ms");
    });
  } catch (e) {
    console.error("[runner] handler error:", e);
    if (!res.headersSent) applyCors(res, null, null);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e && e.message || e), stack: String(e && e.stack || "") }));
  }
});

server.listen(PORT, "0.0.0.0", () => console.log("[node-runner] listening on " + PORT));
`;
