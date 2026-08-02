import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuthSystemAuth } from "@/lib/auth/server-middleware";
import { sql, ensureSchema, slugify, logEvent } from "@/lib/neon/db.server";
import { RUNTIMES, type RuntimeId } from "@/lib/runtimes";
import { cloneProjectAndDeploy } from "@/lib/api/project-clone.shared";
import {
  applyDefaultStorageMountPath,
  normalizeProjectDeploymentProfile,
  reconcilePublicDomainBinding,
} from "@/lib/api/deployments.shared";
import {
  deleteContainerApp,
  getContainerApp,
  restartContainerApp,
  startContainerApp,
  stopContainerApp,
} from "@/lib/azure/aca.server";
import { getRequest } from "@tanstack/react-start/server";

const runtimeSchema = z.enum(RUNTIMES as [RuntimeId, ...RuntimeId[]]);

async function getProjectContainerApp(projectId: string, ownerId: string) {
  await ensureSchema();
  const s = sql();
  const rows = (await s`
    SELECT id, name, slug, container_app_name, fqdn, runtime, deployment_profile
    FROM projects
    WHERE id = ${projectId} AND owner_id = ${ownerId}
    LIMIT 1
  `) as Array<{
    id: string;
    name: string;
    slug: string;
    container_app_name: string | null;
    fqdn: string | null;
    runtime: string | null;
    deployment_profile: unknown;
  }>;
  return rows[0] ?? null;
}

export const listProjects = createServerFn({ method: "GET" })
  .middleware([requireAuthSystemAuth])
  .handler(async ({ context }) => {
    const startedAt = Date.now();
    try {
      await ensureSchema();
      const s = sql();
      const rows =
        await s`SELECT id, name, slug, runtime, created_at FROM projects WHERE owner_id = ${context.userId} ORDER BY created_at DESC`;

      await logEvent(
        null,
        context.userId,
        "info",
        "projects.list",
        "Loaded projects",
        { count: rows.length, durationMs: Date.now() - startedAt },
      );

      return rows as {
        id: string;
        name: string;
        slug: string;
        runtime: string;
        created_at: string;
      }[];
    } catch (error) {
      await logEvent(
        null,
        context.userId,
        "error",
        "projects.list",
        error instanceof Error ? error.message : "Unknown error",
        {
          durationMs: Date.now() - startedAt,
          stack: error instanceof Error ? error.stack : String(error),
        },
      );
      throw error;
    }
  });

export const createProject = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) =>
    z.object({ name: z.string().min(1).max(60), runtime: runtimeSchema.optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureSchema();
    const s = sql();
    const slug = slugify(data.name) + "-" + Math.random().toString(36).slice(2, 6);
    const runtime = data.runtime ?? "deno";
    const deploymentProfileJson = JSON.stringify(
      applyDefaultStorageMountPath({}),
    );
    const rows =
      await s`
        INSERT INTO projects (owner_id, name, slug, runtime, deployment_profile)
        VALUES (${context.userId}, ${data.name}, ${slug}, ${runtime}, ${deploymentProfileJson}::jsonb)
        RETURNING id, name, slug, runtime, created_at
      `;
    return (
      rows as Array<{ id: string; name: string; slug: string; runtime: string; created_at: string }>
    )[0];
  });

const cloneProjectSchema = z
  .object({
    sourceProjectId: z.string().uuid(),
    name: z.string().min(1).max(60),
    cpu: z.number().positive().max(8).optional(),
    memory: z.string().regex(/^\d+(\.\d+)?Gi$/i, "Use a value like 1Gi or 2Gi").optional(),
    minReplicas: z.number().int().min(1).max(20).optional(),
    maxReplicas: z.number().int().min(1).max(20).optional(),
    storageMountPath: z.string().regex(/^\/[^\0]*$/, "Use an absolute mount path").optional(),
    domain: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i, "Use a valid domain")
      .nullable()
      .optional(),
    subdomain: z
      .string()
      .trim()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i, "Use a valid subdomain")
      .nullable()
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (
      typeof value.minReplicas === "number" &&
      typeof value.maxReplicas === "number" &&
      value.minReplicas > value.maxReplicas
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["minReplicas"],
        message: "minReplicas cannot be greater than maxReplicas",
      });
    }

    if (value.subdomain && !value.domain) {
      ctx.addIssue({
        code: "custom",
        path: ["domain"],
        message: "domain is required when subdomain is provided",
      });
    }
  });

