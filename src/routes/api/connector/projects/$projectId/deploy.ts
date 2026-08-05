import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { resolveConnectorAuth, deployConnectorProject } from "@/lib/api/connector.shared";
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

const publicDomainSchema = z
  .object({
    domain: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i, "Use a valid domain"),
    subdomain: z
      .string()
      .trim()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i, "Use a valid subdomain")
      .nullable()
      .optional(),
    ttl: z.number().int().min(60).max(86400).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.subdomain && !value.domain) {
      ctx.addIssue({
        code: "custom",
        path: ["domain"],
        message: "domain is required when subdomain is provided",
      });
    }
  })
  .nullable()
  .optional();

const DeploySchema = z.object({
  publicDomain: publicDomainSchema,
});

async function readOptionalJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON");
  }
}

export const Route = createFileRoute("/api/connector/projects/$projectId/deploy")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        let body: unknown;
        try {
          body = await readOptionalJsonBody(request);
        } catch {
          return jsonError(400, "Invalid JSON");
        }

        const parsed = DeploySchema.safeParse(body);
        if (!parsed.success) {
          return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
        }

        const auth = resolveConnectorAuth(request);
        if (!auth.ok) {
          return jsonError(auth.status, auth.error);
        }

        try {
          const deployment = await deployConnectorProject({
            projectId: params.projectId,
            ownerId: auth.ownerId,
            publicDomain: parsed.data.publicDomain ?? undefined,
            platformBaseUrl: new URL(request.url).origin,
          });

          await logEvent(params.projectId, auth.ownerId, "info", "connector", "Project deployed via connector", {
            authMode: auth.authMode,
            deploymentId: deployment.deploymentId,
            version: deployment.version,
            fqdn: deployment.fqdn,
            runtime: deployment.runtime,
            publicHostname: deployment.publicHostname,
            publicHostnameStatus: deployment.publicHostnameStatus,
            certificateState: deployment.certificateState,
          });

          return jsonOk({
            authMode: auth.authMode,
            ownerId: auth.ownerId,
            projectId: params.projectId,
            deployment,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return jsonError(500, "Deploy failed", message);
        }
      },
    },
  },
});
