import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuthSystemAuth } from "@/lib/auth/server-middleware";
import { sql, ensureSchema } from "@/lib/neon/db.server";
import { getContainerApp } from "@/lib/azure/aca.server";
import { deployProjectById } from "./deployments.shared";
import { getRuntimeConfig } from "@/lib/runtimes";

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

export const deployProject = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ projectId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => deployProjectById({ projectId: data.projectId, ownerId: context.userId }));

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
