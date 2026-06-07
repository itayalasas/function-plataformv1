// Project-level Deno runner: one container per project, routes /{fnSlug}/...
// Hot-reloads function code (TTL 3s), project secrets (TTL 3s), and function tokens (TTL 3s) from Neon.
//
// Endpoints:
//   GET  /__health                 - liveness
//   POST /__validate               - compile/validate a candidate set of files
//                                     body: { files: [{path, content}], entrypoint }
//                                     header: x-admin-token: <ADMIN_TOKEN>
//   *    /{slug}/...               - invoke user function
//
// Env: NEON_URL, PROJECT_ID, ADMIN_TOKEN, PORT (default 8000)

import { neon } from "https://esm.sh/@neondatabase/serverless@1.1.0";

const NEON_URL = Deno.env.get("NEON_URL");
const PROJECT_ID = Deno.env.get("PROJECT_ID");
const ADMIN_TOKEN = Deno.env.get("ADMIN_TOKEN") ?? "";
const PORT = Number(Deno.env.get("PORT") ?? "8000");
const RUNNER_VERSION = "2026-05-31-health";

if (!NEON_URL || !PROJECT_ID) {
  console.error("Missing NEON_URL or PROJECT_ID");
  Deno.exit(1);
}

const sql = neon(NEON_URL);

