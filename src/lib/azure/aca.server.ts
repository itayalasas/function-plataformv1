// Azure Container Apps client — minimal wrapper around ARM REST API.
// Auth via OAuth2 client_credentials. All calls server-side only.

interface TokenCache {
  token: string;
  exp: number;
}
let _tokenCache: TokenCache | undefined;

const API_VERSION = "2024-03-01";

interface AzureEnv {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
  resourceGroup: string;
  environment: string;
  location: string;
  runnerImage: string;
}

const ACA_NAME_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const LOCATION_RE = /^[a-z0-9]+$/;
const DEFAULT_RUNNER_IMAGE = "denoland/deno:alpine-1.46.3";
const IMAGE_REF_RE = /^[a-z0-9]+(?:(?:[._-][a-z0-9]+)+)?(?:\/[a-z0-9]+(?:(?:[._-][a-z0-9]+)+)?)*(?::[A-Za-z0-9_.-]{1,128})?(?:@[A-Za-z][A-Za-z0-9]*:[A-Fa-f0-9]{32,})?$/;

export function sanitizeAcaName(input: string, fallback = "app"): string {
  let s = (input || fallback).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(s)) s = "a" + s;
  if (s.length < 2) s = (s + fallback).slice(0, 32);
  if (s.length > 32) s = s.slice(0, 32);
  s = s.replace(/-+$/g, "") || fallback;
  return s;
}

export function sanitizeLocation(input: string): string {
  // Azure locations are lowercase with no spaces (e.g. "northcentralus")
  return (input || "eastus").toLowerCase().replace(/\s+/g, "");
}

function azureEnv(): AzureEnv {
  const required = {
    tenantId: process.env.AZURE_TENANT_ID,
    clientId: process.env.AZURE_CLIENT_ID,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
    subscriptionId: process.env.AZURE_SUBSCRIPTION_ID,
    resourceGroup: process.env.AZURE_RESOURCE_GROUP,
    environment: process.env.AZURE_ACA_ENVIRONMENT,
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Missing Azure env vars: ${missing.join(", ")}`);

  const rawEnv = required.environment!.trim();
  let environment = sanitizeAcaName(rawEnv, "lovable-fn-env");
  if (!ACA_NAME_RE.test(environment)) {
    // Fallback silencioso a un nombre válido en vez de fallar el deploy
    environment = "lovable-fn-env";
  }

  const location = sanitizeLocation(process.env.AZURE_LOCATION || "eastus");
  if (!LOCATION_RE.test(location)) {
    throw new Error(`AZURE_LOCATION inválido: "${process.env.AZURE_LOCATION}". Usa formato como "northcentralus", "eastus".`);
  }
  const resourceGroup = (required.resourceGroup || "").trim();
  if (!/^[A-Za-z0-9._()-]{1,90}$/.test(resourceGroup)) {
    throw new Error(`AZURE_RESOURCE_GROUP inválido: "${required.resourceGroup}".`);
  }

  const configuredImage = (process.env.FN_RUNNER_IMAGE || "").trim();
  const runnerImage = IMAGE_REF_RE.test(configuredImage) && configuredImage.includes("/")
    ? configuredImage
    : DEFAULT_RUNNER_IMAGE;

  return {
    ...required,
    resourceGroup,
    environment,
    location,
    runnerImage,
  } as AzureEnv;
}


async function getToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (_tokenCache && _tokenCache.exp - 60 > now) return _tokenCache.token;
  const e = azureEnv();
  const form = new URLSearchParams();
  form.set("client_id", e.clientId);
  form.set("client_secret", e.clientSecret);
  form.set("grant_type", "client_credentials");
  form.set("scope", "https://management.azure.com/.default");
  const res = await fetch(`https://login.microsoftonline.com/${e.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!res.ok) throw new Error(`Azure token error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  _tokenCache = { token: data.access_token, exp: now + data.expires_in };
  return data.access_token;
}

function envBase(): string {
  const e = azureEnv();
  return `https://management.azure.com/subscriptions/${e.subscriptionId}/resourceGroups/${e.resourceGroup}`;
}

function envId(): string {
  const e = azureEnv();
  return `/subscriptions/${e.subscriptionId}/resourceGroups/${e.resourceGroup}/providers/Microsoft.App/managedEnvironments/${e.environment}`;
}

async function armFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = await getToken();
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(url, { ...init, headers });
}

