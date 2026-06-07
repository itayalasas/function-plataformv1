export const DEFAULT_FN_CODE = `// Función ejemplo — exporta un handler por defecto.
// Firma: (req: Request, ctx: { tokens: Record<string,string>, functionId: string }) => Response
//
// - ctx.tokens contiene los Tokens de la pestaña "Tokens" (hot-reload, sin redeploy).
// - Los Secrets del proyecto están en Deno.env (requieren redeploy para cambiar).

export default async function handler(req, ctx) {
  const url = new URL(req.url);
  const name = url.searchParams.get("name") ?? "mundo";

  return new Response(
    JSON.stringify({
      hello: name,
      hasToken: Boolean(ctx.tokens["API_TOKEN"]),
      at: new Date().toISOString(),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
`;
