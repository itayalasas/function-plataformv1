import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuthSystemAuth } from "@/lib/auth/server-middleware";
import { sql, ensureSchema, slugify } from "@/lib/neon/db.server";
import { getRuntimeConfig, renderJavaStarterFiles } from "@/lib/runtimes";

function javaPackageSegment(seed: string): string {
  const base = slugify(seed).replace(/-/g, "") || "app";
  return /^[0-9]/.test(base) ? `app${base}` : base;
}

function collectParentDirectories(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const rawPath of paths) {
    const parts = rawPath.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i += 1) {
      dirs.add(parts.slice(0, i).join("/"));
    }
  }
  return [...dirs];
}

export const listFunctions = createServerFn({ method: "GET" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ projectId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureSchema();
    const s = sql();
    const rows =
      await s`SELECT id, name, slug, entrypoint, status, fqdn, current_deployment_id, created_at, updated_at FROM functions WHERE project_id = ${data.projectId} AND owner_id = ${context.userId} ORDER BY updated_at DESC`;
    return rows as Array<{
      id: string;
      name: string;
      slug: string;
      entrypoint: string;
      status: string;
      fqdn: string | null;
      current_deployment_id: string | null;
      created_at: string;
      updated_at: string;
    }>;
  });

export const createFunction = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) =>
    z.object({ projectId: z.string().uuid(), name: z.string().min(1).max(60) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureSchema();
    const s = sql();

    // Look up project's runtime so we seed the right starter files.
    const projRows =
      (await s`SELECT runtime, slug FROM projects WHERE id = ${data.projectId} AND owner_id = ${context.userId}`) as Array<{
        runtime: string;
        slug: string;
      }>;
    if (!projRows[0]) throw new Error("Project not found");
    const runtime = getRuntimeConfig(projRows[0].runtime);
    let starterFiles = runtime.starterFiles;
    let entrypoint = runtime.defaultEntrypoint;
    if (runtime.id === "java") {
      const existingJavaFunctionRows = (await s`
        SELECT COUNT(*)::int AS count
        FROM functions
        WHERE project_id = ${data.projectId} AND owner_id = ${context.userId}
      `) as Array<{
        count: number;
      }>;
      const existingJavaFunctions = existingJavaFunctionRows[0]?.count ?? 0;
      if (existingJavaFunctions > 0) {
        throw new Error(
          "Java solo permite una función por proyecto. Edita App.java para agregar métodos dentro de la misma API.",
        );
      }
      const projectJavaBasePackage = `com.${javaPackageSegment(projRows[0].slug)}`;
      starterFiles = renderJavaStarterFiles(projectJavaBasePackage);
      entrypoint =
        starterFiles.find((f) => f.path.endsWith("App.java"))?.path ??
        starterFiles.find((f) => f.path.endsWith("Controller.java"))?.path ??
        runtime.defaultEntrypoint;
    }

    const slug = slugify(data.name);
    const fnRows =
      await s`INSERT INTO functions (project_id, owner_id, name, slug, entrypoint) VALUES (${data.projectId}, ${context.userId}, ${data.name}, ${slug}, ${entrypoint}) RETURNING id, name, slug, entrypoint, status, fqdn, current_deployment_id, updated_at`;
    const fn = (fnRows as Array<{ id: string }>)[0];

    // Seed all starter files for this runtime.
    for (const file of starterFiles) {
      await s`INSERT INTO function_files (function_id, owner_id, path, content) VALUES (${fn.id}, ${context.userId}, ${file.path}, ${file.content})`;
    }
    if (runtime.id === "java") {
      const dirs = collectParentDirectories(starterFiles.map((file) => file.path));
      for (const dir of dirs) {
        await s`INSERT INTO function_files (function_id, owner_id, path, content, kind) VALUES (${fn.id}, ${context.userId}, ${dir}, '', 'dir')`;
      }
    }
    return fnRows[0];
  });

export const renameFunction = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) =>
    z.object({ id: z.string().uuid(), name: z.string().min(1).max(60) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const s = sql();
    await s`UPDATE functions SET name = ${data.name}, updated_at = now() WHERE id = ${data.id} AND owner_id = ${context.userId}`;
    return { ok: true };
  });

export const deleteFunction = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureSchema();
    const s = sql();
    const rows = (await s`
      SELECT f.project_id, COALESCE(f.container_app_name, p.container_app_name) AS container_app_name
      FROM functions f
      JOIN projects p ON p.id = f.project_id
      WHERE f.id = ${data.id} AND f.owner_id = ${context.userId}
    `) as Array<{ project_id: string; container_app_name: string | null }>;
    if (!rows[0]) throw new Error("Function not found");
    const { project_id, container_app_name: name } = rows[0];

    await s`DELETE FROM functions WHERE id = ${data.id} AND owner_id = ${context.userId}`;

    const remaining =
      (await s`SELECT COUNT(*)::int AS count FROM functions WHERE project_id = ${project_id} AND owner_id = ${context.userId}`) as Array<{
        count: number;
      }>;
    if ((remaining[0]?.count ?? 0) === 0 && name) {
      try {
        const { deleteContainerApp } = await import("@/lib/azure/aca.server");
        await deleteContainerApp(name);
      } catch (e) {
        console.error("ACA delete failed:", e);
      }
    }
    return { ok: true };
  });