// ---------- Auto-provisioning of Resource Group + Managed Environment ----------

let _infraReady = false;

/**
 * Ensure the Resource Group and Container Apps Managed Environment exist.
 * Idempotent and cached per server process.
 */
export async function ensureInfra(): Promise<void> {
  if (_infraReady) return;
  const e = azureEnv();

  // 1. Resource group
  const rgUrl = `https://management.azure.com/subscriptions/${e.subscriptionId}/resourceGroups/${e.resourceGroup}?api-version=2021-04-01`;
  const rgGet = await armFetch(rgUrl);
  if (rgGet.status === 404) {
    const rgPut = await armFetch(rgUrl, {
      method: "PUT",
      body: JSON.stringify({ location: e.location }),
    });
    if (!rgPut.ok) throw new Error(`Create resource group failed: ${rgPut.status} ${await rgPut.text()}`);
  } else if (!rgGet.ok) {
    throw new Error(`Resource group check failed: ${rgGet.status} ${await rgGet.text()}`);
  }

  // 2. Managed Environment
  const envUrl = `${envBase()}/providers/Microsoft.App/managedEnvironments/${e.environment}?api-version=${API_VERSION}`;
  let envGet = await armFetch(envUrl);

  // If exists but in a failed/canceled state, delete it so we can recreate cleanly.
  if (envGet.ok) {
    const data = (await envGet.clone().json()) as { properties?: { provisioningState?: string } };
    const state = data.properties?.provisioningState;
    if (state === "Failed" || state === "Canceled") {
      const del = await armFetch(envUrl, { method: "DELETE" });
      if (!del.ok && del.status !== 404 && del.status !== 202) {
        throw new Error(`Delete failed managed environment error: ${del.status} ${await del.text()}`);
      }
      const delDeadline = Date.now() + 120_000;
      while (Date.now() < delDeadline) {
        await new Promise((r) => setTimeout(r, 3000));
        const check = await armFetch(envUrl);
        if (check.status === 404) break;
      }
      envGet = await armFetch(envUrl);
    }
  }

  if (envGet.status === 404) {
    const envPut = await armFetch(envUrl, {
      method: "PUT",
      body: JSON.stringify({
        location: e.location,
        properties: {
          appLogsConfiguration: { destination: null },
        },
      }),
    });
    if (!envPut.ok) throw new Error(`Create managed environment failed: ${envPut.status} ${await envPut.text()}`);
  } else if (!envGet.ok) {
    throw new Error(`Managed environment check failed: ${envGet.status} ${await envGet.text()}`);
  }

  // Poll until Succeeded (env creation can take 2-5 min on first run).
  let finalState = "Unknown";
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await armFetch(envUrl);
    if (poll.ok) {
      const data = (await poll.json()) as { properties?: { provisioningState?: string } };
      finalState = data.properties?.provisioningState ?? "Unknown";
      if (finalState === "Succeeded") break;
      if (finalState === "Failed" || finalState === "Canceled") {
        throw new Error(`Managed environment provisioning ${finalState}. Borra el environment "${e.environment}" desde el portal de Azure (Resource Group "${e.resourceGroup}") y vuelve a intentar.`);
      }
    }
  }
  if (finalState !== "Succeeded") {
    throw new Error(`Managed environment "${e.environment}" no terminó de provisionarse (estado: ${finalState}). Espera 1-2 minutos y vuelve a intentar.`);
  }

  _infraReady = true;
}


