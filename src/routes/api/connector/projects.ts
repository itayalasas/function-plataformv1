import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { resolveConnectorAuth, createConnectorProject } from "@/lib/api/connector.shared";
import { logEvent } from "@/lib/neon/db.server";
import { RUNTIMES, type RuntimeId } from "@/lib/runtimes";

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

const runtimeSchema = z.enum(RUNTIMES as [RuntimeId, ...RuntimeId[]]);

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

const deploymentProfileSchema = z
  .object({
    cpu: z.number().positive().max(8).optional(),
    memory: z.string().regex(/^\d+(\.\d+)?Gi$/i, "Use a value like 1Gi or 2Gi").optional(),
    minReplicas: z.number().int().min(1).max(20).optional(),
    maxReplicas: z.number().int().min(1).max(20).optional(),
    storageMountPath: z.string().regex(/^\/[^\0]*$/, "Use an absolute mount path").optional(),
    publicDomain: publicDomainSchema,
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
  })
  .optional();

const CreateProjectSchema = z.object({
  name: z.string().trim().min(1).max(60),
  runtime: runtimeSchema.optional(),
  deploymentProfile: deploymentProfileSchema,
});

export const Route = createFileRoute("/api/connector/projects")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonError(400, "Invalid JSON");
        }

        const parsed = CreateProjectSchema.safeParse(body);
        if (!parsed.success) {
          return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
        }

        const auth = resolveConnectorAuth(request);
        if (!auth.ok) {
          return jsonError(auth.status, auth.error);
        }

        try {
          const project = await createConnectorProject({
            ownerId: auth.ownerId,
            name: parsed.data.name,
            runtime: parsed.data.runtime,
            deploymentProfile: parsed.data.deploymentProfile,
          });

          await logEvent(project.id, auth.ownerId, "info", "connector", "Project created via connector", {
            authMode: auth.authMode,
            runtime: project.runtime,
            deploymentProfile: project.deployment_profile,
          });

          return jsonOk({
            authMode: auth.authMode,
            ownerId: auth.ownerId,
            project,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return jsonError(500, "Project creation failed", message);
        }
      },
    },
  },
});
