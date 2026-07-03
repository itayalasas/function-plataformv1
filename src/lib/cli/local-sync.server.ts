import path from "node:path";

import { sql, ensureSchema, slugify } from "../neon/db.server.ts";
import { getRuntimeConfig } from "../runtimes/index.ts";
import {
  deployProjectById,
  type DeployProjectResult,
  type DeployProgressLogger,
} from "../api/deployments.shared.ts";
import { discoverLocalFunctionBundles, type LocalFunctionBundle } from "./local-source.ts";

export type LocalSyncOptions = {
  projectId: string;
  sourceRoot: string;
  functionName?: string | null;
  progress?: DeployProgressLogger;
};

export type LocalSyncBundleResult = {
  slug: string;
  name: string;
  entrypoint: string;
  created: boolean;
  filesUpserted: number;
  filesDeleted: number;
};

export type LocalSyncResult = {
  projectId: string;
  projectName: string;
  projectSlug: string;
  runtime: string;
  ownerId: string;
  bundles: LocalSyncBundleResult[];
  deployment: DeployProjectResult;
};

type ProjectRow = {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  runtime: string | null;
};

function normalizeRelativePath(input: string): string {
  return input
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

async function getProject(projectId: string): Promise<ProjectRow> {
  await ensureSchema();
  const s = sql();
  const rows =
    (await s`SELECT id, owner_id, name, slug, runtime FROM projects WHERE id = ${projectId} LIMIT 1`) as ProjectRow[];
  if (!rows[0]) throw new Error(`Project not found: ${projectId}`);
  return rows[0];
}

async function upsertFunctionBundle(
  bundle: LocalFunctionBundle,
  project: ProjectRow,
  progress: DeployProgressLogger | undefined,
  position: number,
  total: number,
): Promise<LocalSyncBundleResult> {
  const s = sql();
  const existingRows =
    (await s`SELECT id, name, slug, entrypoint, status FROM functions WHERE project_id = ${project.id} AND slug = ${bundle.slug} LIMIT 1`) as Array<{
      id: string;
      name: string;
      slug: string;
      entrypoint: string;
      status: string;
    }>;
  const existing = existingRows[0] ?? null;
  const functionName = bundle.displayName || bundle.slug;
  const functionSlug = slugify(bundle.config?.slug ?? bundle.slug);
  const entrypoint = normalizeRelativePath(bundle.entrypoint);

  progress?.("info", `Sincronizando función ${position}/${total}: ${functionName}`, {
    slug: functionSlug,
    entrypoint,
    position,
    total,
  });

  let functionId = existing?.id ?? null;
  let created = false;
  if (!functionId) {
    const inserted =
      (await s`
        INSERT INTO functions (project_id, owner_id, name, slug, entrypoint, status)
        VALUES (${project.id}, ${project.owner_id}, ${functionName}, ${functionSlug}, ${entrypoint}, 'draft')
        RETURNING id
      `) as Array<{ id: string }>;
    functionId = inserted[0].id;
    created = true;
  } else {
    await s`
      UPDATE functions
      SET name = ${functionName}, slug = ${functionSlug}, entrypoint = ${entrypoint}, status = 'modified', updated_at = now()
      WHERE id = ${functionId} AND owner_id = ${project.owner_id}
    `;
  }

  const desiredEntries = new Map<string, { kind: "file" | "dir"; content: string }>();
  for (const file of bundle.files) {
    const normalized = normalizeRelativePath(file.path);
    if (!normalized) continue;
    desiredEntries.set(normalized, { kind: file.kind, content: file.content });
  }

  const existingFiles =
    (await s`SELECT id, path, kind FROM function_files WHERE function_id = ${functionId} AND owner_id = ${project.owner_id}`) as Array<{
      id: string;
      path: string;
      kind: string;
    }>;

  let filesUpserted = 0;
  for (const [filePath, file] of desiredEntries.entries()) {
    await s`
      INSERT INTO function_files (function_id, owner_id, path, content, kind)
      VALUES (${functionId}, ${project.owner_id}, ${filePath}, ${file.content}, ${file.kind})
      ON CONFLICT (function_id, path)
      DO UPDATE SET content = EXCLUDED.content, kind = EXCLUDED.kind, updated_at = now()
    `;
    filesUpserted += 1;
  }

  let filesDeleted = 0;
  for (const existingFile of existingFiles) {
    const normalized = normalizeRelativePath(existingFile.path);
    if (desiredEntries.has(normalized)) continue;
    await s`DELETE FROM function_files WHERE id = ${existingFile.id} AND owner_id = ${project.owner_id}`;
    filesDeleted += 1;
  }

  await s`
    UPDATE functions
    SET status = ${created ? "draft" : "modified"}, updated_at = now()
    WHERE id = ${functionId} AND owner_id = ${project.owner_id}
  `;

  return {
    slug: functionSlug,
    name: functionName,
    entrypoint,
    created,
    filesUpserted,
    filesDeleted,
  };
}

/**
 * Sync local source files to the platform DB and deploy the project using the
 * exact same deploy logic as the web UI.
 */
export async function deployLocalSource({
  projectId,
  sourceRoot,
  functionName,
  progress,
}: LocalSyncOptions): Promise<LocalSyncResult> {
  const project = await getProject(projectId);
  const runtime = getRuntimeConfig(project.runtime);
  const bundles = await discoverLocalFunctionBundles({
    sourceRoot,
    runtimeId: runtime.id,
    functionName,
  });

  if (!runtime.multiFunction && bundles.length > 1) {
    throw new Error(`El runtime ${runtime.label} no soporta multiples funciones por proyecto.`);
  }

  progress?.("info", `Encontradas ${bundles.length} función(es) en ${sourceRoot}`, {
    projectId: project.id,
    projectName: project.name,
    projectSlug: project.slug,
    runtime: runtime.id,
    sourceRoot,
  });

  const syncResults: LocalSyncBundleResult[] = [];
  for (const [index, bundle] of bundles.entries()) {
    syncResults.push(await upsertFunctionBundle(bundle, project, progress, index + 1, bundles.length));
  }

  progress?.("info", `Desplegando proyecto ${project.name}`, {
    projectId: project.id,
    projectSlug: project.slug,
    runtime: runtime.id,
    bundles: syncResults.length,
  });

  const deployment = await deployProjectById({
    projectId: project.id,
    ownerId: project.owner_id,
    progress,
  });

  progress?.("info", `Proyecto desplegado ${project.name}`, {
    projectId: project.id,
    projectSlug: project.slug,
    runtime: runtime.id,
    version: deployment.version,
    fqdn: deployment.fqdn,
  });

  return {
    projectId: project.id,
    projectName: project.name,
    projectSlug: project.slug,
    runtime: runtime.id,
    ownerId: project.owner_id,
    bundles: syncResults,
    deployment,
  };
}
