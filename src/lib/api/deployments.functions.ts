import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuthSystemAuth } from "@/lib/auth/server-middleware";
import { sql, ensureSchema, logEvent } from "@/lib/neon/db.server";
import { upsertContainerApp, getContainerApp, sanitizeAcaName } from "@/lib/azure/aca.server";
import { RUNNER_SOURCE } from "@/lib/runner-source.generated";
import { getRuntimeConfig, type RuntimeId } from "@/lib/runtimes";
import { NODE_RUNNER_SOURCE } from "@/lib/runtimes/runner-node";
import { PYTHON_RUNNER_SOURCE } from "@/lib/runtimes/runner-python";

function getRunnerScript(runtime: RuntimeId): string {
  switch (runtime) {
    case "deno":
      if (RUNNER_SOURCE && RUNNER_SOURCE.length > 100) return RUNNER_SOURCE;
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

export const listDeployments = createServerFn({ method: "GET" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ projectId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureSchema();
    const s = sql();
    const rows =
      await s`SELECT id, version, container_app_name, fqdn, status, error, runtime, created_at FROM deployments WHERE project_id = ${data.projectId} AND owner_id = ${context.userId} ORDER BY version DESC LIMIT 20`;
    return rows as Array<{
      id: string;
      version: number;
      container_app_name: string;
      fqdn: string | null;
      status: string;
      error: string | null;
      runtime: string | null;
      created_at: string;
    }>;
  });

/**
 * Deploy (or update) ONE Container App per project.
 * For Deno: all functions of the project share one container; the runner routes
 * by /{functionSlug}/... and hot-reloads code + tokens from Neon.
 * For Node/Python/Java/.NET: the function files are bundled at deploy time via
 * the FILES_B64 env var. Code changes require redeploy.
 */
export const deployProject = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ projectId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureSchema();
    const s = sql();
    const projs =
      (await s`SELECT id, slug, admin_token, runtime FROM projects WHERE id = ${data.projectId} AND owner_id = ${context.userId}`) as Array<{
        id: string;
        slug: string;
        admin_token: string | null;
        runtime: string | null;
      }>;
    if (!projs[0]) throw new Error("Project not found");
    const proj = projs[0];
    const runtimeId = (proj.runtime ?? "deno") as RuntimeId;
    const runtime = getRuntimeConfig(runtimeId);

    // Generate / reuse a per-project admin token (used for /__validate)
    let adminToken = proj.admin_token;
    if (!adminToken) {
      adminToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      await s`UPDATE projects SET admin_token = ${adminToken} WHERE id = ${proj.id}`;
    }

    const secretRows =
      (await s`SELECT name, value FROM secrets WHERE project_id = ${proj.id} AND owner_id = ${context.userId}`) as Array<{
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
        WHERE f.project_id = ${proj.id} AND ft.owner_id = ${context.userId}
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
      (await s`INSERT INTO deployments (project_id, owner_id, version, container_app_name, status, runtime) VALUES (${proj.id}, ${context.userId}, ${version}, ${containerAppName}, 'provisioning', ${runtimeId}) RETURNING id`) as Array<{
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
        WHERE f.project_id = ${proj.id} AND ff.owner_id = ${context.userId}
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
      context.userId,
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

    try {
      const baseEnv: Record<string, string> = {
        NEON_URL: process.env.NEON_DATABASE_URL!,
        PROJECT_ID: proj.id,
        ADMIN_TOKEN: adminToken,
        DEPLOYMENT_VERSION: String(version),
        RUNTIME: runtimeId,
        PORT: String(runtime.port),
      };
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
          // Fire-and-forget: don't block the deploy on a log write failure.
          void logEvent(proj.id, context.userId, level, "azure", message, meta);
        },
      });

      await s`UPDATE deployments SET status = 'live', fqdn = ${result.fqdn} WHERE id = ${deploymentId}`;
      await s`UPDATE projects SET container_app_name = ${containerAppName}, fqdn = ${result.fqdn}, last_deployed_at = now() WHERE id = ${proj.id}`;
      await s`UPDATE functions SET status = 'live', container_app_name = ${containerAppName}, fqdn = ${result.fqdn}, updated_at = now() WHERE project_id = ${proj.id}`;

      const usingCustom = result.customDomains.length > 0;
      await logEvent(
        proj.id,
        context.userId,
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
      await logEvent(proj.id, context.userId, "error", "deploy", `Deploy v${version} FAILED`, {
        error: msg,
        runtime: runtimeId,
      });
      throw new Error(`Deploy failed: ${msg}`);
    }
  });

export const refreshDeploymentStatus = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ deploymentId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const s = sql();
    const rows =
      (await s`SELECT container_app_name FROM deployments WHERE id = ${data.deploymentId} AND owner_id = ${context.userId}`) as Array<{
        container_app_name: string;
      }>;
    if (!rows[0]) throw new Error("Deployment not found");
    const info = await getContainerApp(rows[0].container_app_name);
    return info;
  });

/**
 * Health-check the project's deployed container using the runtime-specific health path.
 * Read-only: returns status for the UI without writing back to the database.
 */
export const checkProjectHealth = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ projectId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const s = sql();
    const projs =
      (await s`SELECT id, fqdn, runtime FROM projects WHERE id = ${data.projectId} AND owner_id = ${context.userId}`) as Array<{
        id: string;
        fqdn: string | null;
        runtime: string | null;
      }>;
    if (!projs[0]) throw new Error("Project not found");
    const fqdn = projs[0].fqdn;
    const runtime = getRuntimeConfig(projs[0].runtime);
    if (!fqdn) {
      return {
        status: "not-deployed" as const,
        httpStatus: 0,
        responseTime: 0,
        body: null,
        fqdn: null,
        checkedAt: new Date().toISOString(),
      };
    }

    const url = `https://${fqdn}${runtime.healthPath}`;
    const started = Date.now();
    let httpStatus = 0;
    let body: string | null = null;
    let status: "operational" | "degraded" | "down" = "down";
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { accept: "application/json" },
      });
      clearTimeout(t);
      httpStatus = res.status;
      const text = await res.text().catch(() => "");
      body = text || null;
      let parsed: { status?: string } | null = null;
      try {
        parsed = text ? (JSON.parse(text) as { status?: string }) : null;
      } catch {
        parsed = null;
      }
      if (res.ok) {
        status = parsed?.status === "degraded" ? "degraded" : "operational";
      } else if (res.status >= 500) {
        status = "degraded";
      } else {
        status = "down";
      }
    } catch {
      status = "down";
    }
    const responseTime = Date.now() - started;

    return { status, httpStatus, responseTime, body, fqdn, checkedAt: new Date().toISOString() };
  });
