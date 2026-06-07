import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuthSystemAuth } from "@/lib/auth/server-middleware";
import { sql, ensureSchema } from "@/lib/neon/db.server";

export const listSystemLogs = createServerFn({ method: "GET" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ projectId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureSchema();
    const s = sql();
    const rows = (await s`
      SELECT id, level, source, message, meta, created_at
      FROM system_logs
      WHERE project_id = ${data.projectId} AND owner_id = ${context.userId}
      ORDER BY created_at DESC
      LIMIT 200
    `) as Array<{
      id: string;
      level: string;
      source: string;
      message: string;
      meta: unknown;
      created_at: string;
    }>;
    // Serialize meta to a JSON string so the RPC envelope stays strictly-typed.
    return rows.map((r) => ({
      id: r.id,
      level: r.level,
      source: r.source,
      message: r.message,
      meta: r.meta == null ? null : JSON.stringify(r.meta),
      created_at: r.created_at,
    }));
  });

export const clearSystemLogs = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ projectId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureSchema();
    const s = sql();
    await s`DELETE FROM system_logs WHERE project_id = ${data.projectId} AND owner_id = ${context.userId}`;
    return { ok: true };
  });
