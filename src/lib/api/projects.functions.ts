import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuthSystemAuth } from "@/lib/auth/server-middleware";
import { sql, ensureSchema, slugify } from "@/lib/neon/db.server";
import { RUNTIMES, type RuntimeId } from "@/lib/runtimes";
import { deleteContainerApp } from "@/lib/azure/aca.server";

const runtimeSchema = z.enum(RUNTIMES as [RuntimeId, ...RuntimeId[]]);

export const listProjects = createServerFn({ method: "GET" })
  .middleware([requireAuthSystemAuth])
  .handler(async ({ context }) => {
    await ensureSchema();
    const s = sql();
    const rows =
      await s`SELECT id, name, slug, runtime, created_at FROM projects WHERE owner_id = ${context.userId} ORDER BY created_at DESC`;
    return rows as {
      id: string;
      name: string;
      slug: string;
      runtime: string;
      created_at: string;
    }[];
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
    const rows =
      await s`INSERT INTO projects (owner_id, name, slug, runtime) VALUES (${context.userId}, ${data.name}, ${slug}, ${runtime}) RETURNING id, name, slug, runtime, created_at`;
    return (
      rows as Array<{ id: string; name: string; slug: string; runtime: string; created_at: string }>
    )[0];
  });

export const updateProjectRuntime = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid(), runtime: runtimeSchema }).parse(d))
  .handler(async ({ data, context }) => {
    const s = sql();
    await s`UPDATE projects SET runtime = ${data.runtime} WHERE id = ${data.id} AND owner_id = ${context.userId}`;
    return { ok: true };
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
