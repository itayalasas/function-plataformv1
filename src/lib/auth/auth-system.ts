// AuthSystem integration — fetches dynamic config from remote env endpoint,
// builds login/register redirect URLs, and exchanges auth codes for tokens.

const ENV_ENDPOINT = "https://ffihaeatoundrjzgtpzk.supabase.co/functions/v1/get-env";
const ENV_ACCESS_KEY = "d61ec0701398f9f7c148c39f3f8c2ac21aabb83dfa8362c7b69e411191d37227";

const STORAGE_KEYS = {
  config: "authsystem:config",
  access: "authsystem:access_token",
  refresh: "authsystem:refresh_token",
} as const;

export interface AuthSystemConfig {
  VITE_AUTH_API_KEY: string;
  VITE_AUTH_APP_ID: string;
  VITE_AUTH_URL: string;
  VITE_REDIRECT_URI: string;
  AUTH_VALIDA_TOKEN: string;
  API_KEY?: string;
  PLANS_API_URL?: string;
  FUNCTIONS_BASE_URL?: string;
}

export interface AuthSystemUser {
  id: string;
  email: string;
  name?: string;
  roles?: string[];
  permissions?: string[];
  app_id?: string;
  exp?: number;
}

let configPromise: Promise<AuthSystemConfig> | null = null;

export async function loadAuthConfig(force = false): Promise<AuthSystemConfig> {
  if (typeof window === "undefined") {
    throw new Error("loadAuthConfig must run in the browser");
  }
  if (!force) {
    const cached = window.localStorage.getItem(STORAGE_KEYS.config);
    if (cached) {
      try {
        return JSON.parse(cached) as AuthSystemConfig;
      } catch {
        window.localStorage.removeItem(STORAGE_KEYS.config);
      }
    }
    if (configPromise) return configPromise;
  }

  configPromise = (async () => {
    const res = await fetch(ENV_ENDPOINT, {
      method: "GET",
      headers: { "X-Access-Key": ENV_ACCESS_KEY },
    });
    if (!res.ok) throw new Error(`get-env ${res.status}`);
    const body = (await res.json()) as { variables: AuthSystemConfig };
    const cfg = body.variables;
    window.localStorage.setItem(STORAGE_KEYS.config, JSON.stringify(cfg));
    return cfg;
  })();

  try {
    return await configPromise;
  } finally {
    configPromise = null;
  }
}

export function getCachedConfig(): AuthSystemConfig | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEYS.config);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthSystemConfig;
  } catch {
    return null;
  }
}

function buildUrl(kind: "login" | "register", cfg: AuthSystemConfig): string {
  const base = cfg.VITE_AUTH_URL.replace(/\/$/, "");
  const params = new URLSearchParams({
    app_id: cfg.VITE_AUTH_APP_ID,
    redirect_uri: cfg.VITE_REDIRECT_URI,
    api_key: cfg.VITE_AUTH_API_KEY,
  });
  return `${base}/${kind}?${params.toString()}`;
}

export async function redirectToLogin(): Promise<void> {
  const cfg = await loadAuthConfig();
  window.location.href = buildUrl("login", cfg);
}

export async function redirectToRegister(): Promise<void> {
  const cfg = await loadAuthConfig();
  window.location.href = buildUrl("register", cfg);
}

export interface ExchangeResult {
  access_token: string;
  refresh_token: string;
}

export interface ValidateTokenResponse {
  success: boolean;
  data?: {
    valid: boolean;
    token_type?: string;
    expires_at?: string;
    claims?: Record<string, unknown>;
    user?: Record<string, unknown>;
    application?: Record<string, unknown>;
  };
  error?: string;
  message?: string;
}

/**
 * AuthSystem `/login` redirige a /callback?code=<uuid>&state=authenticated.
 * Intercambiamos el `code` por un access token llamando al endpoint
 * auth-exchange-code (AUTH_VALIDA_TOKEN) con { code, application_id }.
 */
export async function exchangeCode(code: string): Promise<ExchangeResult> {
  const cfg = await loadAuthConfig();
  const res = await fetch(cfg.AUTH_VALIDA_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      application_id: cfg.VITE_AUTH_APP_ID,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    access_token?: string;
    refresh_token?: string;
    token?: string;
    data?: { access_token?: string; refresh_token?: string; token?: string };
    error?: string;
    message?: string;
  };
  if (!res.ok) {
    throw new Error(data?.error || data?.message || `exchange ${res.status}`);
  }
  const access =
    data.access_token ?? data.token ?? data.data?.access_token ?? data.data?.token ?? "";
  const refresh = data.refresh_token ?? data.data?.refresh_token ?? "";
  if (!access) {
    throw new Error(data?.error || data?.message || "Respuesta sin access_token");
  }
  const tokens: ExchangeResult = { access_token: access, refresh_token: refresh };
  setTokens(tokens);
  return tokens;
}

export async function validateToken(
  token: string,
  cfg?: AuthSystemConfig,
): Promise<ValidateTokenResponse> {
  const c = cfg ?? (await loadAuthConfig());
  const res = await fetch(c.AUTH_VALIDA_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      application_id: c.VITE_AUTH_APP_ID,
      api_key: c.VITE_AUTH_API_KEY,
    }),
  });
  const data = (await res.json()) as ValidateTokenResponse;
  if (!res.ok) {
    throw new Error(data?.error || data?.message || `validate ${res.status}`);
  }
  return data;
}

export function setTokens(tokens: ExchangeResult) {
  window.localStorage.setItem(STORAGE_KEYS.access, tokens.access_token);
  window.localStorage.setItem(STORAGE_KEYS.refresh, tokens.refresh_token);
}

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(STORAGE_KEYS.access);
}

export function clearTokens() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEYS.access);
  window.localStorage.removeItem(STORAGE_KEYS.refresh);
}

function base64UrlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? 0 : 4 - (input.length % 4);
  const b64 = (input + "=".repeat(pad)).replace(/-/g, "+").replace(/_/g, "/");
  if (typeof atob !== "undefined") return atob(b64);
  // SSR fallback
  return Buffer.from(b64, "base64").toString("binary");
}

export function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const json = decodeURIComponent(
      Array.prototype.map
        .call(base64UrlDecode(parts[1]), (c: string) =>
          "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2),
        )
        .join(""),
    );
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function getUserFromToken(token: string | null): AuthSystemUser | null {
  if (!token) return null;
  const payload = decodeJwt(token);
  if (!payload) return null;
  const exp = typeof payload.exp === "number" ? payload.exp : undefined;
  if (exp && exp * 1000 < Date.now()) return null;
  const sub = String(payload.sub ?? "");
  const email = String(payload.email ?? "");
  if (!sub || !email) return null;
  return {
    id: sub,
    email,
    name: payload.name as string | undefined,
    roles: payload.roles as string[] | undefined,
    permissions: payload.permissions as string[] | undefined,
    app_id: payload.app_id as string | undefined,
    exp,
  };
}
