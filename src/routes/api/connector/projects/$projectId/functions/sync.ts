import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { resolveConnectorAuth, syncConnectorProjectFunctions } from "@/lib/api/connector.shared";
import { logEvent } from "@/lib/neon/db.server";

function jsonError(status: number, error: string, details?: string): Response {
  return new Response(JSON.stringify({ error, ...(details ? { details } : {}) }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const functionFileSchema = z.object({
  path: z.string().trim().min(1).max(120),
  content: z.string().max(2_000_000).default(""),
  kind: z.enum(["file", "dir"]).default("file"),
});

const functionBundleSchema = z.object({
  name: z.string().trim().min(1).max(60),
  slug: z.string().trim().min(1).max(60).optional(),
  entrypoint: z.string().trim().min(1).max(120).optional(),
  files: z.array(functionFileSchema).min(1),
});

const SyncFunctionsSchema = z.object({
  functions: z.array(functionBundleSchema).min(1),
});

export const Route = createFileRoute("/api/connector/projects/$projectId/functions/sync")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonError(400, "Invalid JSON");
        }

        const parsed = SyncFunctionsSchema.safeParse(body);
        if (!parsed.success) {
          return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
        }

        const auth = resolveConnectorAuth(request);
        if (!auth.ok) {
          return jsonError(auth.status, auth.error);
        }

        try {
          const functions = await syncConnectorProjectFunctions({
            projectId: params.projectId,
            ownerId: auth.ownerId,
            functions: parsed.data.functions,
          });

          await logEvent(params.projectId, auth.ownerId, "info", "connector", "Functions synced via connector", {
            authMode: auth.authMode,
            functions: functions.map((fn) => ({
              id: fn.id,
              slug: fn.slug,
              entrypoint: fn.entrypoint,
              created: fn.created,
              filesUpserted: fn.filesUpserted,
              filesDeleted: fn.filesDeleted,
            })),
          });

          return jsonOk({
            authMode: auth.authMode,
            ownerId: auth.ownerId,
            projectId: params.projectId,
            functions,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return jsonError(500, "Function sync failed", message);
        }
      },
    },
  },
});
