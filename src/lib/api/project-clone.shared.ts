import { Client, neonConfig } from "@neondatabase/serverless";

import { sql, ensureSchema, logEvent, slugify } from "@/lib/neon/db.server";
import {
  applyDefaultStorageMountPath,
  deployProjectById,
  normalizeProjectDeploymentProfile,
  type ProjectPublicDomainConfig,
  type DeployProgressLogger,
  type ProjectDeploymentProfile,
} from "./deployments.shared";

if (typeof WebSocket !== "undefined" && neonConfig.webSocketConstructor !== WebSocket) {
  neonConfig.webSocketConstructor = WebSocket;
}

export type CloneProjectOverrides = Pick<
  ProjectDeploymentProfile,
  "cpu" | "memory" | "minReplicas" | "maxReplicas" | "storageMountPath"
>;

export type CloneProjectInput = {
  sourceProjectId: string;
  ownerId: string;
  requestedName: string;
  tenantLabel?: string | null;
  platformBaseUrl?: string | null;
  domain?: string | null;
  subdomain?: string | null;
  deploymentOverrides?: CloneProjectOverrides;
  progress?: DeployProgressLogger;
};

export type CloneProjectResult = {
  project: {
    id: string;
    name: string;
    slug: string;
    runtime: string;
    created_at: string;
  };
  deployment: Awaited<ReturnType<typeof deployProjectById>>;
};

type SourceProjectRow = {
  id: string;
  name: string;
  slug: string;
  runtime: string | null;
  deployment_profile: unknown;
};

function composeCloneName(tenantLabel: string | null | undefined, requestedName: string): string {
  const baseName = requestedName.trim();
  const prefix = tenantLabel?.trim();
  if (!prefix) return baseName;

  const fullPrefix = `${prefix} - `;
  if (baseName.toLowerCase().startsWith(fullPrefix.toLowerCase())) return baseName;
  return `${prefix} - ${baseName}`;
}

