import { Client, neonConfig } from "@neondatabase/serverless";

import { getAuthSystemClaimsFromRequest } from "@/lib/auth/server-middleware";
import { getConnectorApiToken, getConnectorOwnerId } from "@/lib/config.server";
import { ensureSchema, slugify } from "@/lib/neon/db.server";
import {
  applyDefaultStorageMountPath,
  deployProjectById,
  normalizeProjectDeploymentProfile,
  type ProjectDeploymentProfile,
} from "./deployments.shared";
import { getRuntimeConfig, renderJavaStarterFiles, type RuntimeId } from "@/lib/runtimes";

if (typeof WebSocket !== "undefined" && neonConfig.webSocketConstructor !== WebSocket) {
  neonConfig.webSocketConstructor = WebSocket;
}

let warnedAboutPooledUrl = false;

function derivePooledNeonUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    const isNeonHost = host.endsWith(".neon.tech") || host.endsWith(".neon.com");
    if (!isNeonHost) return rawUrl;

    const labels = host.split(".");
    if (!labels[0]?.startsWith("ep-") || labels[0].includes("-pooler")) return rawUrl;

    labels[0] = `${labels[0]}-pooler`;
    url.hostname = labels.join(".");
    if (!warnedAboutPooledUrl) {
      warnedAboutPooledUrl = true;
      console.warn(
        "[connector] Using a derived pooled Neon connection string. Prefer a pooled URL with -pooler in the hostname.",
      );
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function getDatabaseUrl(): string {
  const rawUrl =
    process.env.NEON_DATABASE_URL_POOLER ||
    process.env.NEON_DATABASE_URL ||
    process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("NEON_DATABASE_URL is not set");
  return derivePooledNeonUrl(rawUrl);
}

function createDbClient(): Client {
  return new Client({ connectionString: getDatabaseUrl() });
}

async function withTransaction<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = createDbClient();
  await client.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failures
    }
    throw error;
  } finally {
    await client.end();
  }
}

export type ConnectorAuthMode = "authsystem" | "connector-token";

export type ConnectorAuthResult =
  | { ok: true; ownerId: string; authMode: ConnectorAuthMode }
  | { ok: false; status: number; error: string };

export type ConnectorProjectInput = {
  ownerId: string;
  name: string;
  runtime?: RuntimeId;
  deploymentProfile?: ProjectDeploymentProfile;
};

export type ConnectorProjectRecord = {
  id: string;
  name: string;
  slug: string;
  runtime: string;
  created_at: string;
  deployment_profile: ProjectDeploymentProfile;
};

export type ConnectorFunctionFileInput = {
  path: string;
  content: string;
  kind?: "file" | "dir";
};

export type ConnectorFunctionBundleInput = {
  name: string;
  slug?: string;
  entrypoint?: string;
  files?: ConnectorFunctionFileInput[];
};

export type ConnectorFunctionSyncInput = {
  projectId: string;
  ownerId: string;
  functions: ConnectorFunctionBundleInput[];
};

export type ConnectorFunctionSyncResult = {
  id: string;
  name: string;
  slug: string;
  entrypoint: string;
  created: boolean;
  filesUpserted: number;
  filesDeleted: number;
};

export type ConnectorSecretInput = {
  name: string;
  value: string;
};

export type ConnectorSecretSyncInput = {
  projectId: string;
  ownerId: string;
  secrets: ConnectorSecretInput[];
};

export type ConnectorSecretSyncResult = {
  id: string;
  name: string;
  created: boolean;
  updatedAt: string;
};

export type ConnectorSecretSyncSummary = {
  secrets: ConnectorSecretSyncResult[];
  deletedCount: number;
};

type ProjectRow = {
  id: string;
  slug: string;
  runtime: string | null;
  deployment_profile: unknown;
};

type FunctionRow = {
  id: string;
  name: string;
  slug: string;
  entrypoint: string;
  created_at: string;
  updated_at: string;
};

type FunctionFileRow = {
  id: string;
  path: string;
};

type SecretRow = {
  id: string;
  name: string;
  updated_at: string;
};

const secretNameRe = /^[A-Z_][A-Z0-9_]{0,60}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function isSafePath(path: string): boolean {
  const normalized = normalizePath(path);
  if (!normalized || normalized.length > 120) return false;
  return normalized
    .split("/")
    .every((segment) => segment !== "." && segment !== ".." && /^[a-zA-Z0-9._-]+$/.test(segment));
}

