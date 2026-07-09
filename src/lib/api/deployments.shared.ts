import { sql, ensureSchema, logEvent } from "../neon/db.server.ts";
import { resolveTxt } from "node:dns/promises";
import {
  createManagedCertificate,
  ensurePersistentStorageMount,
  getContainerApp,
  getManagedEnvironmentInfo,
  getManagedCertificate,
  upsertContainerApp,
  sanitizeAcaName,
} from "../azure/aca.server.ts";
import { RUNNER_SOURCE } from "../runner-source.generated.ts";
import { getRuntimeConfig, type RuntimeId } from "../runtimes/index.ts";
import { NODE_RUNNER_SOURCE } from "../runtimes/runner-node.ts";
import { PYTHON_RUNNER_SOURCE } from "../runtimes/runner-python.ts";
import { getRequest } from "@tanstack/react-start/server";

export type DeployProgressLogger = (
  level: "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
) => void;

export type DeploymentProgressUpdate = {
  percent: number;
  step: string;
  message: string;
  level?: "info" | "warn" | "error";
  status?: "building" | "provisioning" | "live" | "failed";
  meta?: Record<string, unknown>;
};

export type DeploymentProgressReporter = (
  update: DeploymentProgressUpdate,
) => void | Promise<void>;

export const DEFAULT_STORAGE_MOUNT_PATH =
  process.env.VORTEX_DEFAULT_STORAGE_MOUNT_PATH?.trim() || "/data";

export interface ProjectDeploymentProfile {
  cpu?: number;
  memory?: string;
  minReplicas?: number;
  maxReplicas?: number;
  storageMountPath?: string | null;
  publicDomain?: ProjectPublicDomainConfig | null;
}

