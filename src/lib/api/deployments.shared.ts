import { sql, ensureSchema, logEvent } from "../neon/db.server.ts";
import { upsertContainerApp, sanitizeAcaName } from "../azure/aca.server.ts";
import { RUNNER_SOURCE } from "../runner-source.generated.ts";
import { getRuntimeConfig, type RuntimeId } from "../runtimes/index.ts";
import { NODE_RUNNER_SOURCE } from "../runtimes/runner-node.ts";
import { PYTHON_RUNNER_SOURCE } from "../runtimes/runner-python.ts";
import { getRequest } from "@tanstack/react-start/server";

export type DeployProgressLogger = (
  level: "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
) => void;

function normalizeBaseUrl(input: string | null | undefined): string | null {
  const raw = input?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.endsWith(".local")
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function resolvePlatformBaseUrl(override?: string | null): string | null {
  const candidates = [
    override,
    process.env.VORTEX_PUBLIC_BASE_URL,
    process.env.FUNCTIONS_BASE_URL,
    process.env.PUBLIC_BASE_URL,
    process.env.APP_BASE_URL,
    process.env.SITE_URL,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeBaseUrl(candidate);
    if (normalized) return normalized;
  }

  try {
    const request = getRequest();
    if (request) {
      return normalizeBaseUrl(request.headers.get("origin")) ?? normalizeBaseUrl(request.url);
    }
  } catch {
    // No active request context.
  }

  return null;
}

function createRuntimeLogToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

function buildLoggedDenoRunnerSource(source: string): string {
  if (source.includes("const LOG_INGEST_URL = Deno.env.get(\"VORTEX_LOG_INGEST_URL\") ?? \"\";")) {
    return source;
  }

  const helperBlock = [
    'const LOG_INGEST_URL = Deno.env.get("VORTEX_LOG_INGEST_URL") ?? "";',
    'const LOG_TOKEN = Deno.env.get("VORTEX_LOG_TOKEN") ?? "";',
    '',
    'function redactHeaders(headers: Headers): Record<string, string> {',
    '  const out: Record<string, string> = {};',
    '  for (const [key, value] of headers.entries()) {',
    '    if (/^(authorization|x-api-key|x-admin-token)$/i.test(key)) {',
    '      out[key] = "[redacted]";',
    '      continue;',
    '    }',
    '    out[key] = value;',
    '  }',
    '  return out;',
    '}',
    '',
    'function trimLogText(value: string, limit = 8000): string {',
    '  if (value.length <= limit) return value;',
    '  return value.slice(0, limit) + "... [truncated " + String(value.length - limit) + " chars]";',
    '}',
    '',
    'async function persistInvocationLog(entry: {',
    '  level: "info" | "warn" | "error";',
    '  source: string;',
    '  message: string;',
    '  meta: Record<string, unknown>;',
    '}): Promise<void> {',
    '  if (!LOG_INGEST_URL || !LOG_TOKEN) return;',
    '  try {',
    '    await fetch(LOG_INGEST_URL, {',
    '      method: "POST",',
    '      headers: {',
    '        "content-type": "application/json",',
    '        "x-vortex-log-token": LOG_TOKEN,',
    '      },',
    '      body: JSON.stringify({',
    '        projectId: PROJECT_ID,',
    '        token: LOG_TOKEN,',
    '        level: entry.level,',
    '        source: entry.source,',
    '        message: entry.message,',
    '        meta: entry.meta,',
    '      }),',
    '    });',
    '  } catch (err) {',
    '    console.error("[runner] failed to send runtime log:", err);',
    '  }',
    '}',
  ].join("\n");

  source = source.replace(
    'const tokenEnvOriginals = new Map<string, string | undefined>();\n\nfunction tokenEnvAliases(name: string): string[] {',
    `const tokenEnvOriginals = new Map<string, string | undefined>();\n${helperBlock}\n\nfunction tokenEnvAliases(name: string): string[] {`,
  );

  source = source.replace(
    '  const projectSecrets = await loadProjectSecrets();\n  const tokens = await loadTokens(fn.id);\n  applyProjectSecretsEnv(projectSecrets);\n  applyTokenEnv(tokens);\n  try {\n    const res = await fn.handler(innerReq, { tokens, functionId: fn.id });\n    return withCors(res, origin);\n  } catch (err) {\n    console.error(`[runner] ${slug} threw:`, err);\n    return withCors(new Response(\n      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),\n      { status: 500, headers: { "content-type": "application/json" } },\n    ), origin);\n  }',
    [
      '  const startedAt = Date.now();',
      '  const requestPath = innerUrl.pathname + innerUrl.search;',
      '  const requestHeaders = redactHeaders(innerReq.headers);',
      '  const requestBody = ["GET", "HEAD"].includes(innerReq.method) ? "" : await innerReq.clone().text();',
      '  const projectSecrets = await loadProjectSecrets();',
      '  const tokens = await loadTokens(fn.id);',
      '  applyProjectSecretsEnv(projectSecrets);',
      '  applyTokenEnv(tokens);',
      '  try {',
      '    const response = withCors(await fn.handler(innerReq, { tokens, functionId: fn.id }), origin);',
      '    let responseBody = "";',
      '    try {',
      '      responseBody = trimLogText(await response.clone().text());',
      '    } catch {',
      '      responseBody = "[unreadable]";',
      '    }',
      '    const duration = Date.now() - startedAt;',
      '    await persistInvocationLog({',
      '      level: response.status >= 400 ? "warn" : "info",',
      '      source: "runtime",',
    '      message: "-> " + innerReq.method + " " + requestPath + " | <- " + response.status + " (" + duration + "ms)",',
      '      meta: {',
      '        runtime: "deno",',
      '        function: slug,',
      '        functionId: fn.id,',
      '        request: {',
      '          method: innerReq.method,',
      '          path: requestPath,',
      '          headers: requestHeaders,',
      '          body: requestBody ? trimLogText(requestBody) : null,',
      '          query: Object.fromEntries(innerUrl.searchParams.entries()),',
      '        },',
      '        response: {',
      '          status: response.status,',
      '          headers: redactHeaders(response.headers),',
      '          body: responseBody,',
      '        },',
      '        durationMs: duration,',
      '      },',
      '    });',
      '    return response;',
      '  } catch (err) {',
      '    const duration = Date.now() - startedAt;',
      '    const errorMessage = err instanceof Error ? err.message : String(err);',
      '    await persistInvocationLog({',
      '      level: "error",',
      '      source: "runtime",',
    '      message: "-> " + innerReq.method + " " + requestPath + " | <- ERR (" + duration + "ms)",',
      '      meta: {',
      '        runtime: "deno",',
      '        function: slug,',
      '        functionId: fn.id,',
      '        request: {',
      '          method: innerReq.method,',
      '          path: requestPath,',
      '          headers: requestHeaders,',
      '          body: requestBody ? trimLogText(requestBody) : null,',
      '          query: Object.fromEntries(innerUrl.searchParams.entries()),',
      '        },',
      '        response: {',
      '          status: 500,',
      '          headers: { "content-type": "application/json" },',
      '          body: JSON.stringify({ error: errorMessage }),',
      '        },',
      '        error: errorMessage,',
      '        durationMs: duration,',
      '      },',
      '    });',
      '    console.error(`[runner] ${slug} threw:`, err);',
      '    return withCors(new Response(',
      '      JSON.stringify({ error: errorMessage }),',
      '      { status: 500, headers: { "content-type": "application/json" } },',
      '    ), origin);',
      '  }',
    ].join("\n"),
  );

  return source;
}

function getRunnerScript(runtime: RuntimeId): string {
  switch (runtime) {
    case "deno":
      if (RUNNER_SOURCE && RUNNER_SOURCE.length > 100) return buildLoggedDenoRunnerSource(RUNNER_SOURCE);
      return "console.error('runner/main.ts missing'); Deno.exit(1);";
    case "node":
      return NODE_RUNNER_SOURCE;
    case "python":
      return PYTHON_RUNNER_SOURCE;
    case "java":
    case "dotnet":
      // Compiled runtimes don't use a JS/TS runner — the user's source IS the app.
      // Return a non-empty placeholder so aca.server.ts doesn't reject it.
      return "# build-at-boot runtime — no runner script needed".padEnd(120, " ");
  }
}

export interface DeployProjectResult {
  ok: true;
  deploymentId: string;
  fqdn: string | null;
  defaultFqdn: string | null;
  customDomains: string[];
  version: number;
  runtime: string;
}

/**
 * Deploy a project by ID using the same logic as the UI.
 * The caller must already have access to the project ownerId.
 */
export async function deployProjectById({
  projectId,
  ownerId,
  platformBaseUrl,
  progress,
}: {
  projectId: string;
  ownerId: string;
  platformBaseUrl?: string | null;
  progress?: DeployProgressLogger;
}): Promise<DeployProjectResult> {
  await ensureSchema();
  const s = sql();
  const projs =
    (await s`SELECT id, slug, admin_token, log_token, runtime FROM projects WHERE id = ${projectId} AND owner_id = ${ownerId}`) as Array<{
      id: string;
      slug: string;
      admin_token: string | null;
      log_token: string | null;
      runtime: string | null;
    }>;
  if (!projs[0]) throw new Error("Project not found");
  const proj = projs[0];
  const runtimeId = (proj.runtime ?? "deno") as RuntimeId;
  const runtime = getRuntimeConfig(runtimeId);
  progress?.("info", "Preparando deploy del proyecto", {
    projectId: proj.id,
    runtime: runtimeId,
    projectSlug: proj.slug,
  });

  // Generate / reuse a per-project admin token (used for /__validate)
  let adminToken = proj.admin_token;
  if (!adminToken) {
    adminToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    await s`UPDATE projects SET admin_token = ${adminToken} WHERE id = ${proj.id}`;
  }

  let logToken = proj.log_token ?? "";
  if (!logToken) {
    logToken = createRuntimeLogToken();
    await s`UPDATE projects SET log_token = ${logToken} WHERE id = ${proj.id}`;
  }

  const platformOrigin = resolvePlatformBaseUrl(platformBaseUrl);
  const runtimeLogIngestUrl = platformOrigin ? new URL("/api/runtime-logs", platformOrigin).toString() : "";
  if (!runtimeLogIngestUrl) {
    progress?.("warn", "Runtime logs disabled: missing platform base URL", {
      projectId: proj.id,
      runtime: runtimeId,
    });
  }

  const secretRows =
    (await s`SELECT name, value FROM secrets WHERE project_id = ${proj.id} AND owner_id = ${ownerId}`) as Array<{
      name: string;
      value: string;
    }>;
  const secrets: Record<string, string> = {};
  for (const r of secretRows) secrets[r.name] = r.value;
  const apiKeyValues: string[] = [];
  if (runtimeId !== "deno") {
    const tokenRows = (await s`
      SELECT ft.name, ft.value
      FROM function_tokens ft
      JOIN functions f ON f.id = ft.function_id
      WHERE f.project_id = ${proj.id} AND ft.owner_id = ${ownerId}
      ORDER BY f.slug ASC, ft.name ASC
    `) as Array<{
      name: string;
      value: string;
    }>;
    apiKeyValues.push(...tokenRows.map((r) => r.value).filter(Boolean));
  }

  const verRows =
    (await s`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM deployments WHERE project_id = ${proj.id}`) as Array<{
      v: number;
    }>;
  const version = verRows[0].v;
  const containerAppName = sanitizeAcaName(`proj-${proj.slug}-${proj.id.slice(0, 6)}`, "proj");

  const depRows =
    (await s`INSERT INTO deployments (project_id, owner_id, version, container_app_name, status, runtime) VALUES (${proj.id}, ${ownerId}, ${version}, ${containerAppName}, 'provisioning', ${runtimeId}) RETURNING id`) as Array<{
      id: string;
    }>;
  const deploymentId = depRows[0].id;
  const runnerScript = getRunnerScript(runtimeId);

  // For non-Deno runtimes, bundle ALL function files for this project into FILES_JSON.
  // Format: [{ slug, entrypoint, path, content, kind }, ...]
  let filesJson = "";
  if (runtimeId !== "deno") {
    const fnRows = (await s`
      SELECT f.slug, f.entrypoint, ff.path, ff.content, ff.kind
      FROM function_files ff
      JOIN functions f ON f.id = ff.function_id
      WHERE f.project_id = ${proj.id} AND ff.owner_id = ${ownerId}
      ORDER BY f.slug ASC, ff.path ASC
    `) as Array<{
      slug: string;
      entrypoint: string;
      path: string;
      content: string;
      kind: string;
    }>;
    filesJson = JSON.stringify(fnRows);
  }

  await logEvent(
    proj.id,
    ownerId,
    "info",
    "deploy",
    `Iniciando deploy v${version} (runtime: ${runtimeId})`,
    {
      containerAppName,
      runtime: runtimeId,
      runnerBytes: runnerScript.length,
      fileBytes: filesJson.length,
    },
  );
  progress?.("info", `Iniciando deploy v${version}`, {
    containerAppName,
    runtime: runtimeId,
    version,
  });

  try {
    const neonUrl = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
    if (!neonUrl) {
      throw new Error("Missing NEON_DATABASE_URL / DATABASE_URL");
    }
    const baseEnv: Record<string, string> = {
      NEON_URL: neonUrl,
      PROJECT_ID: proj.id,
      VORTEX_OWNER_ID: ownerId,
      ADMIN_TOKEN: adminToken,
      DEPLOYMENT_VERSION: String(version),
      RUNTIME: runtimeId,
      PORT: String(runtime.port),
    };
    if (runtimeLogIngestUrl) {
      baseEnv.VORTEX_LOG_INGEST_URL = runtimeLogIngestUrl;
    }
    baseEnv.VORTEX_LOG_TOKEN = logToken;
    if (apiKeyValues.length) {
      baseEnv.API_KEY = apiKeyValues.join(",");
    }
    if (runtimeId === "deno" || runtimeId === "node" || runtimeId === "python") {
      baseEnv.RUNNER_SCRIPT = runnerScript;
    }
    if (filesJson) {
      baseEnv.FILES_JSON = filesJson;
    }

    const result = await upsertContainerApp({
      containerAppName,
      external: true,
      targetPort: runtime.port,
      image: runtime.image,
      startupScript: runtime.startupScript,
      cpu: runtime.cpu,
      memory: runtime.memory,
      healthPath: runtime.healthPath,
      startupInitialDelaySeconds: runtime.startupInitialDelaySeconds,
      startupFailureThreshold: runtime.startupFailureThreshold,
      startupPeriodSeconds: runtime.startupPeriodSeconds,
      env: baseEnv,
      secrets,
      log: (level, message, meta) => {
        progress?.(level, message, meta);
        // Fire-and-forget: don't block the deploy on a log write failure.
        void logEvent(proj.id, ownerId, level, "azure", message, meta);
      },
    });

    await s`UPDATE deployments SET status = 'live', fqdn = ${result.fqdn} WHERE id = ${deploymentId}`;
    await s`UPDATE projects SET container_app_name = ${containerAppName}, fqdn = ${result.fqdn}, last_deployed_at = now() WHERE id = ${proj.id}`;
    await s`UPDATE functions SET status = 'live', container_app_name = ${containerAppName}, fqdn = ${result.fqdn}, updated_at = now() WHERE project_id = ${proj.id}`;

    const usingCustom = result.customDomains.length > 0;
    await logEvent(
      proj.id,
      ownerId,
      "info",
      "deploy",
      `Deploy v${version} OK (${runtimeId})`,
      {
        fqdn: result.fqdn,
        defaultFqdn: result.defaultFqdn,
        customDomains: result.customDomains,
        usingCustomDomain: usingCustom,
        runtime: runtimeId,
      },
    );
    progress?.("info", `Deploy v${version} OK`, {
      fqdn: result.fqdn,
      defaultFqdn: result.defaultFqdn,
      customDomains: result.customDomains,
      runtime: runtimeId,
      version,
    });
    return {
      ok: true,
      deploymentId,
      fqdn: result.fqdn,
      defaultFqdn: result.defaultFqdn,
      customDomains: result.customDomains,
      version,
      runtime: runtimeId,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await s`UPDATE deployments SET status = 'failed', error = ${msg} WHERE id = ${deploymentId}`;
    await logEvent(proj.id, ownerId, "error", "deploy", `Deploy v${version} FAILED`, {
      error: msg,
      runtime: runtimeId,
    });
    progress?.("error", `Deploy v${version} FAILED`, {
      error: msg,
      runtime: runtimeId,
      version,
    });
    throw new Error(`Deploy failed: ${msg}`);
  }
}
