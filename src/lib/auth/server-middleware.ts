// AuthSystem server middleware — replaces requireSupabaseAuth.
// TODO(security): la firma del JWT NO se verifica todavía. Cuando AuthSystem
// exponga JWKS o un secret HS256 compartido, validar firma + iss + aud aquí.

import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

interface AuthSystemClaims {
  sub: string;
  email?: string;
  name?: string;
  app_id?: string;
  role?: string;
  permissions?: Record<string, string[]>;
  tenant?: { id?: string; name?: string; owner_user_id?: string };
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
}

function decodeJwt(token: string): AuthSystemClaims | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const pad = parts[1].length % 4 === 0 ? 0 : 4 - (parts[1].length % 4);
    const b64 = (parts[1] + "=".repeat(pad)).replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json) as AuthSystemClaims;
  } catch {
    return null;
  }
}

export const requireAuthSystemAuth = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const request = getRequest();
    const authHeader = request?.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      throw new Error("Unauthorized: missing Bearer token");
    }
    const token = authHeader.slice(7).trim();
    if (!token) throw new Error("Unauthorized: empty token");

    const claims = decodeJwt(token);
    if (!claims?.sub) throw new Error("Unauthorized: invalid token payload");

    if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) {
      throw new Error("Unauthorized: token expired");
    }

    return next({
      context: {
        userId: claims.sub,
        email: claims.email ?? null,
        name: claims.name ?? null,
        role: claims.role ?? null,
        permissions: claims.permissions ?? {},
        tenantId: claims.tenant?.id ?? null,
        claims,
      },
    });
  },
);
