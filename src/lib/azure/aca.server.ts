// Azure Container Apps client — minimal wrapper around ARM REST API.
// Auth via OAuth2 client_credentials. All calls server-side only.

interface TokenCache {
  token: string;
  exp: number;
}
let _tokenCache: TokenCache | undefined;

const API_VERSION = "2024-03-01";
const LIFECYCLE_API_VERSION = "2026-01-01";
const ENV_STORAGE_API_VERSION = "2026-01-01";
const ENVIRONMENT_API_VERSION = "2026-01-01";
const MANAGED_CERTIFICATE_API_VERSION = "2026-01-01";
const STORAGE_SHARE_API_VERSION = "2026-04-01";

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

export interface DeployProgressState {
  percent: number;
  step: string;
  message: string;
  level?: "info" | "warn" | "error";
  status?: "building" | "provisioning" | "live" | "failed";
  meta?: Record<string, unknown>;
}

export interface AcaCustomDomain {
  name: string;
  bindingType?: string;
  certificateId?: string;
}

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

function normalizeHostname(input: string): string {
  return input.trim().toLowerCase().replace(/\.+$/g, "");
}

function mergeAcaCustomDomains(incoming: AcaCustomDomain[], existing: AcaCustomDomain[]): AcaCustomDomain[] {
  const merged = new Map<string, AcaCustomDomain>();
  for (const domain of incoming) {
    if (!domain?.name) continue;
    merged.set(normalizeHostname(domain.name), domain);
  }
  for (const domain of existing) {
    if (!domain?.name) continue;
    const key = normalizeHostname(domain.name);
    if (!merged.has(key)) {
      merged.set(key, domain);
    }
  }
  return Array.from(merged.values());
}

function environmentResourceUrl(apiVersion = ENVIRONMENT_API_VERSION): string {
  return `${envBase()}/providers/Microsoft.App/managedEnvironments/${azureEnv().environment}?api-version=${apiVersion}`;
}

function managedCertificateResourceUrl(certificateName: string): string {
  const e = azureEnv();
  return `${envBase()}/providers/Microsoft.App/managedEnvironments/${e.environment}/managedCertificates/${encodeURIComponent(certificateName)}?api-version=${MANAGED_CERTIFICATE_API_VERSION}`;
}

function managedCertificateResourceId(certificateName: string): string {
  const e = azureEnv();
  return `/subscriptions/${e.subscriptionId}/resourceGroups/${e.resourceGroup}/providers/Microsoft.App/managedEnvironments/${e.environment}/managedCertificates/${encodeURIComponent(certificateName)}`;
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

interface AzureStorageEnv {
  accountName: string;
  accountKey: string;
  resourceGroup: string;
}

function azureStorageEnv(): AzureStorageEnv {
  const accountName = (process.env.AZURE_STORAGE_ACCOUNT_NAME || "").trim();
  const accountKey = (process.env.AZURE_STORAGE_ACCOUNT_KEY || "").trim();
  const resourceGroup = (process.env.AZURE_STORAGE_RESOURCE_GROUP || process.env.AZURE_RESOURCE_GROUP || "").trim();
  const missing = [
    !accountName ? "AZURE_STORAGE_ACCOUNT_NAME" : "",
    !accountKey ? "AZURE_STORAGE_ACCOUNT_KEY" : "",
    !resourceGroup ? "AZURE_STORAGE_RESOURCE_GROUP / AZURE_RESOURCE_GROUP" : "",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`Missing Azure storage env vars: ${missing.join(", ")}`);
  }
  return { accountName, accountKey, resourceGroup };
}

function sanitizeStorageShareName(input: string, fallback = "data"): string {
  let s = (input || fallback).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9]/.test(s)) s = `a${s}`;
  if (s.length < 3) s = `${s}${fallback}`;
  if (s.length > 63) s = s.slice(0, 63).replace(/-+$/g, "") || fallback;
  return s;
}

