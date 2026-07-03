import { createFileRoute } from "@tanstack/react-router";

import { getAuthSystemClaimsFromRequest } from "@/lib/auth/server-middleware";
import { buildVortexInstallerScript } from "@/lib/cli/installer.server";

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export const Route = createFileRoute("/api/cli/installer")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const claims = getAuthSystemClaimsFromRequest(request);
        if (!claims) {
          return jsonError(401, "Unauthorized");
        }

        const { filename, script } = await buildVortexInstallerScript();
        return new Response(script, {
          status: 200,
          headers: {
            "content-type": "application/javascript; charset=utf-8",
            "content-disposition": `attachment; filename="${filename}"`,
            "content-length": String(Buffer.byteLength(script)),
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      },
    },
  },
});
