import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuthSystemAuth } from "@/lib/auth/server-middleware";
import { sql, ensureSchema } from "@/lib/neon/db.server";

// Acepta UPPER_SNAKE_CASE y nombres tipo cabecera HTTP (X-API-KEY)
const nameRe = /^[A-Za-z_][A-Za-z0-9_-]{0,60}$/;

export const listTokens = createServerFn({ method: "GET" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ functionId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureSchema();
    const s = sql();
    const rows = await s`SELECT id, name, value, updated_at FROM function_tokens WHERE function_id = ${data.functionId} AND owner_id = ${context.userId} ORDER BY name`;
    return rows as Array<{ id: string; name: string; value: string; updated_at: string }>;
  });

export const upsertToken = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) =>
    z.object({
      functionId: z.string().uuid(),
      name: z.string().regex(nameRe, "Usa letras, números, guion bajo o guion (p. ej. X-API-KEY o MY_TOKEN)"),
      value: z.string().max(20_000),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const s = sql();
    const rows = await s`
      INSERT INTO function_tokens (function_id, owner_id, name, value)
      VALUES (${data.functionId}, ${context.userId}, ${data.name}, ${data.value})
      ON CONFLICT (function_id, name)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      WHERE function_tokens.owner_id = ${context.userId}
      RETURNING id, name, value, updated_at
    `;
    return (rows as Array<{ id: string; name: string; value: string; updated_at: string }>)[0];
  });

export const deleteToken = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const s = sql();
    await s`DELETE FROM function_tokens WHERE id = ${data.id} AND owner_id = ${context.userId}`;
    return { ok: true };
  });