async function ensureAzureFileShare(input: {
  accountName: string;
  resourceGroup: string;
  shareName: string;
}): Promise<void> {
  const e = azureEnv();
  const shareUrl =
    `https://management.azure.com/subscriptions/${e.subscriptionId}/resourceGroups/${input.resourceGroup}` +
    `/providers/Microsoft.Storage/storageAccounts/${input.accountName}/fileServices/default/shares/${encodeURIComponent(input.shareName)}` +
    `?api-version=${STORAGE_SHARE_API_VERSION}`;

  const current = await armFetch(shareUrl);
  if (current.ok) return;
  if (current.status !== 404) {
    throw new Error(`Storage share check failed: ${current.status} ${await current.text()}`);
  }

  const created = await armFetch(shareUrl, {
    method: "PUT",
    body: JSON.stringify({
      properties: {
        accessTier: "TransactionOptimized",
      },
    }),
  });
  if (!created.ok) {
    throw new Error(`Create storage share failed: ${created.status} ${await created.text()}`);
  }
}

async function ensureManagedEnvironmentStorage(input: {
  storageName: string;
  shareName: string;
}): Promise<void> {
  const e = azureEnv();
  const storage = azureStorageEnv();
  const storageUrl =
    `https://management.azure.com/subscriptions/${e.subscriptionId}/resourceGroups/${e.resourceGroup}` +
    `/providers/Microsoft.App/managedEnvironments/${e.environment}/storages/${encodeURIComponent(input.storageName)}` +
    `?api-version=${ENV_STORAGE_API_VERSION}`;

  const current = await armFetch(storageUrl);
  if (current.ok) return;
  if (current.status !== 404) {
    throw new Error(`Storage mount check failed: ${current.status} ${await current.text()}`);
  }

  const created = await armFetch(storageUrl, {
    method: "PUT",
    body: JSON.stringify({
      properties: {
        azureFile: {
          accessMode: "ReadWrite",
          accountKey: storage.accountKey,
          accountName: storage.accountName,
          shareName: input.shareName,
        },
      },
    }),
  });
  if (!created.ok) {
    throw new Error(`Create Container Apps storage failed: ${created.status} ${await created.text()}`);
  }
}

export interface PersistentStorageMount {
  storageName: string;
  volumes: Array<{
    name: string;
    storageType: "AzureFile";
    storageName: string;
  }>;
  volumeMounts: Array<{
    volumeName: string;
    mountPath: string;
  }>;
}

export async function ensurePersistentStorageMount(input: {
  projectId: string;
  containerAppName: string;
  mountPath: string;
  log?: (level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void;
}): Promise<PersistentStorageMount> {
  const log = input.log ?? (() => {});
  const mountPath = input.mountPath.trim();
  if (!mountPath) {
    throw new Error("Persistent storage mount path is required");
  }

  await ensureInfra();
  const storage = azureStorageEnv();
  const storageName = sanitizeStorageShareName(`proj-${input.projectId.replace(/-/g, "")}-data`, "data");
  const shareName = storageName;

  log("info", "Ensuring Azure Files share for project storage", {
    storageAccountName: storage.accountName,
    storageResourceGroup: storage.resourceGroup,
    shareName,
  });
  await ensureAzureFileShare({
    accountName: storage.accountName,
    resourceGroup: storage.resourceGroup,
    shareName,
  });

  log("info", "Ensuring Container Apps environment storage", {
    storageName,
    shareName,
  });
  await ensureManagedEnvironmentStorage({
    storageName,
    shareName,
  });

  return {
    storageName,
    volumes: [
      {
        name: "data",
        storageType: "AzureFile",
        storageName,
      },
    ],
    volumeMounts: [
      {
        volumeName: "data",
        mountPath,
      },
    ],
  };
}

async function armFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = await getToken();
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(url, { ...init, headers });
}

function containerAppResourceUrl(name: string, apiVersion = API_VERSION): string {
  return `${envBase()}/providers/Microsoft.App/containerApps/${name}?api-version=${apiVersion}`;
}

