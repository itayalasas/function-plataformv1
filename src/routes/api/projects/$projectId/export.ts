import { createFileRoute } from "@tanstack/react-router";

import { getAuthSystemClaimsFromRequest } from "@/lib/auth/server-middleware";
import { buildProjectExportArchive } from "@/lib/api/project-export.server";

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export const Route = createFileRoute("/api/projects/$projectId/export")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const claims = getAuthSystemClaimsFromRequest(request);
        if (!claims) {
          return jsonError(401, "Unauthorized");
        }

        const archive = await buildProjectExportArchive({
          projectId: params.projectId,
          ownerId: claims.sub,
        });

        if (!archive) {
          return jsonError(404, "Project not found");
        }

        return new Response(new Uint8Array(archive.bytes), {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${archive.filename}"`,
            "content-length": String(archive.bytes.byteLength),
            "cache-control": "no-store",
          },
        });
      },
    },
  },
});
