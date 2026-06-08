import http from "node:http";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const CLIENT_DIR = path.resolve(process.cwd(), "dist", "client");

const LOADING_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Vortex Functions</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, sans-serif; background: #0b1020; color: #e5eefc; }
      .card { padding: 24px 28px; border: 1px solid rgba(148,163,184,.25); border-radius: 16px; background: rgba(15,23,42,.78); box-shadow: 0 24px 80px rgba(0,0,0,.35); text-align: center; }
      .dot { width: 10px; height: 10px; border-radius: 999px; display: inline-block; margin-right: 8px; background: #38bdf8; box-shadow: 0 0 18px #38bdf8; animation: pulse 1.2s infinite ease-in-out; }
      @keyframes pulse { 0%,100% { opacity: .35; transform: scale(.95); } 50% { opacity: 1; transform: scale(1.1); } }
    </style>
  </head>
  <body>
    <div class="card">
      <div><span class="dot"></span>Starting Vortex Functions</div>
    </div>
  </body>
</html>`;

let serverPromise;
let serverReady = false;
let serverLoadError;
function getServer() {
  if (!serverPromise) {
    const serverBundlePath = path.resolve(process.cwd(), "dist", "server", "server.js");
    serverPromise = import(pathToFileURL(serverBundlePath).href).then((mod) => mod.default ?? mod);
  }
  return serverPromise;
}

void getServer()
  .then(() => {
    serverReady = true;
  })
  .catch((error) => {
    serverLoadError = error;
    console.error("[boot] failed to load server bundle", error);
  });

function toFetchHeaders(nodeHeaders) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
      continue;
    }
    headers.set(key, value);
  }
  return headers;
}

function createRequest(nodeReq) {
  const method = nodeReq.method ?? "GET";
  const url = new URL(nodeReq.url ?? "/", `http://${nodeReq.headers.host ?? "localhost"}`);
  const init = {
    method,
    headers: toFetchHeaders(nodeReq.headers),
  };

  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(nodeReq);
    init.duplex = "half";
  }

  return new Request(url, init);
}

function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function isStaticAsset(pathname) {
  return pathname.startsWith("/assets/") || pathname === "/favicon.svg";
}

function resolveClientFile(pathname) {
  const relativePath = pathname.replace(/^\/+/, "");
  const filePath = path.resolve(CLIENT_DIR, relativePath);
  const clientPrefix = CLIENT_DIR.endsWith(path.sep) ? CLIENT_DIR : `${CLIENT_DIR}${path.sep}`;
  if (filePath !== CLIENT_DIR && !filePath.startsWith(clientPrefix)) {
    return null;
  }
  return filePath;
}

async function tryServeStatic(nodeReq, nodeRes) {
  const url = new URL(nodeReq.url ?? "/", `http://${nodeReq.headers.host ?? "localhost"}`);
  if (!isStaticAsset(url.pathname)) return false;

  const filePath = resolveClientFile(url.pathname);
  if (!filePath) {
    nodeRes.statusCode = 400;
    nodeRes.setHeader("content-type", "text/plain; charset=utf-8");
    nodeRes.end("Bad Request");
    return true;
  }

  try {
    await access(filePath, fsConstants.R_OK);
  } catch {
    nodeRes.statusCode = 404;
    nodeRes.setHeader("content-type", "text/plain; charset=utf-8");
    nodeRes.setHeader("cache-control", "no-store");
    nodeRes.end("Not Found");
    return true;
  }

  nodeRes.statusCode = 200;
  nodeRes.setHeader("content-type", contentTypeFor(filePath));
  nodeRes.setHeader(
    "cache-control",
    url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600",
  );
  createReadStream(filePath).pipe(nodeRes);
  return true;
}

async function handleRequest(nodeReq, nodeRes) {
  try {
    const url = new URL(nodeReq.url ?? "/", `http://${nodeReq.headers.host ?? "localhost"}`);
    if (url.pathname === "/__health") {
      nodeRes.statusCode = 200;
      nodeRes.setHeader("content-type", "application/json; charset=utf-8");
      nodeRes.setHeader("cache-control", "no-store");
      nodeRes.end(JSON.stringify({ status: "ok", runtime: "web" }));
      return;
    }

    if (await tryServeStatic(nodeReq, nodeRes)) {
      return;
    }

    if (serverLoadError) {
      throw serverLoadError;
    }

    if (!serverReady) {
      nodeRes.statusCode = 200;
      nodeRes.setHeader("content-type", "text/html; charset=utf-8");
      nodeRes.setHeader("cache-control", "no-store");
      nodeRes.end(LOADING_HTML);
      return;
    }

    const request = createRequest(nodeReq);
    const server = await getServer();
    const response = await server.fetch(request, {}, {});

    nodeRes.statusCode = response.status;
    for (const [key, value] of response.headers.entries()) {
      nodeRes.setHeader(key, value);
    }

    if (!response.body) {
      nodeRes.end();
      return;
    }

    Readable.fromWeb(response.body).pipe(nodeRes);
  } catch (error) {
    console.error(error);
    if (!nodeRes.headersSent) nodeRes.statusCode = 500;
    nodeRes.setHeader("content-type", "text/plain; charset=utf-8");
    nodeRes.end("Internal Server Error");
  }
}

http.createServer(handleRequest).listen(PORT, HOST, () => {
  console.log(`[boot] listening on http://${HOST}:${PORT}`);
});
