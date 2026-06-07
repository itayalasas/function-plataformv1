import http from "node:http";
import { Readable } from "node:stream";

import server from "./dist/server/server.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";

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

async function handleRequest(nodeReq, nodeRes) {
  try {
    const request = createRequest(nodeReq);
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