function collectParentDirectories(path: string): string[] {
  const parts = normalizePath(path).split("/").filter(Boolean);
  const parents: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    parents.push(parts.slice(0, i).join("/"));
  }
  return parents;
}

function normalizeJavaPackageSegment(seed: string): string {
  const base = slugify(seed).replace(/-/g, "") || "app";
  return /^[0-9]/.test(base) ? `app${base}` : base;
}

function starterFilesForRuntime(runtime: ReturnType<typeof getRuntimeConfig>, projectSlug: string) {
  if (runtime.id !== "java") {
    return runtime.starterFiles.map((file) => ({
      path: file.path,
      content: file.content,
      kind: "file" as const,
    }));
  }

  const basePackage = `com.${normalizeJavaPackageSegment(projectSlug)}`;
  return renderJavaStarterFiles(basePackage).map((file) => ({
    path: file.path,
    content: file.content,
    kind: "file" as const,
  }));
}

function getConnectorTokenFromRequest(request: Request): string {
  const headerToken = request.headers.get("x-vortex-connector-token")?.trim();
  if (headerToken) return headerToken;

  const apiKey = request.headers.get("x-api-key")?.trim();
  if (apiKey) return apiKey;

  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }

  return "";
}

export function resolveConnectorAuth(request: Request): ConnectorAuthResult {
  const claims = getAuthSystemClaimsFromRequest(request);
  if (claims?.sub) {
    return { ok: true, ownerId: claims.sub, authMode: "authsystem" };
  }

  const expectedToken = getConnectorApiToken();
  if (!expectedToken) {
    return { ok: false, status: 500, error: "Connector API token is not configured" };
  }

  const providedToken = getConnectorTokenFromRequest(request);
  if (!providedToken || providedToken !== expectedToken) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const ownerId = request.headers.get("x-vortex-owner-id")?.trim() || getConnectorOwnerId();
  if (!ownerId) {
    return {
      ok: false,
      status: 400,
      error: "Missing x-vortex-owner-id for connector-token requests",
    };
  }

  return { ok: true, ownerId, authMode: "connector-token" };
}

export async function createConnectorProject(input: ConnectorProjectInput): Promise<ConnectorProjectRecord> {
  await ensureSchema();

  const name = input.name.trim();
  if (!name) {
    throw new Error("Project name is required");
  }

  const runtime = input.runtime ?? "deno";
  const deploymentProfile = applyDefaultStorageMountPath(
    normalizeProjectDeploymentProfile(input.deploymentProfile ?? {}),
  );
  const projectSlug = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;

  return withTransaction(async (client) => {
    const rows = await client.query<ConnectorProjectRecord>(
      `
        INSERT INTO projects (owner_id, name, slug, runtime, deployment_profile)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        RETURNING id, name, slug, runtime, created_at, deployment_profile
      `,
      [input.ownerId, name, projectSlug, runtime, JSON.stringify(deploymentProfile)],
    );
    const project = rows.rows[0];
    if (!project) throw new Error("Failed to create project");
    return {
      ...project,
      deployment_profile: normalizeProjectDeploymentProfile(project.deployment_profile),
    };
  });
}

function normalizeBundleFiles(
  bundleFiles: ConnectorFunctionFileInput[] | undefined,
  fallbackFiles: Array<{ path: string; content: string }>,
): Array<{ path: string; content: string; kind: "file" | "dir" }> {
  const sourceFiles =
    bundleFiles && bundleFiles.length
      ? bundleFiles
      : fallbackFiles.map((file) => ({ ...file, kind: "file" as const }));

  if (!sourceFiles.length) {
    throw new Error("Function bundle has no files");
  }

  const entries = new Map<string, { path: string; content: string; kind: "file" | "dir" }>();
  for (const file of sourceFiles) {
    const path = normalizePath(file.path);
    if (!isSafePath(path)) {
      throw new Error(`Invalid file path: ${file.path}`);
    }
    if (entries.has(path)) {
      throw new Error(`Duplicate path in bundle: ${path}`);
    }
    const kind = file.kind ?? "file";
    entries.set(path, {
      path,
      content: kind === "dir" ? "" : file.content ?? "",
      kind,
    });

    if (kind === "file") {
      for (const parent of collectParentDirectories(path)) {
        if (!entries.has(parent)) {
          entries.set(parent, { path: parent, content: "", kind: "dir" });
        }
      }
    }
  }

  for (const entry of entries.values()) {
    if (entry.kind !== "file") continue;
    const prefix = `${entry.path}/`;
    for (const candidate of entries.values()) {
      if (candidate.path === entry.path) continue;
      if (candidate.path.startsWith(prefix)) {
        throw new Error(
          `Invalid bundle tree: file "${entry.path}" cannot contain child path "${candidate.path}"`,
        );
      }
    }
  }

  return [...entries.values()];
}