// Seed PG* env vars from a user Postgres connection URL so user code that does
// `new Pool()` (Deno postgres) without arguments connects automatically.
// The runner's own NEON_URL is intentionally excluded unless no user DB URL
// exists; it is metadata plumbing, not the function's application database.
function seedPgEnvFromUrl(force = false) {
  const all = Deno.env.toObject();
  const isPgUrl = (v: string) => /^postgres(ql)?:\/\//i.test(v);
  const preferred = ["DATABASE_URL", "NEON_DATABASE_URL", "FMP_DB_URL", "POSTGRES_URL"];
  let candidate: string | undefined;
  for (const k of preferred) {
    const v = all[k];
    if (v && isPgUrl(v)) { candidate = v; break; }
  }
  if (!candidate) {
    const dbLike = Object.entries(all).find(([k, v]) => k !== "NEON_URL" && /DATABASE_URL$|DB_URL$|PG_URL$/i.test(k) && isPgUrl(v));
    if (dbLike) candidate = dbLike[1];
  }
  if (!candidate) {
    const any = Object.entries(all).find(([k, v]) => k !== "NEON_URL" && isPgUrl(v));
    if (any) candidate = any[1];
  }
  if (!candidate) {
    console.log("[runner] no Postgres URL found in env; PG* not seeded");
    return;
  }
  try {
    const u = new URL(candidate);
    const setIfAbsent = (k: string, v: string) => {
      if ((force || !Deno.env.get(k)) && v) Deno.env.set(k, v);
    };
    setIfAbsent("PGHOST", u.hostname);
    setIfAbsent("PGPORT", u.port || "5432");
    if (u.username) setIfAbsent("PGUSER", decodeURIComponent(u.username));
    if (u.password) setIfAbsent("PGPASSWORD", decodeURIComponent(u.password));
    const db = u.pathname.replace(/^\//, "");
    if (db) setIfAbsent("PGDATABASE", db);
    const sslmode = u.searchParams.get("sslmode") ?? "require";
    setIfAbsent("PGSSLMODE", sslmode);
    if (force || !Deno.env.get("DATABASE_URL")) Deno.env.set("DATABASE_URL", candidate);
    console.log(`[runner] PG* seeded from Postgres URL (host=${u.hostname}, db=${db})`);
  } catch (err) {
    console.error("[runner] failed to parse Postgres URL for PG* env seeding:", err);
  }
}
seedPgEnvFromUrl();


type Handler = (
  req: Request,
  ctx: { tokens: Record<string, string>; functionId: string },
) => Response | Promise<Response>;

interface FnEntry {
  id: string;
  entrypoint: string;
  updatedAt: string;
  handler: Handler;
  loadedAt: number;
}
interface SecretEntry { values: Record<string, string>; loadedAt: number }
interface TokenEntry { values: Record<string, string>; loadedAt: number }

const fnCache = new Map<string, FnEntry>();
let projectSecretsCache: SecretEntry | undefined;
const tokensCache = new Map<string, TokenEntry>();
const CODE_TTL = 3000;
const SECRET_TTL = 3000;
const TOKEN_TTL = 3000;
const tokenEnvOriginals = new Map<string, string | undefined>();

function tokenEnvAliases(name: string): string[] {
  const normalized = name.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const aliases = new Set([name, normalized]);
  if (normalized === "X_API_KEY") aliases.add("API_KEY");
  return Array.from(aliases).filter(Boolean);
}

function applyTokenEnv(tokens: Record<string, string>) {
  const next = new Set<string>();
  for (const [name, value] of Object.entries(tokens)) {
    for (const key of tokenEnvAliases(name)) {
      next.add(key);
      if (!tokenEnvOriginals.has(key)) tokenEnvOriginals.set(key, Deno.env.get(key));
      Deno.env.set(key, value);
    }
  }

  for (const [key, original] of Array.from(tokenEnvOriginals.entries())) {
    if (next.has(key)) continue;
    if (original === undefined) Deno.env.delete(key);
    else Deno.env.set(key, original);
    tokenEnvOriginals.delete(key);
  }

  seedPgEnvFromUrl(true);
}

function applyProjectSecretsEnv(secrets: Record<string, string>) {
  for (const [name, value] of Object.entries(secrets)) {
    Deno.env.set(name, value);
  }
  // Must run after secrets are injected because module-level `new Pool()`
  // reads PG* during import, before handlers execute.
  seedPgEnvFromUrl(true);
}

async function writeFilesToDir(
  dir: string,
  files: Array<{ path: string; content: string }>,
) {
  await Deno.mkdir(dir, { recursive: true });
  for (const f of files) {
    const full = `${dir}/${f.path}`;
    const d = full.substring(0, full.lastIndexOf("/"));
    if (d) await Deno.mkdir(d, { recursive: true });
    await Deno.writeTextFile(full, f.content);
  }
}

// Captures handler from user code that calls `Deno.serve(handler)` instead of
// exporting a default. Set by the Deno.serve stub installed after our listener.
let __capturedHandler: Handler | null = null;

async function importHandler(
  dir: string,
  entrypoint: string,
): Promise<{ handler: Handler | null; error: string | null }> {
  __capturedHandler = null;
  try {
    // Bust module cache so re-validating the same path picks up new code.
    const mod = await import(`file://${dir}/${entrypoint}?v=${Date.now()}`);
    const exported = (typeof mod.default === "function" ? mod.default
      : typeof mod.handler === "function" ? mod.handler : null) as Handler | null;
    const h = exported ?? __capturedHandler;
    if (!h) return { handler: null, error: `Module has no \`default\`/\`handler\` export and did not call Deno.serve(handler)` };
    return { handler: h, error: null };
  } catch (err) {
    return {
      handler: null,
      error: err instanceof Error ? `${err.name}: ${err.message}${err.stack ? "\n" + err.stack : ""}` : String(err),
    };
  }
}

async function loadFunction(slug: string): Promise<FnEntry | null> {
  const cached = fnCache.get(slug);
  const now = Date.now();
  if (cached && now - cached.loadedAt < CODE_TTL) return cached;

  const fns = await sql`SELECT id, entrypoint, updated_at FROM functions WHERE project_id = ${PROJECT_ID} AND slug = ${slug} LIMIT 1` as Array<{ id: string; entrypoint: string; updated_at: string }>;
  if (!fns[0]) return null;
  const fn = fns[0];

  if (cached && cached.updatedAt === fn.updated_at) {
    cached.loadedAt = now;
    return cached;
  }

  const files = await sql`SELECT path, content FROM function_files WHERE function_id = ${fn.id}` as Array<{ path: string; content: string }>;
  const dir = `/tmp/fn/${slug}-${Date.now()}`;
  await writeFilesToDir(dir, files);
  const projectSecrets = await loadProjectSecrets();
  const functionTokens = await loadTokens(fn.id);
  applyProjectSecretsEnv(projectSecrets);
  applyTokenEnv(functionTokens);
  const { handler, error } = await importHandler(dir, fn.entrypoint || "index.ts");
  if (!handler) {
    console.error(`[runner] import failed for ${slug}: ${error}`);
    return null;
  }
  const entry: FnEntry = { id: fn.id, entrypoint: fn.entrypoint, updatedAt: fn.updated_at, handler, loadedAt: now };
  fnCache.set(slug, entry);
  return entry;
}

async function loadProjectSecrets(): Promise<Record<string, string>> {
  const now = Date.now();
  if (projectSecretsCache && now - projectSecretsCache.loadedAt < SECRET_TTL) return projectSecretsCache.values;
  const rows = await sql`SELECT name, value FROM secrets WHERE project_id = ${PROJECT_ID}` as Array<{ name: string; value: string }>;
  const values: Record<string, string> = {};
  for (const r of rows) values[r.name] = r.value;
  projectSecretsCache = { values, loadedAt: now };
  return values;
}

async function loadTokens(fnId: string): Promise<Record<string, string>> {
  const cached = tokensCache.get(fnId);
  const now = Date.now();
  if (cached && now - cached.loadedAt < TOKEN_TTL) return cached.values;
  const rows = await sql`SELECT name, value FROM function_tokens WHERE function_id = ${fnId}` as Array<{ name: string; value: string }>;
  const values: Record<string, string> = {};
  for (const r of rows) values[r.name] = r.value;
  tokensCache.set(fnId, { values, loadedAt: now });
  return values;
}

const __origServe = Deno.serve.bind(Deno);

function installDenoServeStub() {
  // Intercept Deno.serve from user code: capture handler instead of binding a port.
  // Supports signatures: serve(handler), serve(options, handler), serve(options).
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (...args: any[]) => {
    let handler: Handler | null = null;
    for (const a of args) {
      if (typeof a === "function") { handler = a as Handler; break; }
      if (a && typeof a === "object" && typeof (a as { handler?: unknown }).handler === "function") {
        handler = (a as { handler: Handler }).handler;
        break;
      }
    }
    if (handler) __capturedHandler = handler;
    const noop = () => {};
    return {
      finished: new Promise<void>(() => {}),
      shutdown: async () => {},
      ref: noop,
      unref: noop,
      addr: { transport: "tcp", hostname: "0.0.0.0", port: 0 },
      // deno-lint-ignore no-explicit-any
    } as any;
  };
}

installDenoServeStub();

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-api-key, x-admin-token, x-requested-with, accept, origin",
  "access-control-expose-headers": "*",
  "access-control-max-age": "86400",
};