export const cloneProject = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => cloneProjectSchema.parse(d))
  .handler(async ({ data, context }) => {
    let platformBaseUrl: string | undefined;
    try {
      const request = getRequest();
      platformBaseUrl = request ? new URL(request.url).origin : undefined;
    } catch {
      platformBaseUrl = undefined;
    }

    const tenantLabel =
      context.claims?.tenant?.name?.trim() ||
      (context.claims?.tenant?.id ? `tenant-${context.claims.tenant.id.slice(0, 8)}` : null);

    return cloneProjectAndDeploy({
      sourceProjectId: data.sourceProjectId,
      ownerId: context.userId,
      requestedName: data.name,
      tenantLabel,
      platformBaseUrl,
      domain: data.domain?.trim() || null,
      subdomain: data.subdomain?.trim() || null,
      deploymentOverrides: {
        cpu: data.cpu,
        memory: data.memory,
        minReplicas: data.minReplicas,
        maxReplicas: data.maxReplicas,
        storageMountPath: data.storageMountPath,
      },
    });
  });

export const updateProjectRuntime = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid(), runtime: runtimeSchema }).parse(d))
  .handler(async ({ data, context }) => {
    const s = sql();
    await s`UPDATE projects SET runtime = ${data.runtime} WHERE id = ${data.id} AND owner_id = ${context.userId}`;
    return { ok: true };
  });

const publicDomainSchema = z
  .object({
    projectId: z.string().uuid(),
    domain: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i, "Usa un dominio válido, ej: midominio.com")
      .nullable(),
    subdomain: z
      .string()
      .trim()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i, "Usa un subdominio válido, ej: api")
      .nullable()
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.subdomain && !value.domain) {
      ctx.addIssue({
        code: "custom",
        path: ["domain"],
        message: "El dominio es requerido si defines un subdominio",
      });
    }
  });

export const updateProjectPublicDomain = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => publicDomainSchema.parse(d))
  .handler(async ({ data, context }) => {
    await ensureSchema();
    const s = sql();
    const rows = (await s`
      SELECT deployment_profile FROM projects WHERE id = ${data.projectId} AND owner_id = ${context.userId}
    `) as Array<{ deployment_profile: unknown }>;
    if (!rows[0]) throw new Error("Project not found");

    const profile = normalizeProjectDeploymentProfile(rows[0].deployment_profile);
    profile.publicDomain = data.domain
      ? {
          domain: data.domain.toLowerCase(),
          subdomain: data.subdomain ? data.subdomain.toLowerCase() : null,
          ttl: 600,
        }
      : null;

    await s`
      UPDATE projects SET deployment_profile = ${JSON.stringify(profile)}::jsonb
      WHERE id = ${data.projectId} AND owner_id = ${context.userId}
    `;

    await logEvent(data.projectId, context.userId, "info", "domain", "Public domain configuration updated", {
      publicDomain: profile.publicDomain,
    });

    return { ok: true, publicDomain: profile.publicDomain ?? null };
  });

