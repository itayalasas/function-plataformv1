import { createMiddleware } from "@tanstack/react-start";

function readStoredAccessToken(): string | undefined {
  if (typeof window === "undefined") return undefined;

  const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID as string | undefined;
  const candidateKeys = new Set<string>();
  if (projectRef) candidateKeys.add(`sb-${projectRef}-auth-token`);

  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (key?.startsWith("sb-") && key.endsWith("-auth-token")) candidateKeys.add(key);
  }

  for (const key of candidateKeys) {
    const raw = window.localStorage.getItem(key);
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw) as {
        access_token?: string;
        currentSession?: { access_token?: string };
        session?: { access_token?: string };
      };
      const token = parsed.access_token ?? parsed.currentSession?.access_token ?? parsed.session?.access_token;
      if (token) return token;
    } catch {
      // Ignore malformed auth cache entries.
    }
  }

  return undefined;
}

export const attachStoredSupabaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    const token = readStoredAccessToken();
    return next({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  },
);