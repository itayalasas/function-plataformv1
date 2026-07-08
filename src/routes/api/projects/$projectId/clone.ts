import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { cloneProjectAndDeploy } from "@/lib/api/project-clone.shared";
import { getCloneApiToken } from "@/lib/config.server";
import { ensureSchema, sql } from "@/lib/neon/db.server";

function jsonError(status: number, error: string, details?: string): Response {
  return new Response(JSON.stringify({ error, ...(details ? { details } : {}) }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const dnsDomainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i, "Use a valid domain");

const dnsLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i, "Use a valid subdomain");

const CloneProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    tenantLabel: z.string().trim().min(1).max(60).optional(),
    cpu: z.number().positive().max(8).optional(),
    memory: z.string().regex(/^\d+(\.\d+)?Gi$/i, "Use a value like 1Gi or 2Gi").optional(),
    minReplicas: z.number().int().min(1).max(20).optional(),
    maxReplicas: z.number().int().min(1).max(20).optional(),
    storageMountPath: z.string().regex(/^\/[^\0]*$/, "Use an absolute mount path").optional(),
    domain: dnsDomainSchema.nullable().optional(),
    subdomain: dnsLabelSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      typeof value.minReplicas === "number" &&
      typeof value.maxReplicas === "number" &&
      value.minReplicas > value.maxReplicas
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["minReplicas"],
        message: "minReplicas cannot be greater than maxReplicas",
      });
    }

    if (value.subdomain && !value.domain) {
      ctx.addIssue({
        code: "custom",
        path: ["domain"],
        message: "domain is required when subdomain is provided",
      });
    }
  });

function getSharedCloneToken(request: Request): string {
  const headerToken = request.headers.get("x-vortex-clone-token")?.trim();
  if (headerToken) return headerToken;

  const apiKey = request.headers.get("x-api-key")?.trim();
  if (apiKey) return apiKey;

  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }

  return "";
}

export const Route = createFileRoute("/api/projects/$projectId/clone")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonError(400, "Invalid JSON");
        }

        const parsed = CloneProjectSchema.safeParse(body);
        if (!parsed.success) {
          return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
        }

        const expectedToken = getCloneApiToken();
        const providedToken = getSharedCloneToken(request);
        if (!expectedToken) {
          return jsonError(500, "Clone API token is not configured");
        }

        if (providedToken !== expectedToken) {
          return jsonError(
            401,
            "Unauthorized",
          );
        }

        await ensureSchema();

        const s = sql();
        const rows = (await s`
          SELECT owner_id
          FROM projects
          WHERE id = ${params.projectId}
          LIMIT 1
        `) as Array<{ owner_id: string }>;
        const ownerId = rows[0]?.owner_id ?? null;

        if (!ownerId) {
          return jsonError(404, "Project not found");
        }

        const platformBaseUrl = new URL(request.url).origin;

        try {
          const result = await cloneProjectAndDeploy({
            sourceProjectId: params.projectId,
            ownerId,
            requestedName: parsed.data.name,
            tenantLabel: parsed.data.tenantLabel?.trim() || null,
            platformBaseUrl,
            domain: parsed.data.domain?.trim() || null,
            subdomain: parsed.data.subdomain?.trim() || null,
            deploymentOverrides: {
              cpu: parsed.data.cpu,
              memory: parsed.data.memory,
              minReplicas: parsed.data.minReplicas,
              maxReplicas: parsed.data.maxReplicas,
              storageMountPath: parsed.data.storageMountPath,
            },
          });

          return new Response(JSON.stringify(result), {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return jsonError(500, "Clone failed", message);
        }
      },
    },
  },
});
