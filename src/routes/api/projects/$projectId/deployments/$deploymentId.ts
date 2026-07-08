import { createFileRoute } from "@tanstack/react-router";

import { getAuthSystemClaimsFromRequest } from "@/lib/auth/server-middleware";
import { getContainerApp } from "@/lib/azure/aca.server";
import { reconcilePublicDomainBinding } from "@/lib/api/deployments.shared";
import { ensureSchema, sql } from "@/lib/neon/db.server";

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
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

export const Route = createFileRoute("/api/projects/$projectId/deployments/$deploymentId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const claims = getAuthSystemClaimsFromRequest(request);
        if (!claims) {
          return jsonError(401, "Unauthorized");
        }

        await ensureSchema();
        const s = sql();
        const rows = (await s`
          SELECT
            id,
            project_id,
            container_app_name,
            version,
            status,
            error,
            runtime,
            progress_percent,
            progress_step,
            progress_message,
            progress_meta,
            created_at,
            updated_at,
            finished_at,
            fqdn
          FROM deployments
          WHERE id = ${params.deploymentId}
            AND project_id = ${params.projectId}
            AND owner_id = ${claims.sub}
          LIMIT 1
        `) as Array<{
          id: string;
          project_id: string;
          container_app_name: string;
          version: number;
          status: string;
          error: string | null;
          runtime: string | null;
          progress_percent: number;
          progress_step: string | null;
          progress_message: string | null;
          progress_meta: unknown;
          created_at: string;
          updated_at: string;
          finished_at: string | null;
          fqdn: string | null;
        }>;

        const deployment = rows[0];
        if (!deployment) {
          return jsonError(404, "Deployment not found");
        }

        const publicDomain = await reconcilePublicDomainBinding({
          projectId: deployment.project_id,
          ownerId: claims.sub,
        });

        const refreshedRows = (await s`
          SELECT
            id,
            project_id,
            container_app_name,
            version,
            status,
            error,
            runtime,
            progress_percent,
            progress_step,
            progress_message,
            progress_meta,
            created_at,
            updated_at,
            finished_at,
            fqdn
          FROM deployments
          WHERE id = ${params.deploymentId}
            AND project_id = ${params.projectId}
            AND owner_id = ${claims.sub}
          LIMIT 1
        `) as typeof rows;
        const currentDeployment = refreshedRows[0] ?? deployment;
        const app = currentDeployment.container_app_name ? await getContainerApp(currentDeployment.container_app_name) : null;

        return jsonOk({
          deploymentId: currentDeployment.id,
          projectId: currentDeployment.project_id,
          containerAppName: currentDeployment.container_app_name,
          version: currentDeployment.version,
          status: currentDeployment.status,
          error: currentDeployment.error,
          runtime: currentDeployment.runtime,
          progressPercent: currentDeployment.progress_percent,
          progressStep: currentDeployment.progress_step,
          progressMessage: currentDeployment.progress_message,
          progressMeta: currentDeployment.progress_meta,
          createdAt: currentDeployment.created_at,
          updatedAt: currentDeployment.updated_at,
          finishedAt: currentDeployment.finished_at,
          fqdn: app?.fqdn ?? currentDeployment.fqdn,
          defaultFqdn: app?.defaultFqdn ?? null,
          provisioningState: app?.provisioningState ?? "Missing",
          runningStatus: app?.runningStatus ?? "Missing",
          customDomains: app?.customDomains ?? [],
          publicHostname: publicDomain?.publicHostname ?? null,
          publicHostnameStatus: publicDomain?.status ?? "none",
          certificateState: publicDomain?.certificateState ?? null,
        });
      },
    },
  },
});