function containerAppActionUrl(name: string, action: "start" | "stop", apiVersion = LIFECYCLE_API_VERSION): string {
  return `${envBase()}/providers/Microsoft.App/containerApps/${name}/${action}?api-version=${apiVersion}`;
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

export async function getManagedEnvironmentInfo(): Promise<ManagedEnvironmentInfo | null> {
  await ensureInfra();
  const url = environmentResourceUrl();
  const res = await armFetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Azure managed environment get failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    properties?: {
      provisioningState?: string;
      staticIp?: string | null;
    };
  };
  return {
    staticIp: data.properties?.staticIp ?? null,
    provisioningState: data.properties?.provisioningState ?? "Unknown",
  };
}

export interface ManagedCertificateInfo {
  id: string;
  name: string;
  provisioningState: string;
  subjectName: string;
  pending: boolean;
}

export async function getManagedCertificate(certificateName: string): Promise<ManagedCertificateInfo | null> {
  await ensureInfra();
  const normalizedName = certificateName.trim();
  if (!normalizedName) {
    throw new Error("Managed certificate name is required");
  }
  const url = managedCertificateResourceUrl(normalizedName);
  const res = await armFetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Managed certificate get failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    id?: string;
    name?: string;
    properties?: {
      provisioningState?: string;
      subjectName?: string;
    };
  };
  const provisioningState = data.properties?.provisioningState ?? "Unknown";
  return {
    id: data.id ?? managedCertificateResourceId(normalizedName),
    name: data.name ?? normalizedName,
    provisioningState,
    subjectName: data.properties?.subjectName ?? normalizedName,
    pending: provisioningState !== "Succeeded",
  };
}