function withCors(res: Response, reqOrigin: string | null): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    if (k === "access-control-allow-origin" && reqOrigin) headers.set(k, reqOrigin);
    else headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

__origServe({ port: PORT, hostname: "0.0.0.0" }, async (req) => {
  const url = new URL(req.url);
  const origin = req.headers.get("origin");

  // Global CORS preflight — answer before auth/routing so browsers always pass.
  if (req.method === "OPTIONS") {
    const reqHeaders = req.headers.get("access-control-request-headers");
    const headers = new Headers(CORS_HEADERS);
    if (origin) headers.set("access-control-allow-origin", origin);
    if (reqHeaders) headers.set("access-control-allow-headers", reqHeaders);
    return new Response(null, { status: 204, headers });
  }

  if (url.pathname === "/" || url.pathname === "") {
    return withCors(new Response(
      `Lovable Functions runner · project ${PROJECT_ID}\nUsa /{slug}/... para invocar una función.\n`,
      { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
    ), origin);
  }

  if (url.pathname === "/__health") return withCors(new Response(`ok ${RUNNER_VERSION}`), origin);

  if (url.pathname === "/health" || url.pathname === "/__status") {
    const started = Date.now();
    let database = "neon";
    let status = "operational";
    try {
      await sql`SELECT 1`;
    } catch (err) {
      console.error("[runner] /health db check failed:", err);
      status = "degraded";
      database = "unavailable";
    }
    const body = {
      status,
      version: RUNNER_VERSION,
      responseTime: Date.now() - started,
      database,
      provider: "azure-container-apps",
      projectId: PROJECT_ID,
      timestamp: new Date().toISOString(),
    };
    return withCors(new Response(JSON.stringify(body), {
      status: status === "operational" ? 200 : 503,
      headers: { "content-type": "application/json" },
    }), origin);
  }

  if (url.pathname === "/__validate" && req.method === "POST") {
    if (!ADMIN_TOKEN || req.headers.get("x-admin-token") !== ADMIN_TOKEN) {
      return withCors(new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      }), origin);
    }
    let body: { files?: Array<{ path: string; content: string }>; entrypoint?: string; functionId?: string };
    try { body = await req.json(); } catch {
      return withCors(new Response(JSON.stringify({ ok: false, error: "invalid json" }), {
        status: 400, headers: { "content-type": "application/json" },
      }), origin);
    }
    const files = body.files ?? [];
    const entrypoint = body.entrypoint || "index.ts";
    if (!files.length) {
      return withCors(new Response(JSON.stringify({ ok: false, error: "no files" }), {
        status: 400, headers: { "content-type": "application/json" },
      }), origin);
    }
    try {
      const projectSecrets = await loadProjectSecrets();
      applyProjectSecretsEnv(projectSecrets);
    } catch (err) {
      console.warn("[runner] /__validate could not load project secrets:", err);
    }
    if (body.functionId) {
      try {
        const tokens = await loadTokens(body.functionId);
        applyTokenEnv(tokens);
      } catch (err) {
        console.warn("[runner] /__validate could not load tokens:", err);
      }
    }
    const dir = `/tmp/validate/${crypto.randomUUID()}`;
    try {
      await writeFilesToDir(dir, files);
      const { handler, error } = await importHandler(dir, entrypoint);
      if (!handler) {
        return withCors(new Response(JSON.stringify({ ok: false, error }), {
          status: 200, headers: { "content-type": "application/json" },
        }), origin);
      }
      return withCors(new Response(JSON.stringify({ ok: true, runnerVersion: RUNNER_VERSION }), {
        status: 200, headers: { "content-type": "application/json" },
      }), origin);
    } finally {
      try { await Deno.remove(dir, { recursive: true }); } catch { /* ignore */ }
    }
  }


  const parts = url.pathname.split("/").filter(Boolean);
  const slug = parts[0];
  if (!slug) {
    return withCors(new Response(JSON.stringify({ error: "function slug required: /{slug}/..." }), {
      status: 400, headers: { "content-type": "application/json" },
    }), origin);
  }

  const fn = await loadFunction(slug);
  if (!fn) return withCors(new Response(JSON.stringify({ error: `function "${slug}" not found` }), { status: 404, headers: { "content-type": "application/json" } }), origin);

  const innerUrl = new URL(req.url);
  innerUrl.pathname = "/" + parts.slice(1).join("/");
  const innerReq = new Request(innerUrl.toString(), req);

  const projectSecrets = await loadProjectSecrets();
  const tokens = await loadTokens(fn.id);
  applyProjectSecretsEnv(projectSecrets);
  applyTokenEnv(tokens);
  try {
    const res = await fn.handler(innerReq, { tokens, functionId: fn.id });
    return withCors(res, origin);
  } catch (err) {
    console.error(`[runner] ${slug} threw:`, err);
    return withCors(new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { "content-type": "application/json" } },
    ), origin);
  }
});

console.log(`[runner] project=${PROJECT_ID} listening on :${PORT} version=${RUNNER_VERSION}`);