function composeCloneSlug(name: string): string {
  return `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeComparableHostname(input: string | null | undefined): string | null {
  const raw = input?.trim().toLowerCase().replace(/\.+$/g, "");
  return raw || null;
}

function normalizeComparableName(input: string | null | undefined): string | null {
  const raw = input?.trim().toLowerCase();
  return raw || null;
}

function readStoredPublicHostname(profile: unknown): string | null {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
  const candidate = (profile as Record<string, unknown>).publicDomain;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const domainRecord = candidate as Record<string, unknown>;
  const domain = typeof domainRecord.domain === "string"
    ? normalizeComparableHostname(domainRecord.domain)
    : null;
  if (!domain) return null;
  const subdomain = typeof domainRecord.subdomain === "string"
    ? normalizeComparableHostname(domainRecord.subdomain)
    : null;
  return subdomain ? `${subdomain}.${domain}` : domain;
}

function mergeDeploymentProfile(base: unknown, overrides?: CloneProjectOverrides): ProjectDeploymentProfile {
  const profile = normalizeProjectDeploymentProfile(base);
  if (!overrides) return profile;

  if (overrides.cpu !== undefined) profile.cpu = overrides.cpu;
  if (overrides.memory !== undefined) profile.memory = overrides.memory;
  if (overrides.minReplicas !== undefined) profile.minReplicas = overrides.minReplicas;
  if (overrides.maxReplicas !== undefined) profile.maxReplicas = overrides.maxReplicas;
  if (overrides.storageMountPath !== undefined) profile.storageMountPath = overrides.storageMountPath;
  return profile;
}

/**
 * Clone a project into a brand-new project, copy its code/secret data,
 * and deploy the clone immediately using the requested resource profile.
 */
export async function cloneProjectAndDeploy({
  sourceProjectId,
  ownerId,
  requestedName,
  tenantLabel,
  platformBaseUrl,
  domain,
  subdomain,
  deploymentOverrides,
  progress,
}: CloneProjectInput): Promise<CloneProjectResult> {
  await ensureSchema();
  const s = sql();

  const sourceRows = (await s`
    SELECT id, name, slug, runtime, deployment_profile
    FROM projects
    WHERE id = ${sourceProjectId} AND owner_id = ${ownerId}
    LIMIT 1
  `) as SourceProjectRow[];
  const source = sourceRows[0];
  if (!source) throw new Error("Project not found");

  const cloneName = composeCloneName(tenantLabel, requestedName);
  const cloneSlug = composeCloneSlug(cloneName);
  const normalizedDomain = normalizeComparableHostname(domain);
  const normalizedSubdomain = normalizeComparableHostname(subdomain);
  const publicDomain: ProjectPublicDomainConfig | undefined = normalizedDomain
    ? {
        domain: normalizedDomain,
        subdomain: normalizedSubdomain,
        ttl: 600,
      }
    : undefined;
  const publicHostname = publicDomain
    ? publicDomain.subdomain
      ? `${publicDomain.subdomain}.${publicDomain.domain}`
      : publicDomain.domain
    : null;
  const runtime = source.runtime ?? "deno";
  const deploymentProfile = applyDefaultStorageMountPath(
    mergeDeploymentProfile(source.deployment_profile, deploymentOverrides),
  );
  if (publicDomain) {
    deploymentProfile.publicDomain = publicDomain;
  }
  const deploymentProfileJson = JSON.stringify(deploymentProfile);
  const dbUrl =
    process.env.NEON_DATABASE_URL_POOLER ||
    process.env.NEON_DATABASE_URL ||
    process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("NEON_DATABASE_URL is not set");
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  let project: {
    id: string;
    name: string;
    slug: string;
    runtime: string;
    created_at: string;
  };

  try {
    await client.query("BEGIN");

    const existingCloneRows = (
      await client.query<{
        fqdn: string | null;
        name: string;
        deployment_profile: unknown;
      }>(
        `
          SELECT name, fqdn, deployment_profile
          FROM projects
          WHERE owner_id = $1
        `,
        [ownerId],
      )
    ).rows;
    const requestedHostname = normalizeComparableHostname(publicHostname);
    const requestedName = normalizeComparableName(cloneName);
    const duplicateByName = existingCloneRows.some((row) => normalizeComparableName(row.name) === requestedName);
    const duplicateByHostname = requestedHostname
      ? existingCloneRows.some((row) => {
          const storedHostname = normalizeComparableHostname(row.fqdn) ?? readStoredPublicHostname(row.deployment_profile);
          return storedHostname === requestedHostname;
        })
      : false;
    if (duplicateByName || duplicateByHostname) {
      throw new Error(
        duplicateByName && duplicateByHostname
          ? `Ya existe un clon con el nombre "${cloneName}" y el hostname "${requestedHostname}"`
          : duplicateByName
            ? `Ya existe un clon con el nombre "${cloneName}"`
            : `Ya existe un clon con el hostname "${requestedHostname}"`,
      );
    }

    const insertedProjectResult = await client.query<{
      id: string;
      name: string;
      slug: string;
      runtime: string;
      created_at: string;
    }>(
      `
        INSERT INTO projects (owner_id, name, slug, runtime, deployment_profile)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        RETURNING id, name, slug, runtime, created_at
      `,
      [ownerId, cloneName, cloneSlug, runtime, deploymentProfileJson],
    );
    project = insertedProjectResult.rows[0];
    if (!project) throw new Error("Failed to create cloned project");

    const sourceFunctions =
      (await client.query<{
        id: string;
        name: string;
        slug: string;
        entrypoint: string;
      }>(
        `
          SELECT id, name, slug, entrypoint
          FROM functions
          WHERE project_id = $1 AND owner_id = $2
          ORDER BY created_at ASC
        `,
        [source.id, ownerId],
      )).rows;

    const functionIdMap = new Map<string, string>();
    for (const fn of sourceFunctions) {
      const insertedFunctionResult = await client.query<{ id: string }>(
        `
          INSERT INTO functions (project_id, owner_id, name, slug, entrypoint, status)
          VALUES ($1, $2, $3, $4, $5, 'draft')
          RETURNING id
        `,
        [project.id, ownerId, fn.name, fn.slug, fn.entrypoint],
      );
      const newFunctionId = insertedFunctionResult.rows[0]?.id;
      if (!newFunctionId) throw new Error(`Failed to clone function ${fn.slug}`);
      functionIdMap.set(fn.id, newFunctionId);
    }

    for (const fn of sourceFunctions) {
      const newFunctionId = functionIdMap.get(fn.id);
      if (!newFunctionId) continue;

      const sourceFiles =
        (
          await client.query<{
            path: string;
            kind: string;
            content: string;
          }>(
            `
              SELECT path, kind, content
              FROM function_files
              WHERE function_id = $1 AND owner_id = $2
              ORDER BY path ASC
            `,
            [fn.id, ownerId],
          )
        ).rows;
      for (const file of sourceFiles) {
        await client.query(
          `
            INSERT INTO function_files (function_id, owner_id, path, kind, content)
            VALUES ($1, $2, $3, $4, $5)
          `,
          [newFunctionId, ownerId, file.path, file.kind, file.content],
        );
      }

      const sourceTokens =
        (
          await client.query<{
            name: string;
            value: string;
          }>(
            `
              SELECT name, value
              FROM function_tokens
              WHERE function_id = $1 AND owner_id = $2
              ORDER BY name ASC
            `,
            [fn.id, ownerId],
          )
        ).rows;
      for (const token of sourceTokens) {
        await client.query(
          `
            INSERT INTO function_tokens (function_id, owner_id, name, value)
            VALUES ($1, $2, $3, $4)
          `,
          [newFunctionId, ownerId, token.name, token.value],
        );
      }
    }

    const sourceSecrets =
      (
        await client.query<{
          name: string;
          value: string;
        }>(
          `
            SELECT name, value
            FROM secrets
            WHERE project_id = $1 AND owner_id = $2
            ORDER BY name ASC
          `,
          [source.id, ownerId],
        )
      ).rows;
    for (const secret of sourceSecrets) {
      await client.query(
        `
          INSERT INTO secrets (project_id, owner_id, name, value)
          VALUES ($1, $2, $3, $4)
        `,
        [project.id, ownerId, secret.name, secret.value],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw error;
  } finally {
    await client.end();
  }

  const platformOrigin = platformBaseUrl?.trim() || null;
  progress?.("info", "Proyecto clonado", {
    sourceProjectId,
    clonedProjectId: project.id,
    projectName: project.name,
    runtime,
    deploymentProfile,
    publicHostname,
  });

  const deployment = await deployProjectById({
    projectId: project.id,
    ownerId,
    platformBaseUrl: platformOrigin,
    publicDomain,
    progress,
  });

  await logEvent(project.id, ownerId, "info", "projects.clone", "Project cloned and deployed", {
    sourceProjectId,
    clonedProjectId: project.id,
    projectName: project.name,
    projectSlug: project.slug,
    runtime,
    deploymentProfile,
    publicHostname,
    deploymentId: deployment.deploymentId,
    fqdn: deployment.fqdn,
    version: deployment.version,
  });

  return {
    project,
    deployment,
  };
}