async function syncFunctionFiles(
  client: Client,
  functionId: string,
  ownerId: string,
  desiredFiles: Array<{ path: string; content: string; kind: "file" | "dir" }>,
): Promise<{ upserted: number; deleted: number }> {
  const existingRows = await client.query<FunctionFileRow>(
    `
      SELECT id, path
      FROM function_files
      WHERE function_id = $1 AND owner_id = $2
      ORDER BY path ASC
    `,
    [functionId, ownerId],
  );

  const desiredByPath = new Map(desiredFiles.map((file) => [file.path, file]));
  let upserted = 0;
  for (const file of desiredFiles) {
    await client.query(
      `
        INSERT INTO function_files (function_id, owner_id, path, content, kind)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (function_id, path)
        DO UPDATE SET content = EXCLUDED.content, kind = EXCLUDED.kind, updated_at = now()
      `,
      [functionId, ownerId, file.path, file.content, file.kind],
    );
    upserted += 1;
  }

  let deleted = 0;
  for (const row of existingRows.rows) {
    if (desiredByPath.has(row.path)) continue;
    await client.query(`DELETE FROM function_files WHERE id = $1 AND owner_id = $2`, [
      row.id,
      ownerId,
    ]);
    deleted += 1;
  }

  return { upserted, deleted };
}

export async function syncConnectorProjectFunctions(
  input: ConnectorFunctionSyncInput,
): Promise<ConnectorFunctionSyncResult[]> {
  await ensureSchema();

  if (!input.functions.length) {
    throw new Error("At least one function bundle is required");
  }

  return withTransaction(async (client) => {
    const projectRows = await client.query<ProjectRow>(
      `
        SELECT id, slug, runtime, deployment_profile
        FROM projects
        WHERE id = $1 AND owner_id = $2
        LIMIT 1
      `,
      [input.projectId, input.ownerId],
    );
    if (!projectRows.rows[0]) throw new Error("Project not found");

    const runtime = getRuntimeConfig((project.runtime ?? "deno") as RuntimeId);
    if (!runtime.multiFunction && input.functions.length > 1) {
      throw new Error(`El runtime ${runtime.label} no soporta multiples funciones por proyecto.`);
    }

    const existingRows = await client.query<FunctionRow>(
      `
        SELECT id, name, slug, entrypoint, created_at, updated_at
        FROM functions
        WHERE project_id = $1 AND owner_id = $2
        ORDER BY created_at ASC
      `,
      [input.projectId, input.ownerId],
    );

    const functionsBySlug = new Map(existingRows.rows.map((row) => [row.slug, row]));
    const desiredFunctionIds = new Set<string>();
    const desiredFunctionSlugs = new Set<string>();
    const results: ConnectorFunctionSyncResult[] = [];

    for (const bundle of input.functions) {
      const name = bundle.name.trim();
      if (!name) {
        throw new Error("Function name is required");
      }

      const slug = slugify(bundle.slug?.trim() || name);
      if (desiredFunctionSlugs.has(slug)) {
        throw new Error(`Duplicate function slug in payload: ${slug}`);
      }
      desiredFunctionSlugs.add(slug);

      const entrypoint = normalizePath(bundle.entrypoint?.trim() || runtime.defaultEntrypoint);
      const files = normalizeBundleFiles(bundle.files, starterFilesForRuntime(runtime, project.slug));

      let target = runtime.multiFunction
        ? functionsBySlug.get(slug) ?? null
        : functionsBySlug.get(slug) ?? existingRows.rows[0] ?? null;
      let created = false;

      let targetId = target?.id ?? null;
      if (!targetId) {
        const inserted = await client.query<FunctionRow>(
          `
            INSERT INTO functions (project_id, owner_id, name, slug, entrypoint, status)
            VALUES ($1, $2, $3, $4, $5, 'draft')
            RETURNING id, name, slug, entrypoint, created_at, updated_at
          `,
          [input.projectId, input.ownerId, name, slug, entrypoint],
        );
        const insertedRow = inserted.rows[0];
        if (!insertedRow) throw new Error(`Failed to create function ${slug}`);
        target = insertedRow;
        targetId = insertedRow.id;
        created = true;
        functionsBySlug.set(insertedRow.slug, insertedRow);
      } else {
        await client.query(
          `
            UPDATE functions
            SET name = $1, slug = $2, entrypoint = $3, status = 'modified', updated_at = now()
            WHERE id = $4 AND owner_id = $5
          `,
          [name, slug, entrypoint, targetId, input.ownerId],
        );
        const updatedTarget: FunctionRow = {
          id: targetId,
          name,
          slug,
          entrypoint,
          created_at: target.created_at,
          updated_at: new Date().toISOString(),
        };
        if (target.slug !== slug) {
          functionsBySlug.delete(target.slug);
        }
        functionsBySlug.set(slug, updatedTarget);
        target = updatedTarget;
      }

      desiredFunctionIds.add(targetId);
      const fileSync = await syncFunctionFiles(client, targetId, input.ownerId, files);
      await client.query(
        `
          UPDATE functions
          SET updated_at = now(), status = $1
          WHERE id = $2 AND owner_id = $3
        `,
        [created ? "draft" : "modified", targetId, input.ownerId],
      );

      results.push({
        id: targetId,
        name,
        slug,
        entrypoint,
        created,
        filesUpserted: fileSync.upserted,
        filesDeleted: fileSync.deleted,
      });
    }

    for (const row of existingRows.rows) {
      if (desiredFunctionIds.has(row.id)) continue;
      await client.query(`DELETE FROM functions WHERE id = $1 AND owner_id = $2`, [
        row.id,
        input.ownerId,
      ]);
    }

    return results;
  });
}

