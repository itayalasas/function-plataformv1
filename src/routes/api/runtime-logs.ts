import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { ensureSchema, logEvent, recordInvocationLog, sql } from "@/lib/neon/db.server";

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const RuntimeLogSchema = z.object({
  projectId: z.string().uuid(),
  token: z.string().min(1).optional(),
  level: z.enum(["info", "warn", "error", "debug"]).default("info"),
  source: z.string().min(1).default("runtime"),
  message: z.string().min(1),
  meta: z.unknown().optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export const Route = createFileRoute("/api/runtime-logs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await ensureSchema();

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonError(400, "Invalid JSON");
        }

        const parsed = RuntimeLogSchema.safeParse(body);
        if (!parsed.success) {
          return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
        }

        const { projectId, token, level, source, message, meta } = parsed.data;
        const headerToken = request.headers.get("x-vortex-log-token")?.trim() ?? "";
        const runtimeToken = headerToken || token || "";
        const s = sql();
        const rows =
          (await s`SELECT owner_id, log_token FROM projects WHERE id = ${projectId} LIMIT 1`) as Array<{
            owner_id: string;
            log_token: string | null;
          }>;
        const project = rows[0];
        if (!project || !project.log_token || project.log_token !== runtimeToken) {
          return jsonError(401, "Unauthorized");
        }

        const metaRecord = isRecord(meta) ? meta : {};
        const requestMeta = isRecord(metaRecord.request) ? metaRecord.request : undefined;
        const responseMeta = isRecord(metaRecord.response) ? metaRecord.response : undefined;
        const functionId = asString(metaRecord.functionId);
        const functionSlug = asString(metaRecord.function);
        const kind = asString(metaRecord.kind) ?? (source === "outbound" ? "outbound" : "runtime");
        const target =
          asString(metaRecord.target) ??
          asString(requestMeta?.url) ??
          asString(requestMeta?.path) ??
          asString(metaRecord.url);

        await logEvent(projectId, project.owner_id, level, source, message, meta);

        if (requestMeta && responseMeta) {
          let resolvedFunctionId = functionId;
          if (!resolvedFunctionId) {
            if (functionSlug) {
              const functionRows =
                (await s`
                  SELECT id
                  FROM functions
                  WHERE project_id = ${projectId} AND owner_id = ${project.owner_id} AND slug = ${functionSlug}
                  LIMIT 1
                `) as Array<{ id: string }>;
              resolvedFunctionId = functionRows[0]?.id ?? null;
            } else {
              const functionRows =
                (await s`
                  SELECT id
                  FROM functions
                  WHERE project_id = ${projectId} AND owner_id = ${project.owner_id}
                  ORDER BY created_at ASC
                  LIMIT 1
                `) as Array<{ id: string }>;
              resolvedFunctionId = functionRows[0]?.id ?? null;
            }
          }

          if (resolvedFunctionId) {
            await recordInvocationLog({
              projectId,
              functionId: resolvedFunctionId,
              ownerId: project.owner_id,
              kind,
              method: asString(requestMeta.method) ?? "GET",
              path: asString(requestMeta.path) ?? target ?? "/",
              target,
              status: typeof responseMeta.status === "number" ? responseMeta.status : null,
              durationMs: typeof metaRecord.durationMs === "number" ? metaRecord.durationMs : null,
              error: asString(metaRecord.error),
              request: requestMeta,
              response: responseMeta,
              meta: {
                ...metaRecord,
                projectId,
                source,
              },
            });
          }
        }

        return new Response(null, {
          status: 204,
          headers: {
            "cache-control": "no-store",
          },
        });
      },
    },
  },
});