export interface DeployFunctionInput {
  containerAppName: string;
  /** environment variables (non-secret). RUNNER_SCRIPT and FILES_JSON (raw) are auto-converted to *_B64. */
  env: Record<string, string>;
  /** secret values to inject — name => value */
  secrets: Record<string, string>;
  /** allow external ingress */
  external?: boolean;
  /** ports the container listens on (default 8000) */
  targetPort?: number;
  /** override container image (default: env FN_RUNNER_IMAGE / denoland/deno:alpine) */
  image?: string;
  /** override startup shell script. If omitted, the legacy Deno-only script is used. */
  startupScript?: string;
  /** override CPU (default 0.5) */
  cpu?: number;
  /** override memory string (default "1Gi") */
  memory?: string;
  /** override health probe path (default "/__health") */
  healthPath?: string;
  /** override startup probe initialDelaySeconds (default 10) */
  startupInitialDelaySeconds?: number;
  /** override startup probe failureThreshold (default 30) */
  startupFailureThreshold?: number;
  /** override startup probe periodSeconds (default 5) */
  startupPeriodSeconds?: number;
  /** optional callback invoked at each provisioning step (for system logs) */
  log?: (level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void;
}

export interface DeployResult {
  name: string;
  /** Preferred public hostname: custom domain if configured, else default ACA FQDN. */
  fqdn: string | null;
  /** Default Azure-assigned FQDN (*.azurecontainerapps.io). */
  defaultFqdn: string | null;
  /** Custom domain bindings preserved on the Container App, if any. */
  customDomains: string[];
  provisioningState: string;
}

interface AcaCustomDomain {
  name: string;
  bindingType?: string;
  certificateId?: string;
}

interface AcaSecret {
  name: string;
  value?: string;
  keyVaultUrl?: string;
  identity?: string;
}

interface AcaEnvVar {
  name: string;
  value?: string;
  secretRef?: string;
}

function normalizeAcaSecretName(name: string): string {
  return name.toLowerCase();
}

function mergeAcaSecrets(existing: AcaSecret[], incoming: AcaSecret[]): AcaSecret[] {
  const merged = new Map<string, AcaSecret>();
  for (const secret of existing) {
    if (!secret?.name) continue;
    merged.set(normalizeAcaSecretName(secret.name), secret);
  }
  for (const secret of incoming) {
    if (!secret?.name) continue;
    merged.set(normalizeAcaSecretName(secret.name), secret);
  }
  return Array.from(merged.values());
}

function mergeAcaEnvVars(
  existing: AcaEnvVar[],
  incoming: AcaEnvVar[],
  availableSecretNames: Set<string>,
): AcaEnvVar[] {
  const merged = new Map<string, AcaEnvVar>();
  for (const envVar of existing) {
    if (!envVar?.name) continue;
    const hasPlainValue = typeof envVar.value === "string";
    const secretRef = typeof envVar.secretRef === "string" ? envVar.secretRef.trim() : "";
    const hasResolvableSecret = secretRef.length > 0
      && availableSecretNames.has(normalizeAcaSecretName(secretRef));
    if (!hasPlainValue && !hasResolvableSecret) continue;
    merged.set(envVar.name, envVar);
  }
  for (const envVar of incoming) {
    if (!envVar?.name) continue;
    merged.set(envVar.name, envVar);
  }
  return Array.from(merged.values());
}

/**
 * Create or update a Container App. Returns the FQDN once provisioned.
 */
export async function upsertContainerApp(input: DeployFunctionInput): Promise<DeployResult> {
  const log = input.log ?? (() => {});
  const e = azureEnv();
  const url = `${envBase()}/providers/Microsoft.App/containerApps/${input.containerAppName}?api-version=${API_VERSION}`;

  const secretsArr = Object.entries(input.secrets).map(([name, value]) => ({
    name: name.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
    value,
  }));

  // Convert RUNNER_SCRIPT and FILES_JSON to base64 so shell expansion can't corrupt them.
  const envCopy: Record<string, string> = { ...input.env };
  if (envCopy.RUNNER_SCRIPT) {
    if (envCopy.RUNNER_SCRIPT.length < 100) {
      throw new Error(`Runner script inválido (${envCopy.RUNNER_SCRIPT.length} bytes). Cancelo el deploy para evitar crear un contenedor que crashee.`);
    }
    envCopy.RUNNER_SCRIPT_B64 = Buffer.from(envCopy.RUNNER_SCRIPT, "utf-8").toString("base64");
    delete envCopy.RUNNER_SCRIPT;
  }
  if (envCopy.FILES_JSON) {
    envCopy.FILES_B64 = Buffer.from(envCopy.FILES_JSON, "utf-8").toString("base64");
    delete envCopy.FILES_JSON;
  }

  // Force a new revision on every deploy so Azure does not keep serving an older
  // revision when the template content changes.
  const revisionSuffix = sanitizeAcaName(`v${envCopy.DEPLOYMENT_VERSION ?? Date.now()}`, "v");

  const incomingEnvVars = [
    ...Object.entries(envCopy).map(([name, value]) => ({ name, value })),
    ...secretsArr.map((s) => ({ name: s.name.toUpperCase().replace(/-/g, "_"), secretRef: s.name })),
  ];

  // Legacy default startup script (Deno-only) — preserved as fallback when no override is provided.
  const legacyDenoStartup = [
    "set -e",
    'echo "[boot] container starting $(date -u +%FT%TZ)"',
    "mkdir -p /app",
    'if [ -z "$RUNNER_SCRIPT_B64" ]; then echo "[boot][FATAL] RUNNER_SCRIPT_B64 missing"; exit 1; fi',
    'printf "%s" "$RUNNER_SCRIPT_B64" | base64 -d > /app/runner.ts',
    'echo "[boot] runner.ts written: $(wc -c < /app/runner.ts) bytes"',
    'if [ "$(wc -c < /app/runner.ts)" -lt 100 ]; then echo "[boot][FATAL] runner.ts too small"; cat /app/runner.ts; exit 1; fi',
    "cd /app",
    'echo "[boot] launching deno"',
    "exec deno run --allow-net --allow-env --allow-read --allow-write runner.ts",
  ].join("; ");

  const startupScript = input.startupScript ?? legacyDenoStartup;
  const containerImage = input.image ?? e.runnerImage;
  const cpu = input.cpu ?? 0.5;
  const memory = input.memory ?? "1Gi";
  const healthPath = input.healthPath ?? "/__health";
  const targetPort = input.targetPort ?? 8000;
  const startupInitialDelaySeconds = input.startupInitialDelaySeconds ?? 10;
  const startupFailureThreshold = input.startupFailureThreshold ?? 30;
  const startupPeriodSeconds = input.startupPeriodSeconds ?? 5;

  log("info", "Ensuring Azure infra (resource group + managed environment)", { env: e.environment });
  await ensureInfra();
  log("info", "Infra ready", { rg: e.resourceGroup, env: e.environment });

  // Read existing app state before any delete/recreate path so we can preserve
  // custom domains, env vars, and secrets that were configured outside the DB.
  const existing = await getContainerApp(input.containerAppName);
  const preservedCustomDomains: AcaCustomDomain[] = existing?.customDomainsRaw ?? [];
  let preservedSecrets: AcaSecret[] = [];
  if (existing) {
    try {
      preservedSecrets = await listContainerAppSecrets(input.containerAppName);
    } catch (err) {
      log("warn", "Could not read existing Container App secrets; falling back to deploy-time secrets only", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const mergedSecrets = mergeAcaSecrets(preservedSecrets, secretsArr);
  const mergedEnvVars = mergeAcaEnvVars(
    existing?.environmentVariables ?? [],
    incomingEnvVars,
    new Set(mergedSecrets.map((secret) => normalizeAcaSecretName(secret.name))),
  );

  const body = {
    location: e.location,
    properties: {
      managedEnvironmentId: envId(),
      configuration: {
        activeRevisionsMode: "Single",
        ingress: {
          external: input.external ?? false,
          targetPort,
          transport: "auto",
          allowInsecure: false,
          traffic: [{ latestRevision: true, weight: 100 }],
        },
        secrets: mergedSecrets,
      },
      template: {
        revisionSuffix,
        containers: [
          {
            name: "main",
            image: containerImage,
            resources: { cpu, memory },
            env: mergedEnvVars,
            command: ["/bin/sh", "-c"],
            args: [startupScript],
            probes: [
              {
                type: "Startup",
                httpGet: { path: healthPath, port: targetPort },
                initialDelaySeconds: startupInitialDelaySeconds,
                periodSeconds: startupPeriodSeconds,
                failureThreshold: startupFailureThreshold,
                timeoutSeconds: 3,
              },
              {
                type: "Liveness",
                httpGet: { path: healthPath, port: targetPort },
                periodSeconds: 30,
                failureThreshold: 3,
                timeoutSeconds: 3,
              },
            ],
          },
        ],
        scale: { minReplicas: 1, maxReplicas: 3 },
      },
    },
  };

  if (preservedCustomDomains.length) {
    log("info", "Preserving existing custom domains", { domains: preservedCustomDomains.map((d) => d.name) });
    (body.properties.configuration.ingress as Record<string, unknown>).customDomains = preservedCustomDomains;
  }

  // If the container already exists with ingress disabled, Azure may silently ignore
  // the new ingress block on a PUT. Detect this and delete the resource first so the
  // next PUT recreates it cleanly with external ingress enabled.
  if (input.external) {
    if (existing && !existing.defaultFqdn) {
      log("warn", "Existing container app has no FQDN — recreating", { name: input.containerAppName });
      await deleteContainerApp(input.containerAppName);
      const delDeadline = Date.now() + 60_000;
      while (Date.now() < delDeadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const check = await getContainerApp(input.containerAppName);
        if (!check) break;
      }
    }
  }

  log("info", "PUT container app", { name: input.containerAppName, image: containerImage });
  const res = await armFetch(url, { method: "PUT", body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    log("error", `Azure PUT failed ${res.status}`, { body: text.slice(0, 2000) });
    throw new Error(`Azure deploy failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    properties?: {
      provisioningState?: string;
      configuration?: { ingress?: { fqdn?: string; customDomains?: AcaCustomDomain[] } };
    };
  };
  let defaultFqdn = data.properties?.configuration?.ingress?.fqdn ?? null;
  let customDomains = (data.properties?.configuration?.ingress?.customDomains ?? []).map((d) => d.name);
  let state = data.properties?.provisioningState ?? "Unknown";
  log("info", "PUT accepted — polling for FQDN", { state, defaultFqdn, customDomains });

  const deadline = Date.now() + 120_000;
  while ((!defaultFqdn || state === "InProgress" || state === "Creating" || state === "Updating") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    const info = await getContainerApp(input.containerAppName);
    if (!info) break;
    defaultFqdn = info.defaultFqdn;
    customDomains = info.customDomains;
    state = info.provisioningState;
    if (defaultFqdn && (state === "Succeeded" || state === "Unknown")) break;
    if (state === "Failed" || state === "Canceled") {
      log("error", `Azure provisioning ${state}`, { name: input.containerAppName });
      throw new Error(`Azure provisioning ${state.toLowerCase()} for ${input.containerAppName}`);
    }
  }

  if (!defaultFqdn) {
    log("error", "No FQDN assigned after polling", { state });
    throw new Error(`Azure no asignó FQDN público al contenedor "${input.containerAppName}" (estado: ${state}). Verifica en el portal que "Entrada (Ingress)" esté habilitada con tráfico externo; si no, borra el container app desde Azure y vuelve a desplegar.`);
  }

  // Prefer custom domain if configured — that becomes the canonical URL.
  const preferredFqdn = customDomains[0] ?? defaultFqdn;
  log("info", "Container app ready", { preferredFqdn, defaultFqdn, customDomains, state });

  return {
    name: input.containerAppName,
    fqdn: preferredFqdn,
    defaultFqdn,
    customDomains,
    provisioningState: state,
  };
}

export interface ContainerAppInfo {
  /** Preferred hostname (custom domain first, fallback to default ACA FQDN). */
  fqdn: string | null;
  defaultFqdn: string | null;
  customDomains: string[];
  customDomainsRaw: AcaCustomDomain[];
  environmentVariables: AcaEnvVar[];
  provisioningState: string;
}

export async function getContainerApp(name: string): Promise<ContainerAppInfo | null> {
  const url = `${envBase()}/providers/Microsoft.App/containerApps/${name}?api-version=${API_VERSION}`;
  const res = await armFetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Azure get failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    properties?: {
      provisioningState?: string;
      configuration?: { ingress?: { fqdn?: string; customDomains?: AcaCustomDomain[] } };
      template?: { containers?: Array<{ env?: AcaEnvVar[] }> };
    };
  };
  const defaultFqdn = data.properties?.configuration?.ingress?.fqdn ?? null;
  const customDomainsRaw = data.properties?.configuration?.ingress?.customDomains ?? [];
  const customDomains = customDomainsRaw.map((d) => d.name);
  const environmentVariables = data.properties?.template?.containers?.[0]?.env ?? [];
  return {
    fqdn: customDomains[0] ?? defaultFqdn,
    defaultFqdn,
    customDomains,
    customDomainsRaw,
    environmentVariables,
    provisioningState: data.properties?.provisioningState ?? "Unknown",
  };
}

async function listContainerAppSecrets(name: string): Promise<AcaSecret[]> {
  const url = `${envBase()}/providers/Microsoft.App/containerApps/${name}/listSecrets?api-version=${API_VERSION}`;
  const res = await armFetch(url, { method: "POST" });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Azure listSecrets failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { value?: AcaSecret[] };
  return data.value ?? [];
}

export async function deleteContainerApp(name: string): Promise<void> {
  const url = `${envBase()}/providers/Microsoft.App/containerApps/${name}?api-version=${API_VERSION}`;
  const res = await armFetch(url, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Azure delete failed: ${res.status} ${await res.text()}`);
  }
}