export async function syncConnectorProjectSecrets(
  input: ConnectorSecretSyncInput,
): Promise<ConnectorSecretSyncSummary> {
  await ensureSchema();

  return withTransaction(async (client) => {
    const projectRows = await client.query<ProjectRow>(
      `
        SELECT id, slug, runtime, deployment_profile
        FROM projects
        WHERE id = $1 AND owner_id = $2
        LIMIT 1
      `,
      [input.projectId, input.ownerId],
    );
    const project = projectRows.rows[0];
    if (!project) throw new Error("Project not found");

    const existingRows = await client.query<SecretRow>(
      `
        SELECT id, name, updated_at
        FROM secrets
        WHERE project_id = $1 AND owner_id = $2
        ORDER BY name ASC
      `,
      [input.projectId, input.ownerId],
    );

    const existingByName = new Map(existingRows.rows.map((row) => [row.name, row]));
    const desiredNames = new Set<string>();
    const normalizedSecrets = input.secrets.map((secret) => {
      const name = secret.name.trim();
      if (!name) {
        throw new Error("Secret name is required");
      }
      if (!secretNameRe.test(name)) {
        throw new Error(`Invalid secret name: ${name}`);
      }
      if (desiredNames.has(name)) {
        throw new Error(`Duplicate secret name in payload: ${name}`);
      }
      desiredNames.add(name);
      return { name, value: secret.value };
    });

    const secrets: ConnectorSecretSyncResult[] = [];
    for (const secret of normalizedSecrets) {
      const existing = existingByName.get(secret.name) ?? null;
      const rows = await client.query<SecretRow>(
        `
          INSERT INTO secrets (project_id, owner_id, name, value)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (project_id, name)
          DO UPDATE SET value = EXCLUDED.value, updated_at = now()
          WHERE secrets.owner_id = $2
          RETURNING id, name, updated_at
        `,
        [input.projectId, input.ownerId, secret.name, secret.value],
      );
      const row = rows.rows[0];
      if (!row) throw new Error(`Failed to sync secret ${secret.name}`);
      secrets.push({
        id: row.id,
        name: row.name,
        created: !existing,
        updatedAt: row.updated_at,
      });
    }

    let deletedCount = 0;
    for (const row of existingRows.rows) {
      if (desiredNames.has(row.name)) continue;
      await client.query(`DELETE FROM secrets WHERE id = $1 AND owner_id = $2`, [
        row.id,
        input.ownerId,
      ]);
      deletedCount += 1;
    }

    return { secrets, deletedCount };
  });
}

export async function deployConnectorProject(input: {
  projectId: string;
  ownerId: string;
  publicDomain?: ProjectDeploymentProfile["publicDomain"];
  platformBaseUrl?: string | null;
}) {
  return deployProjectById({
    projectId: input.projectId,
    ownerId: input.ownerId,
    publicDomain: input.publicDomain ?? undefined,
    platformBaseUrl: input.platformBaseUrl ?? undefined,
  });
}
