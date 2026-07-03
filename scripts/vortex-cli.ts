#!/usr/bin/env node

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { sql, ensureSchema } from "../src/lib/neon/db.server.ts";
import { getRuntimeConfig } from "../src/lib/runtimes/index.ts";
import { deployLocalSource } from "../src/lib/cli/local-sync.server.ts";

type CliConfig = {
  projectId: string;
  sourceRoot: string;
  linkedAt: string;
};

type ParsedArgs = {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
};

type DeployProgressLogger = (
  level: "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
) => void;

const CONFIG_PATH = path.resolve(process.cwd(), ".vortex", "config.json");

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fsSync.existsSync(filePath)) return {};
  const text = fsSync.readFileSync(filePath, "utf8");
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (!key) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\\\/g, "\\").replace(/\\"/g, '"');
    }
    env[key] = value;
  }
  return env;
}

function loadLocalEnv(): void {
  const envFiles = [".vortex/.env", ".env.local", ".env"];
  for (const file of envFiles) {
    const values = parseEnvFile(path.resolve(process.cwd(), file));
    for (const [key, value] of Object.entries(values)) {
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      flags.set("help", true);
      continue;
    }

    const [rawKey, inlineValue] = arg.split("=", 2);
    const key = rawKey.replace(/^-+/, "");
    if (inlineValue !== undefined) {
      flags.set(key, inlineValue);
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith("-")) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, true);
    }
  }

  const command = positionals[0] ?? "help";
  return {
    command,
    positionals: positionals.slice(1),
    flags,
  };
}

