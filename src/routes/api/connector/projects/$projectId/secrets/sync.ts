import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { resolveConnectorAuth, syncConnectorProjectSecrets } from "@/lib/api/connector.shared";
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

const secretSchema = z.object({
  name: z.string().trim().regex(/^[A-Z_][A-Z0-9_]{0,60}$/, "Use UPPER_SNAKE_CASE"),
  value: z.string().max(20_000),
});

const SyncSecretsSchema = z.object({
  secrets: z.array(secretSchema),
});

export const Route = createFileRoute("/api/connector/projects/$projectId/secrets/sync")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonError(400, "Invalid JSON");
        }

        const parsed = SyncSecretsSchema.safeParse(body);
        if (!parsed.success) {
          return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
        }

        const auth = resolveConnectorAuth(request);
        if (!auth.ok) {
          return jsonError(auth.status, auth.error);
        }

        try {
          const result = await syncConnectorProjectSecrets({
            projectId: params.projectId,
            ownerId: auth.ownerId,
            secrets: parsed.data.secrets,
          });

          await logEvent(params.projectId, auth.ownerId, "info", "connector", "Secrets synced via connector", {
            authMode: auth.authMode,
            secrets: result.secrets.map((secret) => ({
              id: secret.id,
              name: secret.name,
              created: secret.created,
              updatedAt: secret.updatedAt,
            })),
            deletedCount: result.deletedCount,
          });

          return jsonOk({
            authMode: auth.authMode,
            ownerId: auth.ownerId,
            projectId: params.projectId,
            secrets: result.secrets,
            deletedCount: result.deletedCount,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return jsonError(500, "Secret sync failed", message);
        }
      },
    },
  },
});
