import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuthSystemAuth } from "@/lib/auth/server-middleware";
import { sql, ensureSchema, logEvent } from "@/lib/neon/db.server";
import { getRuntimeConfig } from "@/lib/runtimes";

export const invokeFunction = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) =>
    z
      .object({
        functionId: z.string().uuid(),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        path: z.string().default("/"),
        headers: z.record(z.string(), z.string()).default({}),
        body: z.string().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureSchema();
    const s = sql();
    const rows = (await s`
      SELECT f.slug AS fn_slug, f.name AS fn_name, f.project_id, p.fqdn AS proj_fqdn, p.runtime AS proj_runtime
      FROM functions f
      JOIN projects p ON p.id = f.project_id
      WHERE f.id = ${data.functionId} AND f.owner_id = ${context.userId}
    `) as Array<{
      fn_slug: string;
      fn_name: string;
      project_id: string;
      proj_fqdn: string | null;
      proj_runtime: string | null;
    }>;
    if (!rows[0]) throw new Error("Function not found");
    const { fn_slug, fn_name, project_id, proj_fqdn, proj_runtime } = rows[0];
    if (!proj_fqdn) throw new Error("Project not deployed yet. Hit Deploy first.");

    const subPath = data.path.startsWith("/") ? data.path : "/" + data.path;
    const runtime = getRuntimeConfig(proj_runtime);
    const baseUrl = runtime.multiFunction
      ? `https://${proj_fqdn}/${fn_slug}`
      : `https://${proj_fqdn}`;
    const url = `${baseUrl}${subPath === "/" ? "" : subPath}`;

    await logEvent(project_id, context.userId, "info", "invoke", `→ ${data.method} ${url}`, {
      function: fn_name,
      headers: data.headers,
      body: data.body ? data.body.slice(0, 2000) : null,
    });

    const startedAt = Date.now();
    let status = 0;
    let respText = "";
    const respHeaders: Record<string, string> = {};
    let error: string | null = null;
    try {
      const res = await fetch(url, {
        method: data.method,
        headers: data.headers,
        body: ["GET", "HEAD"].includes(data.method) ? undefined : data.body,
      });
      status = res.status;
      respText = await res.text();
      res.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const duration = Date.now() - startedAt;

    await s`INSERT INTO invocation_logs (function_id, owner_id, method, path, status, duration_ms, error) VALUES (${data.functionId}, ${context.userId}, ${data.method}, ${data.path}, ${status || null}, ${duration}, ${error})`;

    await logEvent(
      project_id,
      context.userId,
      error ? "error" : status >= 400 ? "warn" : "info",
      "invoke",
      `← ${status || "ERR"} (${duration}ms)`,
      { function: fn_name, response: respText.slice(0, 2000), error },
    );

    return { status, headers: respHeaders, body: respText, error, durationMs: duration, url };
  });

export const listLogs = createServerFn({ method: "GET" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ functionId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureSchema();
    const s = sql();
    const rows =
      await s`SELECT id, method, path, status, duration_ms, error, created_at FROM invocation_logs WHERE function_id = ${data.functionId} AND owner_id = ${context.userId} ORDER BY created_at DESC LIMIT 50`;
    return rows as Array<{
      id: string;
      method: string;
      path: string;
      status: number | null;
      duration_ms: number | null;
      error: string | null;
      created_at: string;
    }>;
  });