function getFlag(flags: Map<string, string | boolean>, names: string[]): string | undefined {
  for (const name of names) {
    const value = flags.get(name);
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function hasFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function usage(): string {
  return `Vortex CLI

Usage:
  vortex link --project-id <uuid> [--source-root <dir>]
  vortex deploy [function-name] [--project-id <uuid>] [--source-root <dir>]

Examples:
  vortex link --project-id 123e4567-e89b-12d3-a456-426614174000 --source-root functions
  vortex deploy
  vortex deploy hello-world

Local layout:
  functions/
    hello-world/
      index.ts
      _shared/
        utils.ts
    another-function/
      index.ts
`;
}

async function readConfig(configPath: string): Promise<CliConfig | null> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    if (!parsed.projectId || !parsed.sourceRoot) return null;
    return {
      projectId: parsed.projectId,
      sourceRoot: parsed.sourceRoot,
      linkedAt: parsed.linkedAt ?? new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeConfig(configPath: string, config: CliConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function loadProject(projectId: string) {
  await ensureSchema();
  const s = sql();
  const rows =
    (await s`SELECT id, name, slug, runtime, owner_id FROM projects WHERE id = ${projectId} LIMIT 1`) as Array<{
      id: string;
      name: string;
      slug: string;
      runtime: string | null;
      owner_id: string;
    }>;
  return rows[0] ?? null;
}

function resolveSourceRoot(input: string | undefined, fallback: string): string {
  const value = input?.trim() || fallback;
  return path.resolve(process.cwd(), value);
}

function printDeploymentSummary(result: Awaited<ReturnType<typeof deployLocalSource>>): void {
  const runtime = getRuntimeConfig(result.runtime);
  console.log(`\nProyecto: ${result.projectName} (${result.projectSlug})`);
  console.log(`Runtime: ${runtime.label}`);
  console.log(`Bundles sincronizados: ${result.bundles.length}`);
  for (const bundle of result.bundles) {
    console.log(
      `- ${bundle.name} [${bundle.slug}] -> ${bundle.entrypoint} | ${bundle.created ? "created" : "updated"} | +${bundle.filesUpserted} / -${bundle.filesDeleted}`,
    );
  }
  console.log(`Deployment: v${result.deployment.version} (${result.deployment.runtime})`);
  if (result.deployment.fqdn) {
    console.log(`URL: https://${result.deployment.fqdn}`);
  }
}

function formatProgressMeta(meta?: Record<string, unknown>): string {
  if (!meta) return "";

  const parts: string[] = [];
  const position = meta.position;
  const total = meta.total;
  if (typeof position === "number" && typeof total === "number") {
    parts.push(`${position}/${total}`);
  }

  const slug = meta.slug;
  if (typeof slug === "string" && slug) {
    parts.push(slug);
  }

  const entrypoint = meta.entrypoint;
  if (typeof entrypoint === "string" && entrypoint) {
    parts.push(`entrypoint=${entrypoint}`);
  }

  const created = meta.created;
  if (typeof created === "boolean") {
    parts.push(created ? "created" : "updated");
  }

  const filesUpserted = meta.filesUpserted;
  const filesDeleted = meta.filesDeleted;
  if (typeof filesUpserted === "number" || typeof filesDeleted === "number") {
    parts.push(`+${typeof filesUpserted === "number" ? filesUpserted : 0} / -${typeof filesDeleted === "number" ? filesDeleted : 0}`);
  }

  const runtime = meta.runtime;
  if (typeof runtime === "string" && runtime) {
    parts.push(`runtime=${runtime}`);
  }

  const version = meta.version;
  if (typeof version === "number") {
    parts.push(`v${version}`);
  }

  const fqdn = meta.fqdn;
  if (typeof fqdn === "string" && fqdn) {
    parts.push(`https://${fqdn}`);
  }

  const containerAppName = meta.containerAppName;
  if (typeof containerAppName === "string" && containerAppName) {
    parts.push(`app=${containerAppName}`);
  }

  return parts.length ? ` (${parts.join(" | ")})` : "";
}

function createConsoleProgressLogger(): DeployProgressLogger {
  return (level, message, meta) => {
    const prefix = level === "error" ? "x" : level === "warn" ? "!" : ">";
    console.log(`[vortex] ${prefix} ${message}${formatProgressMeta(meta)}`);
  };
}

function checkRequiredEnvForDeploy(): void {
  const missing = [
    !process.env.NEON_DATABASE_URL && !process.env.DATABASE_URL ? "NEON_DATABASE_URL / DATABASE_URL" : null,
    !process.env.AZURE_TENANT_ID ? "AZURE_TENANT_ID" : null,
    !process.env.AZURE_CLIENT_ID ? "AZURE_CLIENT_ID" : null,
    !process.env.AZURE_CLIENT_SECRET ? "AZURE_CLIENT_SECRET" : null,
    !process.env.AZURE_SUBSCRIPTION_ID ? "AZURE_SUBSCRIPTION_ID" : null,
    !process.env.AZURE_RESOURCE_GROUP ? "AZURE_RESOURCE_GROUP" : null,
    !process.env.AZURE_ACA_ENVIRONMENT ? "AZURE_ACA_ENVIRONMENT" : null,
  ].filter(Boolean) as string[];
  if (missing.length) {
    throw new Error(`Faltan variables de entorno para deploy: ${missing.join(", ")}`);
  }
}

async function runLink(args: ParsedArgs): Promise<void> {
  loadLocalEnv();
  const projectId = getFlag(args.flags, ["project-id", "project", "p"]) ?? args.positionals[0];
  if (!projectId) throw new Error("Debes indicar --project-id <uuid>.");

  const sourceRoot = resolveSourceRoot(
    getFlag(args.flags, ["source-root", "source", "s"]),
    "functions",
  );

  const project = await loadProject(projectId);
  if (!project) {
    throw new Error(`No encontré el proyecto ${projectId}.`);
  }

  const config: CliConfig = {
    projectId,
    sourceRoot: path.relative(process.cwd(), sourceRoot) || ".",
    linkedAt: new Date().toISOString(),
  };
  await writeConfig(CONFIG_PATH, config);

  const runtime = getRuntimeConfig(project.runtime);
  console.log(`Proyecto enlazado: ${project.name} (${project.slug})`);
  console.log(`Runtime: ${runtime.label}`);
  console.log(`Source root: ${config.sourceRoot}`);
  console.log(`Config: ${path.relative(process.cwd(), CONFIG_PATH)}`);
}

async function runDeploy(args: ParsedArgs): Promise<void> {
  loadLocalEnv();
  checkRequiredEnvForDeploy();

  const config = await readConfig(CONFIG_PATH);
  const projectId =
    getFlag(args.flags, ["project-id", "project", "p"]) ??
    config?.projectId ??
    args.positionals.find((value) => !value.startsWith("-"));
  if (!projectId) {
    throw new Error("Debes indicar --project-id <uuid> o ejecutar vortex link primero.");
  }

  const sourceRootInput =
    getFlag(args.flags, ["source-root", "source", "s"]) ??
    config?.sourceRoot ??
    "functions";
  const sourceRoot = resolveSourceRoot(sourceRootInput, "functions");
  const functionName =
    getFlag(args.flags, ["function", "f"]) ??
    args.positionals.find((value) => value !== projectId);

  const progress = createConsoleProgressLogger();
  const result = await deployLocalSource({
    projectId,
    sourceRoot,
    functionName: functionName === "all" ? null : functionName ?? null,
    progress,
  });

  printDeploymentSummary(result);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args.flags, "help") || args.command === "help") {
    console.log(usage());
    return;
  }

  if (args.command === "init" || args.command === "link") {
    await runLink(args);
    return;
  }

  if (args.command === "deploy") {
    await runDeploy(args);
    return;
  }

  throw new Error(`Comando desconocido: ${args.command}\n\n${usage()}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exitCode = 1;
});