export async function createManagedCertificate(input: {
  hostname: string;
  validationMethod: "CNAME" | "HTTP" | "TXT";
  certificateName?: string;
  waitForCompletionMs?: number;
  allowPending?: boolean;
}): Promise<ManagedCertificateInfo> {
  await ensureInfra();
  const hostname = normalizeHostname(input.hostname);
  if (!hostname) {
    throw new Error("Managed certificate hostname is required");
  }

  const certificateName =
    input.certificateName?.trim() ||
    sanitizeAcaName(`cert-${hostname.replace(/\./g, "-")}`, "cert");
  const url = managedCertificateResourceUrl(certificateName);

  const put = await armFetch(url, {
    method: "PUT",
    body: JSON.stringify({
      location: azureEnv().location,
      properties: {
        domainControlValidation: input.validationMethod,
        subjectName: hostname,
      },
    }),
  });
  if (!put.ok) {
    throw new Error(`Create managed certificate failed: ${put.status} ${await put.text()}`);
  }

  const deadline = Date.now() + Math.max(0, input.waitForCompletionMs ?? 120_000);
  const allowPending = input.allowPending ?? false;
  let lastState = "Unknown";
  let lastResponse: {
    id?: string;
    name?: string;
    properties?: {
      provisioningState?: string;
      subjectName?: string;
    };
  } | null = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const poll = await armFetch(url);
    if (poll.status === 404) continue;
    if (!poll.ok) {
      throw new Error(`Managed certificate check failed: ${poll.status} ${await poll.text()}`);
    }
    lastResponse = (await poll.json()) as {
      id?: string;
      name?: string;
      properties?: {
        provisioningState?: string;
        subjectName?: string;
      };
    };
    lastState = lastResponse.properties?.provisioningState ?? "Unknown";
    if (lastState === "Succeeded") {
      return {
        id: lastResponse.id ?? managedCertificateResourceId(certificateName),
        name: lastResponse.name ?? certificateName,
        provisioningState: lastState,
        subjectName: lastResponse.properties?.subjectName ?? hostname,
        pending: false,
      };
    }
    if (lastState === "Failed" || lastState === "Canceled") {
      throw new Error(`Managed certificate provisioning ${lastState.toLowerCase()} for ${hostname}`);
    }
  }

  if (allowPending) {
    return {
      id: lastResponse?.id ?? managedCertificateResourceId(certificateName),
      name: lastResponse?.name ?? certificateName,
      provisioningState: lastState,
      subjectName: lastResponse?.properties?.subjectName ?? hostname,
      pending: true,
    };
  }

  throw new Error(
    `Managed certificate "${certificateName}" no terminó de provisionarse (estado: ${lastState}).`,
  );
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
  /** override minimum replicas (default 1) */
  minReplicas?: number;
  /** override maximum replicas (default 3) */
  maxReplicas?: number;
  /** optional template volumes for the main container */
  volumes?: Array<{
    name: string;
    storageType?: "EmptyDir" | "AzureFile" | "Secret" | "NfsAzureFile";
    storageName?: string;
    mountOptions?: string;
  }>;
  /** optional mounts attached to the main container */
  volumeMounts?: Array<{
    volumeName: string;
    mountPath: string;
    subPath?: string;
  }>;
  /** optional custom domain bindings to attach after certificate issuance */
  customDomains?: AcaCustomDomain[];
  /** optional callback invoked at each provisioning step (for system logs) */
  log?: (level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void;
  /** optional structured progress callback for polling UIs */
  progress?: (update: DeployProgressState) => void | Promise<void>;
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

export interface ManagedEnvironmentInfo {
  staticIp: string | null;
  provisioningState: string;
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
  const reportProgress = async (update: DeployProgressState) => {
    if (!input.progress) return;
    try {
      await Promise.resolve(input.progress(update));
    } catch (error) {
      console.error("[aca.progress] failed", error);
    }
  };
  const e = azureEnv();
  const url = containerAppResourceUrl(input.containerAppName);

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
  await reportProgress({
    percent: 35,
    step: "azure-infra",
    message: "Ensuring Azure infra (resource group + managed environment)",
    status: "provisioning",
    meta: { env: e.environment, resourceGroup: e.resourceGroup },
  });
  await ensureInfra();
  log("info", "Infra ready", { rg: e.resourceGroup, env: e.environment });
  await reportProgress({
    percent: 45,
    step: "azure-infra-ready",
    message: "Infra ready",
    status: "provisioning",
    meta: { rg: e.resourceGroup, env: e.environment },
  });

  // Read existing app state before any delete/recreate path so we can preserve
  // custom domains, env vars, and secrets that were configured outside the DB.
  const existing = await getContainerApp(input.containerAppName);
  const preservedCustomDomains: AcaCustomDomain[] = existing?.customDomainsRaw ?? [];
  const incomingCustomDomains = input.customDomains ?? [];
  const desiredCustomDomainNames = incomingCustomDomains.map((domain) => normalizeHostname(domain.name));
  const mergedCustomDomains =
    incomingCustomDomains.length > 0
      ? mergeAcaCustomDomains(incomingCustomDomains, preservedCustomDomains)
      : preservedCustomDomains;
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
  await reportProgress({
    percent: 55,
    step: "template",
    message: "Preparing Container App template",
    status: "provisioning",
    meta: {
      containerAppName: input.containerAppName,
      secrets: mergedSecrets.length,
      envVars: mergedEnvVars.length,
    },
  });

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
        ...(input.volumes?.length
          ? { volumes: input.volumes }
          : {}),
        containers: [
          {
            name: "main",
            image: containerImage,
            resources: { cpu, memory },
            env: mergedEnvVars,
            ...(input.volumeMounts?.length
              ? { volumeMounts: input.volumeMounts }
              : {}),
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
        scale: {
          minReplicas: input.minReplicas ?? 1,
          maxReplicas: input.maxReplicas ?? 3,
        },
      },
    },
  };

  if (mergedCustomDomains.length) {
    const mode = incomingCustomDomains.length > 0 ? "Applying custom domains" : "Preserving existing custom domains";
    const domainNames = mergedCustomDomains.map((d) => d.name);
    log("info", mode, { domains: domainNames });
    await reportProgress({
      percent: 60,
      step: "custom-domains",
      message: mode,
      status: "provisioning",
      meta: { domains: domainNames },
    });
    (body.properties.configuration.ingress as Record<string, unknown>).customDomains = mergedCustomDomains;
  }

  // If the container already exists with ingress disabled, Azure may silently ignore
  // the new ingress block on a PUT. Detect this and delete the resource first so the
  // next PUT recreates it cleanly with external ingress enabled.
  if (input.external) {
    if (existing && !existing.defaultFqdn) {
      log("warn", "Existing container app has no FQDN — recreating", { name: input.containerAppName });
      await reportProgress({
        percent: 65,
        step: "recreate",
        message: "Recreating Container App to enable external ingress",
        level: "warn",
        status: "provisioning",
        meta: { name: input.containerAppName },
      });
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
  await reportProgress({
    percent: 70,
    step: "put",
    message: "PUT container app",
    status: "provisioning",
    meta: { name: input.containerAppName, image: containerImage },
  });
  const res = await armFetch(url, { method: "PUT", body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    log("error", `Azure PUT failed ${res.status}`, { body: text.slice(0, 2000) });
    await reportProgress({
      percent: 90,
      step: "put-failed",
      message: `Azure PUT failed ${res.status}`,
      level: "error",
      status: "failed",
      meta: { body: text.slice(0, 2000) },
    });
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
  await reportProgress({
    percent: 80,
    step: "polling",
    message: "PUT accepted — polling for FQDN",
    status: "provisioning",
    meta: { state, defaultFqdn, customDomains },
  });

  const deadline = Date.now() + 120_000;
  const wantsCustomDomains = desiredCustomDomainNames.length > 0;
  const hasDesiredCustomDomains = () =>
    !wantsCustomDomains ||
    desiredCustomDomainNames.every((name) => customDomains.some((current) => normalizeHostname(current) === name));
  while (
    (
      !defaultFqdn ||
      state === "InProgress" ||
      state === "Creating" ||
      state === "Updating" ||
      (wantsCustomDomains && !hasDesiredCustomDomains())
    ) &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 2500));
    const info = await getContainerApp(input.containerAppName);
    if (!info) break;
    defaultFqdn = info.defaultFqdn;
    customDomains = info.customDomains;
    state = info.provisioningState;
    await reportProgress({
      percent: defaultFqdn ? 90 : 82,
      step: "polling",
      message: `Azure provisioning ${state}`,
      status: "provisioning",
      meta: { state, defaultFqdn, customDomains },
    });
    if (defaultFqdn && (state === "Succeeded" || state === "Unknown") && hasDesiredCustomDomains()) break;
    if (state === "Failed" || state === "Canceled") {
      log("error", `Azure provisioning ${state}`, { name: input.containerAppName });
      await reportProgress({
        percent: 95,
        step: "failed",
        message: `Azure provisioning ${state}`,
        level: "error",
        status: "failed",
        meta: { name: input.containerAppName, state },
      });
      throw new Error(`Azure provisioning ${state.toLowerCase()} for ${input.containerAppName}`);
    }
  }

  if (!defaultFqdn) {
    log("error", "No FQDN assigned after polling", { state });
    await reportProgress({
      percent: 95,
      step: "no-fqdn",
      message: "No FQDN assigned after polling",
      level: "error",
      status: "failed",
      meta: { state },
    });
    throw new Error(`Azure no asignó FQDN público al contenedor "${input.containerAppName}" (estado: ${state}). Verifica en el portal que "Entrada (Ingress)" esté habilitada con tráfico externo; si no, borra el container app desde Azure y vuelve a desplegar.`);
  }

  // Prefer custom domain if configured — that becomes the canonical URL.
  if (wantsCustomDomains && !hasDesiredCustomDomains()) {
    log("error", "Custom domains were not bound before timeout", {
      requested: desiredCustomDomainNames,
      current: customDomains,
      state,
    });
    await reportProgress({
      percent: 95,
      step: "custom-domain-timeout",
      message: "Custom domains were not bound before timeout",
      level: "error",
      status: "failed",
      meta: {
        requested: desiredCustomDomainNames,
        current: customDomains,
        state,
      },
    });
    throw new Error(
      `Custom domain binding timed out for ${input.containerAppName}. Requested: ${desiredCustomDomainNames.join(", ")}`,
    );
  }
  const hasActiveCustomDomainBinding = mergedCustomDomains.some((domain) => {
    const bindingType = (domain.bindingType ?? "").trim().toLowerCase();
    return Boolean(domain.certificateId) || (bindingType && bindingType !== "disabled");
  });
  const preferredFqdn = hasActiveCustomDomainBinding && wantsCustomDomains
    ? desiredCustomDomainNames.find((name) => customDomains.some((current) => normalizeHostname(current) === name)) ??
      customDomains[0] ??
      defaultFqdn
    : defaultFqdn;
  log("info", "Container app ready", { preferredFqdn, defaultFqdn, customDomains, state });
  await reportProgress({
    percent: 95,
    step: "ready",
    message: "Container app ready",
    status: "provisioning",
    meta: { preferredFqdn, defaultFqdn, customDomains, state },
  });

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
  customDomainVerificationId: string | null;
  customDomains: string[];
  customDomainsRaw: AcaCustomDomain[];
  environmentVariables: AcaEnvVar[];
  provisioningState: string;
  runningStatus: string;
}

export async function getContainerApp(name: string): Promise<ContainerAppInfo | null> {
  const url = containerAppResourceUrl(name);
  const res = await armFetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Azure get failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    properties?: {
      provisioningState?: string;
      runningStatus?: string;
      customDomainVerificationId?: string | null;
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
    customDomainVerificationId: data.properties?.customDomainVerificationId ?? null,
    customDomains,
    customDomainsRaw,
    environmentVariables,
    provisioningState: data.properties?.provisioningState ?? "Unknown",
    runningStatus: data.properties?.runningStatus ?? "Unknown",
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
  const url = containerAppResourceUrl(name);
  const res = await armFetch(url, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Azure delete failed: ${res.status} ${await res.text()}`);
  }
}

async function waitForContainerAppRunningStatus(
  name: string,
  expected: "Running" | "Stopped",
  timeoutMs = 120_000,
): Promise<ContainerAppInfo> {
  const deadline = Date.now() + timeoutMs;
  let lastInfo: ContainerAppInfo | null = null;

  while (Date.now() < deadline) {
    const info = await getContainerApp(name);
    if (!info) throw new Error(`Container App not found: ${name}`);
    lastInfo = info;
    if (info.runningStatus === expected) return info;
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }

  return lastInfo ?? (await getContainerApp(name)) ?? {
    fqdn: null,
    defaultFqdn: null,
    customDomainVerificationId: null,
    customDomains: [],
    customDomainsRaw: [],
    environmentVariables: [],
    provisioningState: "Unknown",
    runningStatus: "Unknown",
  };
}

export async function startContainerApp(name: string): Promise<ContainerAppInfo> {
  const url = containerAppActionUrl(name, "start");
  const res = await armFetch(url, { method: "POST" });
  if (!res.ok && res.status !== 202 && res.status !== 200) {
    throw new Error(`Azure start failed: ${res.status} ${await res.text()}`);
  }
  return waitForContainerAppRunningStatus(name, "Running");
}

export async function stopContainerApp(name: string): Promise<ContainerAppInfo> {
  const url = containerAppActionUrl(name, "stop");
  const res = await armFetch(url, { method: "POST" });
  if (!res.ok && res.status !== 202 && res.status !== 200) {
    throw new Error(`Azure stop failed: ${res.status} ${await res.text()}`);
  }
  return waitForContainerAppRunningStatus(name, "Stopped");
}

export async function restartContainerApp(name: string): Promise<ContainerAppInfo> {
  const current = await getContainerApp(name);
  if (!current) throw new Error(`Container App not found: ${name}`);
  if (current.runningStatus === "Stopped") {
    return startContainerApp(name);
  }
  await stopContainerApp(name);
  return startContainerApp(name);
}
