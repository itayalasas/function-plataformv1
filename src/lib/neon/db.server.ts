import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let _sql: NeonQueryFunction<false, false> | undefined;
let _schemaReady: Promise<void> | undefined;
let _warnedAboutPooledUrl = false;

type DiskMigration = {
  id: string;
  statements: string[];
};

const MIGRATIONS_TABLE = "neon_schema_migrations";
const NEON_MIGRATIONS_DIR = path.resolve(process.cwd(), "neon", "migrations");

function derivePooledNeonUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    const isNeonHost = host.endsWith(".neon.tech") || host.endsWith(".neon.com");
    if (!isNeonHost) return rawUrl;

    const labels = host.split(".");
    if (!labels[0]?.startsWith("ep-") || labels[0].includes("-pooler")) return rawUrl;

    labels[0] = `${labels[0]}-pooler`;
    url.hostname = labels.join(".");
    if (!_warnedAboutPooledUrl) {
      _warnedAboutPooledUrl = true;
      console.warn(
        "[db] Using a derived pooled Neon connection string. For app traffic, prefer a pooled URL with -pooler in the hostname.",
      );
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function getDatabaseUrl(): string {
  const rawUrl =
    process.env.NEON_DATABASE_URL_POOLER ||
    process.env.NEON_DATABASE_URL ||
    process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("NEON_DATABASE_URL is not set");
  return derivePooledNeonUrl(rawUrl);
}

export function sql(): NeonQueryFunction<false, false> {
  if (!_sql) {
    _sql = neon(getDatabaseUrl());
  }
  return _sql;
}

function splitSqlStatements(sqlText: string): string[] {
  return sqlText
    .split(/;\s*(?:\r?\n|$)/g)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function ensureMigrationTable(s: NeonQueryFunction<false, false>): Promise<void> {
  await s.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function readMigrationsFromDisk(): Promise<DiskMigration[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(NEON_MIGRATIONS_DIR, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Neon migrations directory not found: ${NEON_MIGRATIONS_DIR}`);
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "en"));

  if (!files.length) {
    throw new Error(`No SQL migrations found in ${NEON_MIGRATIONS_DIR}`);
  }

  return Promise.all(
    files.map(async (fileName) => {
      const filePath = path.join(NEON_MIGRATIONS_DIR, fileName);
      const raw = await fs.readFile(filePath, "utf8");
      return {
        id: path.basename(fileName, ".sql"),
        statements: splitSqlStatements(raw),
      };
    }),
  );
}

async function getAppliedMigrations(s: NeonQueryFunction<false, false>): Promise<Set<string>> {
  const rows = (await s.query(`SELECT id FROM ${MIGRATIONS_TABLE} ORDER BY applied_at ASC`)) as Array<{
    id: string;
  }>;
  return new Set(rows.map((row) => row.id));
}

async function applyMigration(s: NeonQueryFunction<false, false>, migration: DiskMigration): Promise<void> {
  console.log(`[db] Applying migration ${migration.id}`);
  for (const statement of migration.statements) {
    await s.query(statement);
  }
  await s`
    INSERT INTO neon_schema_migrations (id)
    VALUES (${migration.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

/** Server-side helper: append a structured log entry. Never throws. */
export async function logEvent(
  projectId: string | null,
  ownerId: string,
  level: "info" | "warn" | "error" | "debug",
  source: string,
  message: string,
  meta?: unknown,
): Promise<void> {
  try {
    await ensureSchema();
    const s = sql();
    const metaJson = meta === undefined ? null : JSON.stringify(meta);
    await s`INSERT INTO system_logs (project_id, owner_id, level, source, message, meta)
            VALUES (${projectId}, ${ownerId}, ${level}, ${source}, ${message}, ${metaJson}::jsonb)`;
  } catch (e) {
    console.error("[logEvent] failed", e);
  }
}

export type InvocationLogPayload = {
  projectId: string | null;
  functionId: string;
  ownerId: string;
  kind?: string;
  method: string;
  path: string;
  target?: string | null;
  status?: number | null;
  durationMs?: number | null;
  error?: string | null;
  request?: unknown;
  response?: unknown;
  meta?: unknown;
};

/** Server-side helper: append a structured function/API invocation log. Never throws. */
export async function recordInvocationLog(payload: InvocationLogPayload): Promise<void> {
  try {
    await ensureSchema();
    const s = sql();
    const requestJson = payload.request === undefined ? null : JSON.stringify(payload.request);
    const responseJson = payload.response === undefined ? null : JSON.stringify(payload.response);
    const metaJson = payload.meta === undefined ? null : JSON.stringify(payload.meta);
    await s`
      INSERT INTO invocation_logs (
        project_id, function_id, owner_id, kind, method, path, target, status, duration_ms, error, request, response, meta
      ) VALUES (
        ${payload.projectId},
        ${payload.functionId},
        ${payload.ownerId},
        ${payload.kind ?? "manual"},
        ${payload.method},
        ${payload.path},
        ${payload.target ?? null},
        ${payload.status ?? null},
        ${payload.durationMs ?? null},
        ${payload.error ?? null},
        ${requestJson}::jsonb,
        ${responseJson}::jsonb,
        ${metaJson}::jsonb
      )
    `;
  } catch (e) {
    console.error("[recordInvocationLog] failed", e);
  }
}

export function ensureSchema(): Promise<void> {
  if (!_schemaReady) {
    const s = sql();
    _schemaReady = (async () => {
      await ensureMigrationTable(s);
      const applied = await getAppliedMigrations(s);
      const migrations = await readMigrationsFromDisk();
      for (const migration of migrations) {
        if (applied.has(migration.id)) continue;
        await applyMigration(s, migration);
        applied.add(migration.id);
      }
    })().catch((err) => {
      _schemaReady = undefined;
      throw err;
    });
  }
  return _schemaReady;
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "untitled"
  );
}
