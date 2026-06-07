// Client middleware — attaches the AuthSystem access token to every serverFn RPC.
import { createMiddleware } from "@tanstack/react-start";

const ACCESS_TOKEN_KEY = "authsystem:access_token";

function readToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage.getItem(ACCESS_TOKEN_KEY) ?? undefined;
}

export const attachAuthSystemAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    const token = readToken();
    return next({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  },
);
