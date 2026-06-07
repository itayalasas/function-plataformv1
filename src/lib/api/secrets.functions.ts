import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuthSystemAuth } from "@/lib/auth/server-middleware";
import { sql, ensureSchema } from "@/lib/neon/db.server";

const nameRe = /^[A-Z_][A-Z0-9_]{0,60}$/;

export const listSecrets = createServerFn({ method: "GET" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ projectId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureSchema();
    const s = sql();
    const rows = await s`SELECT id, name, value, updated_at FROM secrets WHERE project_id = ${data.projectId} AND owner_id = ${context.userId} ORDER BY name`;
    return rows as Array<{ id: string; name: string; value: string; updated_at: string }>;
  });

export const upsertSecret = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) =>
    z.object({
      projectId: z.string().uuid(),
      name: z.string().regex(nameRe, "Use UPPER_SNAKE_CASE"),
      value: z.string().max(20_000),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const s = sql();
    const rows = await s`
      INSERT INTO secrets (project_id, owner_id, name, value)
      VALUES (${data.projectId}, ${context.userId}, ${data.name}, ${data.value})
      ON CONFLICT (project_id, name)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      WHERE secrets.owner_id = ${context.userId}
      RETURNING id, name, value, updated_at
    `;
    return (rows as Array<{ id: string; name: string; value: string; updated_at: string }>)[0];
  });

export const deleteSecret = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const s = sql();
    await s`DELETE FROM secrets WHERE id = ${data.id} AND owner_id = ${context.userId}`;
    return { ok: true };
  });