export const deleteProject = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureSchema();
    const s = sql();
    const rows = (await s`
      SELECT DISTINCT container_app_name
      FROM (
        SELECT container_app_name
        FROM projects
        WHERE id = ${data.id} AND owner_id = ${context.userId}
        UNION ALL
        SELECT container_app_name
        FROM deployments
        WHERE project_id = ${data.id} AND owner_id = ${context.userId}
        UNION ALL
        SELECT container_app_name
        FROM functions
        WHERE project_id = ${data.id} AND owner_id = ${context.userId}
      ) AS names
      WHERE container_app_name IS NOT NULL AND container_app_name <> ''
    `) as Array<{ container_app_name: string }>;

    for (const { container_app_name: containerAppName } of rows) {
      await deleteContainerApp(containerAppName);
    }

    await s`DELETE FROM projects WHERE id = ${data.id} AND owner_id = ${context.userId}`;
    return { ok: true };
  });

export const getProjectContainerAppStatus = createServerFn({ method: "GET" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ projectId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const project = await getProjectContainerApp(data.projectId, context.userId);
    if (!project) throw new Error("Project not found");
    const publicDomainConfig = normalizeProjectDeploymentProfile(project.deployment_profile).publicDomain ?? null;
    if (!project.container_app_name) {
      return {
        projectId: project.id,
        projectName: project.name,
        projectSlug: project.slug,
        containerAppName: null,
        fqdn: project.fqdn,
        defaultFqdn: null,
        runningStatus: "Not deployed",
        provisioningState: "Not deployed",
        publicHostnameStatus: "none",
        certificateState: null,
        publicHostname: null,
        publicDomainConfig,
      };
    }

    const publicDomain = await reconcilePublicDomainBinding({
      projectId: project.id,
      ownerId: context.userId,
    });
    const app = await getContainerApp(project.container_app_name);
    if (!app) {
      return {
        projectId: project.id,
        projectName: project.name,
        projectSlug: project.slug,
        containerAppName: project.container_app_name,
        fqdn: project.fqdn,
        defaultFqdn: null,
        runningStatus: "Missing",
        provisioningState: "Missing",
        publicHostnameStatus: publicDomain?.status ?? "none",
        certificateState: publicDomain?.certificateState ?? null,
        publicHostname: publicDomain?.publicHostname ?? null,
        publicDomainConfig,
      };
    }

    return {
      projectId: project.id,
      projectName: project.name,
      projectSlug: project.slug,
      containerAppName: project.container_app_name,
      fqdn: app.fqdn ?? project.fqdn,
      defaultFqdn: app.defaultFqdn,
      runningStatus: app.runningStatus,
      provisioningState: app.provisioningState,
      publicHostnameStatus: publicDomain?.status ?? "none",
      certificateState: publicDomain?.certificateState ?? null,
      publicHostname: publicDomain?.publicHostname ?? null,
      publicDomainConfig,
    };
  });

export const startProjectContainerApp = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ projectId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const project = await getProjectContainerApp(data.projectId, context.userId);
    if (!project) throw new Error("Project not found");
    if (!project.container_app_name) throw new Error("This project has not been deployed yet");

    const result = await startContainerApp(project.container_app_name);
    await logEvent(project.id, context.userId, "info", "container-app", "Container app started", {
      containerAppName: project.container_app_name,
      runningStatus: result.runningStatus,
    });
    return result;
  });

export const stopProjectContainerApp = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ projectId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const project = await getProjectContainerApp(data.projectId, context.userId);
    if (!project) throw new Error("Project not found");
    if (!project.container_app_name) throw new Error("This project has not been deployed yet");

    const result = await stopContainerApp(project.container_app_name);
    await logEvent(project.id, context.userId, "info", "container-app", "Container app stopped", {
      containerAppName: project.container_app_name,
      runningStatus: result.runningStatus,
    });
    return result;
  });

export const restartProjectContainerApp = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ projectId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const project = await getProjectContainerApp(data.projectId, context.userId);
    if (!project) throw new Error("Project not found");
    if (!project.container_app_name) throw new Error("This project has not been deployed yet");

    const result = await restartContainerApp(project.container_app_name);
    await logEvent(project.id, context.userId, "info", "container-app", "Container app restarted", {
      containerAppName: project.container_app_name,
      runningStatus: result.runningStatus,
    });
    return result;
  });