export interface ProjectPublicDomainConfig {
  domain: string;
  subdomain?: string | null;
  ttl?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeProjectDeploymentProfile(raw: unknown): ProjectDeploymentProfile {
  if (!isRecord(raw)) return {};
  const profile: ProjectDeploymentProfile = {};
  const cpu = asNumber(raw.cpu);
  if (cpu !== undefined) profile.cpu = cpu;
  const memory = asString(raw.memory);
  if (memory) profile.memory = memory;
  const minReplicas = asNumber(raw.minReplicas);
  if (minReplicas !== undefined) profile.minReplicas = Math.max(1, Math.floor(minReplicas));
  const maxReplicas = asNumber(raw.maxReplicas);
  if (maxReplicas !== undefined) profile.maxReplicas = Math.max(1, Math.floor(maxReplicas));
  const storageMountPath = asString(raw.storageMountPath);
  if (storageMountPath) profile.storageMountPath = storageMountPath;
  const publicDomain = normalizePublicDomainConfig(
    isRecord(raw.publicDomain) ? (raw.publicDomain as unknown as ProjectPublicDomainConfig) : null,
  );
  if (publicDomain) profile.publicDomain = publicDomain;
  return profile;
}

export function applyDefaultStorageMountPath(
  profile: ProjectDeploymentProfile,
): ProjectDeploymentProfile {
  if (profile.storageMountPath) return profile;
  return { ...profile, storageMountPath: DEFAULT_STORAGE_MOUNT_PATH };
}

function normalizeHostnameLabel(input: string | null | undefined): string | null {
  const raw = input?.trim().toLowerCase().replace(/\.+$/g, "");
  if (!raw) return null;
  return raw;
}

function composePublicHostname(domain: string, subdomain?: string | null): string {
  const normalizedDomain = normalizeHostnameLabel(domain);
  if (!normalizedDomain) {
    throw new Error("Public domain is required");
  }
  const normalizedSubdomain = normalizeHostnameLabel(subdomain);
  return normalizedSubdomain ? `${normalizedSubdomain}.${normalizedDomain}` : normalizedDomain;
}

function buildPublicDomainCertificateName(publicHostname: string): string {
  return sanitizeAcaName(`cert-${publicHostname.replace(/\./g, "-")}`, "cert");
}

type StorageArtifacts = {
  volumes?: Array<{
    name: string;
    storageType?: "EmptyDir" | "AzureFile" | "Secret" | "NfsAzureFile";
    storageName?: string;
    mountOptions?: string;
  }>;
  volumeMounts?: Array<{
    volumeName: string;
    mountPath: string;
    subPath?: string;
  }>;
};

async function resolveStorageArtifacts(input: {
  projectId: string;
  containerAppName: string;
  storageMountPath: string;
  log?: DeployProgressLogger;
}): Promise<StorageArtifacts> {
  if (!input.storageMountPath) return {};
  if (input.storageMountPath === "/data") {
    return {
      volumes: [
        {
          name: "data",
          storageType: "EmptyDir",
        },
      ],
      volumeMounts: [
        {
          volumeName: "data",
          mountPath: input.storageMountPath,
        },
      ],
    };
  }

  const storage = await ensurePersistentStorageMount({
    projectId: input.projectId,
    containerAppName: input.containerAppName,
    mountPath: input.storageMountPath,
    log: input.log ?? (() => {}),
  });
  return {
    volumes: storage.volumes,
    volumeMounts: storage.volumeMounts,
  };
}

export async function reconcilePublicDomainBinding(input: {
  projectId: string;
  ownerId: string;
  progress?: DeploymentProgressReporter;
  log?: DeployProgressLogger;
}): Promise<{
  publicHostname: string | null;
  certificateState: string | null;
  status: "noop" | "pending" | "ready";
  fqdn: string | null;
  defaultFqdn: string | null;
  customDomains: string[];
} | null> {
  try {
    await ensureSchema();
    const s = sql();
    const rows = (await s`
      SELECT id, slug, runtime, container_app_name, fqdn, deployment_profile
      FROM projects
      WHERE id = ${input.projectId} AND owner_id = ${input.ownerId}
      LIMIT 1
    `) as Array<{
      id: string;
      slug: string;
      runtime: string | null;
      container_app_name: string | null;
      fqdn: string | null;
      deployment_profile: unknown;
    }>;
    const project = rows[0];
    if (!project?.container_app_name) return null;

    const deploymentProfile = normalizeProjectDeploymentProfile(project.deployment_profile);
    const publicDomainConfig = deploymentProfile.publicDomain ? normalizePublicDomainConfig(deploymentProfile.publicDomain) : null;
    if (!publicDomainConfig) return null;

    const publicHostname = composePublicHostname(publicDomainConfig.domain, publicDomainConfig.subdomain);
    const runtimeId = (project.runtime ?? "deno") as RuntimeId;
    const runtime = getRuntimeConfig(runtimeId);
    let current = await getContainerApp(project.container_app_name);
    if (!current) {
      return {
        publicHostname,
        certificateState: null,
        status: "noop",
        fqdn: null,
        defaultFqdn: null,
        customDomains: [],
      };
    }

    const currentCustomDomain = current.customDomainsRaw.find(
      (domain) => normalizeHostnameLabel(domain.name) === publicHostname,
    );
    const hasActiveCustomDomain = Boolean(
      currentCustomDomain &&
        (Boolean(currentCustomDomain.certificateId) ||
          ((currentCustomDomain.bindingType ?? "").trim().toLowerCase() !== "disabled")),
    );

    const certificateName = buildPublicDomainCertificateName(publicHostname);
    const certificate = await getManagedCertificate(certificateName) ?? await createManagedCertificate({
      hostname: publicHostname,
      validationMethod: publicDomainConfig.subdomain ? "CNAME" : "HTTP",
      certificateName,
      waitForCompletionMs: 0,
      allowPending: true,
    });

    if (!certificate.pending && !hasActiveCustomDomain) {
      const artifacts = await resolveStorageArtifacts({
        projectId: project.id,
        containerAppName: project.container_app_name,
        storageMountPath: deploymentProfile.storageMountPath?.trim() || "",
        log: input.log,
      });
      const result = await upsertContainerApp({
        containerAppName: project.container_app_name,
        external: true,
        targetPort: runtime.port,
        image: runtime.image,
        startupScript: runtime.startupScript,
        cpu: deploymentProfile.cpu ?? runtime.cpu,
        memory: deploymentProfile.memory ?? runtime.memory,
        minReplicas: deploymentProfile.minReplicas ?? 1,
        maxReplicas: deploymentProfile.maxReplicas ?? 3,
        volumes: artifacts.volumes,
        volumeMounts: artifacts.volumeMounts,
        healthPath: runtime.healthPath,
        startupInitialDelaySeconds: runtime.startupInitialDelaySeconds,
        startupFailureThreshold: runtime.startupFailureThreshold,
        startupPeriodSeconds: runtime.startupPeriodSeconds,
        env: {},
        secrets: {},
        customDomains: [
          {
            name: publicHostname,
            bindingType: "SniEnabled",
            certificateId: certificate.id,
          },
        ],
        log: input.log,
      });
      await s`
        UPDATE projects
        SET fqdn = ${result.fqdn}, last_deployed_at = now()
        WHERE id = ${project.id}
      `;
      await s`
        UPDATE deployments
        SET status = 'live', fqdn = ${result.fqdn}, finished_at = COALESCE(finished_at, now()), updated_at = now()
        WHERE project_id = ${project.id} AND container_app_name = ${project.container_app_name} AND owner_id = ${input.ownerId}
      `;
      await s`
        UPDATE functions
        SET status = 'live', container_app_name = ${project.container_app_name}, fqdn = ${result.fqdn}, updated_at = now()
        WHERE project_id = ${project.id} AND owner_id = ${input.ownerId}
      `;
      return {
        publicHostname,
        certificateState: certificate.provisioningState,
        status: "ready",
        fqdn: result.fqdn,
        defaultFqdn: result.defaultFqdn,
        customDomains: result.customDomains,
      };
    }

    if (!certificate.pending && hasActiveCustomDomain && project.fqdn !== publicHostname) {
      await s`
        UPDATE projects
        SET fqdn = ${publicHostname}, last_deployed_at = now()
        WHERE id = ${project.id}
      `;
      await s`
        UPDATE deployments
        SET status = 'live', fqdn = ${publicHostname}, finished_at = COALESCE(finished_at, now()), updated_at = now()
        WHERE project_id = ${project.id} AND container_app_name = ${project.container_app_name} AND owner_id = ${input.ownerId}
      `;
      await s`
        UPDATE functions
        SET status = 'live', container_app_name = ${project.container_app_name}, fqdn = ${publicHostname}, updated_at = now()
        WHERE project_id = ${project.id} AND owner_id = ${input.ownerId}
      `;
      return {
        publicHostname,
        certificateState: certificate.provisioningState,
        status: "ready",
        fqdn: publicHostname,
        defaultFqdn: current.defaultFqdn,
        customDomains: current.customDomains,
      };
    }

    if (certificate.pending && !currentCustomDomain) {
      const artifacts = await resolveStorageArtifacts({
        projectId: project.id,
        containerAppName: project.container_app_name,
        storageMountPath: deploymentProfile.storageMountPath?.trim() || "",
        log: input.log,
      });
      await upsertContainerApp({
        containerAppName: project.container_app_name,
        external: true,
        targetPort: runtime.port,
        image: runtime.image,
        startupScript: runtime.startupScript,
        cpu: deploymentProfile.cpu ?? runtime.cpu,
        memory: deploymentProfile.memory ?? runtime.memory,
        minReplicas: deploymentProfile.minReplicas ?? 1,
        maxReplicas: deploymentProfile.maxReplicas ?? 3,
        volumes: artifacts.volumes,
        volumeMounts: artifacts.volumeMounts,
        healthPath: runtime.healthPath,
        startupInitialDelaySeconds: runtime.startupInitialDelaySeconds,
        startupFailureThreshold: runtime.startupFailureThreshold,
        startupPeriodSeconds: runtime.startupPeriodSeconds,
        env: {},
        secrets: {},
        customDomains: [
          {
            name: publicHostname,
            bindingType: "Disabled",
          },
        ],
        log: input.log,
      });
      current = (await getContainerApp(project.container_app_name)) ?? current;
    }

    return {
      publicHostname,
      certificateState: certificate.provisioningState,
      status: certificate.pending ? "pending" : hasActiveCustomDomain ? "ready" : "noop",
      fqdn: current.fqdn,
      defaultFqdn: current.defaultFqdn,
      customDomains: current.customDomains,
    };
  } catch (error) {
    input.log?.("warn", "Public domain reconciliation skipped after error", {
      projectId: input.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function normalizePublicDomainConfig(raw?: ProjectPublicDomainConfig | null): ProjectPublicDomainConfig | null {
  if (!raw) return null;
  const domain = normalizeHostnameLabel(raw.domain);
  if (!domain) return null;
  const subdomain = normalizeHostnameLabel(raw.subdomain);
  const ttl = typeof raw.ttl === "number" && Number.isFinite(raw.ttl) ? Math.max(60, Math.floor(raw.ttl)) : 600;
  return { domain, subdomain, ttl };
}

function resolveDnsApiBaseUrl(): string {
  const candidates = [
    process.env.SENDCRAFT_DNS_API_BASE_URL,
    process.env.SENDCRAFT_DNS_API_URL,
  ];
  for (const candidate of candidates) {
    const normalized = candidate?.trim();
    if (!normalized) continue;
    try {
      return new URL(normalized).origin;
    } catch {
      // ignore invalid override and keep falling back
    }
  }
  return "https://api.sendcraft.net";
}

function isRetryableCustomHostnameValidationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /InvalidCustomHostNameValidation|TXT record .* was not found|custom hostname validation/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDnsTxtRecord(input: {
  fqdn: string;
  expectedValue: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 180_000;
  const intervalMs = input.intervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  let lastSeen = "";

  while (Date.now() < deadline) {
    try {
      const records = await resolveTxt(input.fqdn);
      const flattened = records.map((set) => set.join("")).filter(Boolean);
      lastSeen = flattened.join(" | ");
      if (flattened.some((value) => value.trim() === input.expectedValue.trim())) {
        return;
      }
    } catch (error) {
      lastSeen = error instanceof Error ? error.message : String(error);
    }

    await sleep(intervalMs);
  }

  throw new Error(`DNS TXT record ${input.fqdn} was not visible after waiting (${lastSeen || "no response"})`);
}

async function createDnsRecord(input: {
  domain: string;
  subdomain: string;
  type: "A" | "CNAME" | "TXT";
  value: string;
  ttl?: number;
}): Promise<unknown> {
  const url = new URL("/create-subdominios", resolveDnsApiBaseUrl());
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      domain: input.domain,
      subdomain: input.subdomain,
      type: input.type,
      value: input.value,
      ttl: input.ttl ?? 600,
    }),
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    throw new Error(`DNS API error (${response.status}): ${text || "empty response"}`);
  }
  if (parsed && typeof parsed === "object" && "success" in parsed && (parsed as { success?: boolean }).success === false) {
    const result = parsed as { error?: string; details?: string };
    throw new Error(result.details ?? result.error ?? "DNS API reported failure");
  }
  return parsed;
}

function normalizeBaseUrl(input: string | null | undefined): string | null {
  const raw = input?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.endsWith(".local")
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function resolvePlatformBaseUrl(override?: string | null): string | null {
  const candidates = [
    override,
    process.env.VORTEX_PUBLIC_BASE_URL,
    process.env.FUNCTIONS_BASE_URL,
    process.env.PUBLIC_BASE_URL,
    process.env.APP_BASE_URL,
    process.env.SITE_URL,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeBaseUrl(candidate);
    if (normalized) return normalized;
  }

  try {
    const request = getRequest();
    if (request) {
      return normalizeBaseUrl(request.headers.get("origin")) ?? normalizeBaseUrl(request.url);
    }
  } catch {
    // No active request context.
  }

  return null;
}

function createRuntimeLogToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

function buildLoggedDenoRunnerSource(source: string): string {
  if (source.includes("const LOG_INGEST_URL = Deno.env.get(\"VORTEX_LOG_INGEST_URL\") ?? \"\";")) {
    return source;
  }

  const helperBlock = [
    'const LOG_INGEST_URL = Deno.env.get("VORTEX_LOG_INGEST_URL") ?? "";',
    'const LOG_TOKEN = Deno.env.get("VORTEX_LOG_TOKEN") ?? "";',
    '',
    'function redactHeaders(headers: Headers): Record<string, string> {',
    '  const out: Record<string, string> = {};',
    '  for (const [key, value] of headers.entries()) {',
    '    if (/^(authorization|x-api-key|x-admin-token)$/i.test(key)) {',
    '      out[key] = "[redacted]";',
    '      continue;',
    '    }',
    '    out[key] = value;',
    '  }',
    '  return out;',
    '}',
    '',
    'function trimLogText(value: string, limit = 8000): string {',
    '  if (value.length <= limit) return value;',
    '  return value.slice(0, limit) + "... [truncated " + String(value.length - limit) + " chars]";',
    '}',
    '',
    'async function persistInvocationLog(entry: {',
    '  level: "info" | "warn" | "error";',
    '  source: string;',
    '  message: string;',
    '  meta: Record<string, unknown>;',
    '}): Promise<void> {',
    '  if (!LOG_INGEST_URL || !LOG_TOKEN) return;',
    '  try {',
    '    await fetch(LOG_INGEST_URL, {',
    '      method: "POST",',
    '      headers: {',
    '        "content-type": "application/json",',
    '        "x-vortex-log-token": LOG_TOKEN,',
    '      },',
    '      body: JSON.stringify({',
    '        projectId: PROJECT_ID,',
    '        token: LOG_TOKEN,',
    '        level: entry.level,',
    '        source: entry.source,',
    '        message: entry.message,',
    '        meta: entry.meta,',
    '      }),',
    '    });',
    '  } catch (err) {',
    '    console.error("[runner] failed to send runtime log:", err);',
    '  }',
    '}',
    '',
    'const sendRuntimeLog = persistInvocationLog;',
  ].join("\n");

  source = source.replace(
    'const tokenEnvOriginals = new Map<string, string | undefined>();\n\nfunction tokenEnvAliases(name: string): string[] {',
    `const tokenEnvOriginals = new Map<string, string | undefined>();\n${helperBlock}\n\nfunction tokenEnvAliases(name: string): string[] {`,
  );

  source = source.replace(
    '  const projectSecrets = await loadProjectSecrets();\n  const tokens = await loadTokens(fn.id);\n  applyProjectSecretsEnv(projectSecrets);\n  applyTokenEnv(tokens);\n  try {\n    const res = await fn.handler(innerReq, { tokens, functionId: fn.id });\n    return withCors(res, origin);\n  } catch (err) {\n    console.error(`[runner] ${slug} threw:`, err);\n    return withCors(new Response(\n      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),\n      { status: 500, headers: { "content-type": "application/json" } },\n    ), origin);\n  }',
    [
      '  const startedAt = Date.now();',
      '  const requestPath = innerUrl.pathname + innerUrl.search;',
      '  const requestHeaders = redactHeaders(innerReq.headers);',
      '  const requestBody = ["GET", "HEAD"].includes(innerReq.method) ? "" : await innerReq.clone().text();',
      '  const projectSecrets = await loadProjectSecrets();',
      '  const tokens = await loadTokens(fn.id);',
      '  applyProjectSecretsEnv(projectSecrets);',
      '  applyTokenEnv(tokens);',
      '  try {',
      '    const response = withCors(await fn.handler(innerReq, { tokens, functionId: fn.id }), origin);',
      '    let responseBody = "";',
      '    try {',
      '      responseBody = trimLogText(await response.clone().text());',
      '    } catch {',
      '      responseBody = "[unreadable]";',
      '    }',
      '    const duration = Date.now() - startedAt;',
      '    await persistInvocationLog({',
      '      level: response.status >= 400 ? "warn" : "info",',
      '      source: "runtime",',
    '      message: "-> " + innerReq.method + " " + requestPath + " | <- " + response.status + " (" + duration + "ms)",',
      '      meta: {',
      '        runtime: "deno",',
      '        function: slug,',
      '        functionId: fn.id,',
      '        request: {',
      '          method: innerReq.method,',
      '          path: requestPath,',
      '          headers: requestHeaders,',
      '          body: requestBody ? trimLogText(requestBody) : null,',
      '          query: Object.fromEntries(innerUrl.searchParams.entries()),',
      '        },',
      '        response: {',
      '          status: response.status,',
      '          headers: redactHeaders(response.headers),',
      '          body: responseBody,',
      '        },',
      '        durationMs: duration,',
      '      },',
      '    });',
      '    return response;',
      '  } catch (err) {',
      '    const duration = Date.now() - startedAt;',
      '    const errorMessage = err instanceof Error ? err.message : String(err);',
      '    await persistInvocationLog({',
      '      level: "error",',
      '      source: "runtime",',
    '      message: "-> " + innerReq.method + " " + requestPath + " | <- ERR (" + duration + "ms)",',
      '      meta: {',
      '        runtime: "deno",',
      '        function: slug,',
      '        functionId: fn.id,',
      '        request: {',
      '          method: innerReq.method,',
      '          path: requestPath,',
      '          headers: requestHeaders,',
      '          body: requestBody ? trimLogText(requestBody) : null,',
      '          query: Object.fromEntries(innerUrl.searchParams.entries()),',
      '        },',
      '        response: {',
      '          status: 500,',
      '          headers: { "content-type": "application/json" },',
      '          body: JSON.stringify({ error: errorMessage }),',
      '        },',
      '        error: errorMessage,',
      '        durationMs: duration,',
      '      },',
      '    });',
      '    console.error(`[runner] ${slug} threw:`, err);',
      '    return withCors(new Response(',
      '      JSON.stringify({ error: errorMessage }),',
      '      { status: 500, headers: { "content-type": "application/json" } },',
      '    ), origin);',
      '  }',
    ].join("\n"),
  );

  return source;
}

function getRunnerScript(runtime: RuntimeId): string {
  switch (runtime) {
    case "deno":
      if (RUNNER_SOURCE && RUNNER_SOURCE.length > 100) return buildLoggedDenoRunnerSource(RUNNER_SOURCE);
      return "console.error('runner/main.ts missing'); Deno.exit(1);";
    case "node":
      return NODE_RUNNER_SOURCE;
    case "python":
      return PYTHON_RUNNER_SOURCE;
    case "java":
    case "dotnet":
      // Compiled runtimes don't use a JS/TS runner — the user's source IS the app.
      // Return a non-empty placeholder so aca.server.ts doesn't reject it.
      return "# build-at-boot runtime — no runner script needed".padEnd(120, " ");
  }
}

export interface DeployProjectResult {
  ok: true;
  deploymentId: string;
  fqdn: string | null;
  defaultFqdn: string | null;
  customDomains: string[];
  version: number;
  runtime: string;
  publicHostname: string | null;
  publicHostnameStatus: "none" | "pending" | "ready";
  certificateState: string | null;
}

/**
 * Deploy a project by ID using the same logic as the UI.
 * The caller must already have access to the project ownerId.
 */
export async function deployProjectById({
  projectId,
  ownerId,
  platformBaseUrl,
  publicDomain,
  progress,
  progressReporter,
}: {
  projectId: string;
  ownerId: string;
  platformBaseUrl?: string | null;
  publicDomain?: ProjectPublicDomainConfig | null;
  progress?: DeployProgressLogger;
  progressReporter?: DeploymentProgressReporter;
}): Promise<DeployProjectResult> {
  await ensureSchema();
  const s = sql();
  const projs =
    (await s`SELECT id, slug, admin_token, log_token, runtime, deployment_profile FROM projects WHERE id = ${projectId} AND owner_id = ${ownerId}`) as Array<{
      id: string;
      slug: string;
      admin_token: string | null;
      log_token: string | null;
      runtime: string | null;
      deployment_profile: unknown;
    }>;
  if (!projs[0]) throw new Error("Project not found");
  const proj = projs[0];
  const runtimeId = (proj.runtime ?? "deno") as RuntimeId;
  const runtime = getRuntimeConfig(runtimeId);
  const deploymentProfile = normalizeProjectDeploymentProfile(proj.deployment_profile);
  const cpu = deploymentProfile.cpu ?? runtime.cpu;
  const memory = deploymentProfile.memory ?? runtime.memory;
  const minReplicas = deploymentProfile.minReplicas ?? 1;
  const maxReplicas = deploymentProfile.maxReplicas ?? 3;
  const storageMountPath = deploymentProfile.storageMountPath?.trim() || "";
  const emitDeployLog: DeployProgressLogger = (level, message, meta) => {
    progress?.(level, message, meta);
    void logEvent(proj.id, ownerId, level, "azure", message, meta);
  };
  const publicDomainConfig = normalizePublicDomainConfig(publicDomain ?? deploymentProfile.publicDomain ?? null);
  const publicHostname = publicDomainConfig
    ? composePublicHostname(publicDomainConfig.domain, publicDomainConfig.subdomain)
    : null;
  progress?.("info", "Preparando deploy del proyecto", {
    projectId: proj.id,
    runtime: runtimeId,
    projectSlug: proj.slug,
    cpu,
    memory,
    minReplicas,
    maxReplicas,
    storageMountPath: storageMountPath || null,
    publicHostname,
  });
  await persistProgress({
    percent: 5,
    step: "queued",
    message: "Preparando deploy del proyecto",
    status: "building",
    meta: {
      projectId: proj.id,
      runtime: runtimeId,
      projectSlug: proj.slug,
      cpu,
      memory,
      minReplicas,
      maxReplicas,
      storageMountPath: storageMountPath || null,
      publicHostname,
    },
  });

  // Generate / reuse a per-project admin token (used for /__validate)
  let adminToken = proj.admin_token;
  if (!adminToken) {
    adminToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    await s`UPDATE projects SET admin_token = ${adminToken} WHERE id = ${proj.id}`;
  }

  let logToken = proj.log_token ?? "";
  if (!logToken) {
    logToken = createRuntimeLogToken();
    await s`UPDATE projects SET log_token = ${logToken} WHERE id = ${proj.id}`;
  }

  const platformOrigin = resolvePlatformBaseUrl(platformBaseUrl);
  const runtimeLogIngestUrl = platformOrigin ? new URL("/api/runtime-logs", platformOrigin).toString() : "";
  if (!runtimeLogIngestUrl) {
    progress?.("warn", "Runtime logs disabled: missing platform base URL", {
      projectId: proj.id,
      runtime: runtimeId,
    });
    await persistProgress({
      percent: 10,
      step: "platform-url-missing",
      message: "Runtime logs disabled: missing platform base URL",
      level: "warn",
      status: "building",
      meta: {
        projectId: proj.id,
        runtime: runtimeId,
      },
    });
  }

  const secretRows =
    (await s`SELECT name, value FROM secrets WHERE project_id = ${proj.id} AND owner_id = ${ownerId}`) as Array<{
      name: string;
      value: string;
    }>;
  const secrets: Record<string, string> = {};
  for (const r of secretRows) secrets[r.name] = r.value;
  const apiKeyValues: string[] = [];
  if (runtimeId !== "deno") {
    const tokenRows = (await s`
      SELECT ft.name, ft.value
      FROM function_tokens ft
      JOIN functions f ON f.id = ft.function_id
      WHERE f.project_id = ${proj.id} AND ft.owner_id = ${ownerId}
      ORDER BY f.slug ASC, ft.name ASC
    `) as Array<{
      name: string;
      value: string;
    }>;
    apiKeyValues.push(...tokenRows.map((r) => r.value).filter(Boolean));
  }

  const verRows =
    (await s`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM deployments WHERE project_id = ${proj.id}`) as Array<{
      v: number;
    }>;
  const version = verRows[0].v;
  const containerAppName = sanitizeAcaName(`proj-${proj.slug}-${proj.id.slice(0, 6)}`, "proj");
  const depRows =
    (await s`INSERT INTO deployments (project_id, owner_id, version, container_app_name, status, runtime) VALUES (${proj.id}, ${ownerId}, ${version}, ${containerAppName}, 'provisioning', ${runtimeId}) RETURNING id`) as Array<{
      id: string;
    }>;
  const deploymentId = depRows[0].id;
  const useEphemeralDefaultStorage = storageMountPath === "/data";
  const usePersistentStorage = Boolean(storageMountPath && !useEphemeralDefaultStorage);
  let volumes:
    | Array<{
        name: string;
        storageType?: "EmptyDir" | "AzureFile" | "Secret" | "NfsAzureFile";
        storageName?: string;
        mountOptions?: string;
      }>
    | undefined;
  let volumeMounts:
    | Array<{
        volumeName: string;
        mountPath: string;
        subPath?: string;
      }>
    | undefined;
  if (storageMountPath) {
    if (useEphemeralDefaultStorage) {
      emitDeployLog("info", "Using ephemeral default /data mount", {
        projectId: proj.id,
        runtime: runtimeId,
        projectSlug: proj.slug,
        storageMountPath,
      });
      await persistProgress({
        percent: 30,
        step: "storage-ephemeral",
        message: "Using ephemeral /data mount",
        status: "building",
        meta: {
          projectId: proj.id,
          runtime: runtimeId,
          projectSlug: proj.slug,
          storageMountPath,
        },
      });
      volumes = [
        {
          name: "data",
          storageType: "EmptyDir",
        },
      ];
      volumeMounts = [
        {
          volumeName: "data",
          mountPath: storageMountPath,
        },
      ];
    } else if (usePersistentStorage) {
      emitDeployLog("info", "Provisioning persistent project storage", {
        projectId: proj.id,
        runtime: runtimeId,
        projectSlug: proj.slug,
        storageMountPath,
      });
      await persistProgress({
        percent: 30,
        step: "storage",
        message: "Provisioning persistent project storage",
        status: "building",
        meta: {
          projectId: proj.id,
          runtime: runtimeId,
          projectSlug: proj.slug,
          storageMountPath,
        },
      });
      const storage = await ensurePersistentStorageMount({
        projectId: proj.id,
        containerAppName,
        mountPath: storageMountPath,
        log: emitDeployLog,
      });
      volumes = storage.volumes;
      volumeMounts = storage.volumeMounts;
      await persistProgress({
        percent: 32,
        step: "storage-ready",
        message: "Persistent project storage ready",
        status: "building",
        meta: {
          projectId: proj.id,
          runtime: runtimeId,
          projectSlug: proj.slug,
          storageMountPath,
          storageName: storage.storageName,
        },
      });
    }
  }

  async function persistProgress(update: DeploymentProgressUpdate): Promise<void> {
    try {
      const percent = Math.max(0, Math.min(100, Math.round(update.percent)));
      const status =
        update.status ??
        (update.level === "error" ? "failed" : percent >= 100 ? "live" : percent >= 25 ? "provisioning" : "building");
      const progressMeta = {
        ...(update.meta ?? {}),
        progressPercent: percent,
        progressStep: update.step,
        progressStatus: status,
        progressMessage: update.message,
      };
      await s`
        UPDATE deployments
        SET
          status = ${status},
          progress_percent = ${percent},
          progress_step = ${update.step},
          progress_message = ${update.message},
          progress_meta = ${JSON.stringify(progressMeta)}::jsonb,
          updated_at = now()
        WHERE id = ${deploymentId}
      `;
      if (status === "live" || status === "failed") {
        await s`UPDATE deployments SET finished_at = now(), updated_at = now() WHERE id = ${deploymentId}`;
      }
      if (progressReporter) {
        await progressReporter({
          ...update,
          status,
          meta: progressMeta,
        });
      }
    } catch (error) {
      console.error("[deployProgress] failed", error);
    }
  }

  const runnerScript = getRunnerScript(runtimeId);

  // For non-Deno runtimes, bundle ALL function files for this project into FILES_JSON.
  // Format: [{ slug, entrypoint, path, content, kind }, ...]
  let filesJson = "";
  if (runtimeId !== "deno") {
    const fnRows = (await s`
      SELECT f.slug, f.entrypoint, ff.path, ff.content, ff.kind
      FROM function_files ff
      JOIN functions f ON f.id = ff.function_id
      WHERE f.project_id = ${proj.id} AND ff.owner_id = ${ownerId}
      ORDER BY f.slug ASC, ff.path ASC
    `) as Array<{
      slug: string;
      entrypoint: string;
      path: string;
      content: string;
      kind: string;
    }>;
    filesJson = JSON.stringify(fnRows);
  }

  await logEvent(
    proj.id,
    ownerId,
    "info",
    "deploy",
    `Iniciando deploy v${version} (runtime: ${runtimeId})`,
    {
      containerAppName,
      runtime: runtimeId,
      runnerBytes: runnerScript.length,
      fileBytes: filesJson.length,
    },
  );
  progress?.("info", `Iniciando deploy v${version}`, {
    containerAppName,
    runtime: runtimeId,
    version,
    publicHostname,
  });
  await persistProgress({
    percent: 20,
    step: "preparing",
    message: `Iniciando deploy v${version}`,
    status: "building",
    meta: {
      containerAppName,
      runtime: runtimeId,
      version,
    },
  });

  try {
    const neonUrl = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
    if (!neonUrl) {
      throw new Error("Missing NEON_DATABASE_URL / DATABASE_URL");
    }
    const baseEnv: Record<string, string> = {
      NEON_URL: neonUrl,
      PROJECT_ID: proj.id,
      VORTEX_OWNER_ID: ownerId,
      ADMIN_TOKEN: adminToken,
      DEPLOYMENT_VERSION: String(version),
      RUNTIME: runtimeId,
      PORT: String(runtime.port),
    };
    if (runtimeLogIngestUrl) {
      baseEnv.VORTEX_LOG_INGEST_URL = runtimeLogIngestUrl;
    }
    baseEnv.VORTEX_LOG_TOKEN = logToken;
    if (apiKeyValues.length) {
      baseEnv.API_KEY = apiKeyValues.join(",");
    }
    if (runtimeId === "deno" || runtimeId === "node" || runtimeId === "python") {
      baseEnv.RUNNER_SCRIPT = runnerScript;
    }
    if (filesJson) {
      baseEnv.FILES_JSON = filesJson;
    }

    const publicDomainInitialBinding = publicHostname
      ? [
          {
            name: publicHostname,
            bindingType: "Disabled",
          },
        ]
      : undefined;

    let result = await upsertContainerApp({
      containerAppName,
      external: true,
      targetPort: runtime.port,
      image: runtime.image,
      startupScript: runtime.startupScript,
      cpu,
      memory,
      minReplicas,
      maxReplicas,
      volumes,
      volumeMounts,
      healthPath: runtime.healthPath,
      startupInitialDelaySeconds: runtime.startupInitialDelaySeconds,
      startupFailureThreshold: runtime.startupFailureThreshold,
      startupPeriodSeconds: runtime.startupPeriodSeconds,
      env: baseEnv,
      secrets,
      progress: persistProgress,
      log: emitDeployLog,
    });

    let certificateState: string | null = null;
    let certificatePending = false;

    if (publicDomainConfig && publicHostname) {
      let verificationId = "";
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const verificationInfo = await getContainerApp(containerAppName);
        verificationId = verificationInfo?.customDomainVerificationId?.trim() || "";
        if (verificationId) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (!verificationId) {
        throw new Error(`Missing customDomainVerificationId for ${containerAppName}`);
      }

      const environmentInfo = await getManagedEnvironmentInfo();
      if (!environmentInfo?.staticIp) {
        throw new Error("Azure managed environment static IP is not available");
      }

      const recordType = publicDomainConfig.subdomain ? "CNAME" : "A";
      const dnsTarget = recordType === "CNAME" ? result.defaultFqdn ?? result.fqdn : environmentInfo.staticIp;
      if (!dnsTarget) {
        throw new Error(`Unable to resolve DNS target for ${publicHostname}`);
      }

      const hostRecordName = publicDomainConfig.subdomain ?? "@";
      const verificationRecordName = publicDomainConfig.subdomain ? `asuid.${publicDomainConfig.subdomain}` : "asuid";

      emitDeployLog("info", "Publishing public domain DNS records", {
        containerAppName,
        publicHostname,
        hostRecordName,
        verificationRecordName,
        recordType,
        dnsTarget,
      });
      await persistProgress({
        percent: 96,
        step: "dns-host",
        message: "Creando registro DNS del dominio",
        status: "provisioning",
        meta: {
          containerAppName,
          publicHostname,
          hostRecordName,
          verificationRecordName,
          recordType,
          dnsTarget,
        },
      });
      await createDnsRecord({
        domain: publicDomainConfig.domain,
        subdomain: hostRecordName,
        type: recordType,
        value: dnsTarget,
        ttl: publicDomainConfig.ttl,
      });

      await persistProgress({
        percent: 97,
        step: "dns-verification",
        message: "Creando TXT de verificación",
        status: "provisioning",
        meta: {
          containerAppName,
          publicHostname,
          verificationRecordName,
          verificationId,
        },
      });
      await createDnsRecord({
        domain: publicDomainConfig.domain,
        subdomain: verificationRecordName,
        type: "TXT",
        value: verificationId,
        ttl: publicDomainConfig.ttl,
      });

      await persistProgress({
        percent: 98,
        step: "dns-propagation",
        message: "Esperando propagación DNS antes del certificado",
        status: "provisioning",
        meta: {
          containerAppName,
          publicHostname,
          verificationRecordName,
          dnsTarget,
        },
      });
      await waitForDnsTxtRecord({
        fqdn: `${verificationRecordName}.${publicDomainConfig.domain}`,
        expectedValue: verificationId,
        timeoutMs: 180_000,
        intervalMs: 5_000,
      });

      emitDeployLog("info", "Registering custom hostname before certificate", {
        containerAppName,
        publicHostname,
      });
      await persistProgress({
        percent: 98,
        step: "hostname",
        message: "Registrando hostname personalizado",
        status: "provisioning",
        meta: {
          containerAppName,
          publicHostname,
        },
      });
      try {
        result = await upsertContainerApp({
          containerAppName,
          external: true,
          targetPort: runtime.port,
          image: runtime.image,
          startupScript: runtime.startupScript,
          cpu,
          memory,
          minReplicas,
          maxReplicas,
          volumes,
          volumeMounts,
          healthPath: runtime.healthPath,
          startupInitialDelaySeconds: runtime.startupInitialDelaySeconds,
          startupFailureThreshold: runtime.startupFailureThreshold,
          startupPeriodSeconds: runtime.startupPeriodSeconds,
          env: baseEnv,
          secrets,
          customDomains: publicDomainInitialBinding,
          log: emitDeployLog,
        });
      } catch (error) {
        if (!isRetryableCustomHostnameValidationError(error)) {
          throw error;
        }
        certificatePending = true;
        certificateState = "Pending";
        emitDeployLog("warn", "Hostname registration still propagating; will keep deployment pending", {
          containerAppName,
          publicHostname,
          error: error instanceof Error ? error.message : String(error),
        });
        await persistProgress({
          percent: 98,
          step: "hostname-pending",
          message: "El hostname personalizado todavía está propagando; se reintentará automáticamente",
          status: "provisioning",
          meta: {
            containerAppName,
            publicHostname,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }

      if (!certificatePending) {
        const validationMethod = recordType === "CNAME" ? "CNAME" : "HTTP";
        const certificateName = buildPublicDomainCertificateName(publicHostname);
        emitDeployLog("info", "Creating managed certificate", {
          containerAppName,
          publicHostname,
          certificateName,
          validationMethod,
        });
        await persistProgress({
          percent: 99,
          step: "certificate",
          message: "Generando certificado administrado",
          status: "provisioning",
          meta: {
            containerAppName,
            publicHostname,
            certificateName,
            validationMethod,
          },
        });
        try {
          const certificate = await createManagedCertificate({
            hostname: publicHostname,
            validationMethod,
            certificateName,
            waitForCompletionMs: 180_000,
            allowPending: true,
          });
          certificateState = certificate.provisioningState;

          if (certificate.pending) {
            certificatePending = true;
            emitDeployLog("warn", "Managed certificate still provisioning; will bind automatically later", {
              containerAppName,
              publicHostname,
              certificateName,
              certificateState: certificate.provisioningState,
            });
            await persistProgress({
              percent: 99,
              step: "certificate-pending",
              message: "Certificado pendiente de aprovisionamiento; se enlazara automaticamente cuando Azure lo termine",
              status: "provisioning",
              meta: {
                containerAppName,
                publicHostname,
                certificateId: certificate.id,
                certificateState: certificate.provisioningState,
              },
            });
          } else {
            certificatePending = false;
            await persistProgress({
              percent: 99,
              step: "binding",
              message: "Asociando dominio al contenedor",
              status: "provisioning",
              meta: {
                containerAppName,
                publicHostname,
                certificateId: certificate.id,
              },
            });
            result = await upsertContainerApp({
              containerAppName,
              external: true,
              targetPort: runtime.port,
              image: runtime.image,
              startupScript: runtime.startupScript,
              cpu,
              memory,
              minReplicas,
              maxReplicas,
              volumes,
              volumeMounts,
              healthPath: runtime.healthPath,
              startupInitialDelaySeconds: runtime.startupInitialDelaySeconds,
              startupFailureThreshold: runtime.startupFailureThreshold,
              startupPeriodSeconds: runtime.startupPeriodSeconds,
              env: baseEnv,
              secrets,
              customDomains: [
                {
                  name: publicHostname,
                  bindingType: "SniEnabled",
                  certificateId: certificate.id,
                },
              ],
              log: emitDeployLog,
            });
            await persistProgress({
              percent: 99,
              step: "domain-ready",
              message: "Dominio personalizado listo",
              status: "provisioning",
              meta: {
                containerAppName,
                publicHostname,
                fqdn: result.fqdn,
                defaultFqdn: result.defaultFqdn,
                customDomains: result.customDomains,
              },
            });
          }
        } catch (error) {
          if (!isRetryableCustomHostnameValidationError(error)) {
            throw error;
          }

          certificatePending = true;
          certificateState = "Pending";
          emitDeployLog("warn", "Managed certificate validation still not visible; will continue provisioning and retry later", {
            containerAppName,
            publicHostname,
            error: error instanceof Error ? error.message : String(error),
          });
          await persistProgress({
            percent: 99,
            step: "certificate-pending",
            message: "Validación del certificado aún no está visible; se reintentará automáticamente",
            status: "provisioning",
            meta: {
              containerAppName,
              publicHostname,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    }

    const hasCustomHostname = Boolean(publicDomainConfig && publicHostname);
    const customDomainReady = Boolean(
      hasCustomHostname &&
        result.fqdn === publicHostname &&
        result.customDomains.some((domain) => normalizeHostnameLabel(domain) === publicHostname),
    );
    const deploymentReady = !hasCustomHostname || customDomainReady;
    const finalFqdn = result.fqdn ?? result.defaultFqdn;
    if (deploymentReady) {
      await s`UPDATE deployments SET status = 'live', fqdn = ${finalFqdn} WHERE id = ${deploymentId}`;
      await s`UPDATE projects SET container_app_name = ${containerAppName}, fqdn = ${finalFqdn}, last_deployed_at = now() WHERE id = ${proj.id}`;
      await s`UPDATE functions SET status = 'live', container_app_name = ${containerAppName}, fqdn = ${finalFqdn}, updated_at = now() WHERE project_id = ${proj.id}`;
      await persistProgress({
        percent: 100,
        step: "live",
        message: `Deploy v${version} OK`,
        status: "live",
        meta: {
          fqdn: finalFqdn,
          defaultFqdn: result.defaultFqdn,
          customDomains: result.customDomains,
          runtime: runtimeId,
          version,
        },
      });
    } else {
      await s`UPDATE deployments SET status = 'provisioning', fqdn = ${finalFqdn} WHERE id = ${deploymentId}`;
      await s`UPDATE projects SET container_app_name = ${containerAppName}, fqdn = ${finalFqdn}, last_deployed_at = now() WHERE id = ${proj.id}`;
      await s`UPDATE functions SET status = 'provisioning', container_app_name = ${containerAppName}, fqdn = ${finalFqdn}, updated_at = now() WHERE project_id = ${proj.id}`;
    }

    const usingCustom = result.customDomains.length > 0 && finalFqdn === publicHostname;
    await logEvent(
      proj.id,
      ownerId,
      "info",
      "deploy",
      deploymentReady ? `Deploy v${version} OK (${runtimeId})` : `Deploy v${version} OK, certificate pending (${runtimeId})`,
      {
        fqdn: finalFqdn,
        defaultFqdn: result.defaultFqdn,
        customDomains: result.customDomains,
        usingCustomDomain: usingCustom,
        runtime: runtimeId,
        publicHostname,
        certificatePending,
      },
    );
    progress?.(deploymentReady ? "info" : "warn", deploymentReady ? `Deploy v${version} OK` : `Deploy v${version} OK, certificado pendiente`, {
      fqdn: finalFqdn,
      defaultFqdn: result.defaultFqdn,
      customDomains: result.customDomains,
      runtime: runtimeId,
      version,
      publicHostname,
      certificatePending,
    });
    return {
      ok: true,
      deploymentId,
      fqdn: finalFqdn,
      defaultFqdn: result.defaultFqdn,
      customDomains: result.customDomains,
      version,
      runtime: runtimeId,
      publicHostname,
      publicHostnameStatus: hasCustomHostname ? (deploymentReady ? "ready" : "pending") : "none",
      certificateState: hasCustomHostname ? (deploymentReady ? "Succeeded" : certificateState) : null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await s`UPDATE deployments SET status = 'failed', error = ${msg} WHERE id = ${deploymentId}`;
    await logEvent(proj.id, ownerId, "error", "deploy", `Deploy v${version} FAILED`, {
      error: msg,
      runtime: runtimeId,
    });
    await persistProgress({
      percent: 100,
      step: "failed",
      message: `Deploy v${version} FAILED`,
      level: "error",
      status: "failed",
      meta: {
        error: msg,
        runtime: runtimeId,
        version,
      },
    });
    progress?.("error", `Deploy v${version} FAILED`, {
      error: msg,
      runtime: runtimeId,
      version,
    });
    throw new Error(`Deploy failed: ${msg}`);
  }
}
