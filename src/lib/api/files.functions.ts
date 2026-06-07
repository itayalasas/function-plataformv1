import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuthSystemAuth } from "@/lib/auth/server-middleware";
import { sql, ensureSchema } from "@/lib/neon/db.server";
import { getRuntimeConfig } from "@/lib/runtimes";

type FileKind = "file" | "dir";

type FileRow = {
  id: string;
  path: string;
  content: string;
  updated_at: string;
  kind: FileKind;
};

type NodeRow = {
  id: string;
  path: string;
  kind: FileKind;
};

const pathSegmentRe = /^[a-zA-Z0-9._-]+$/;

function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function isSafePath(path: string): boolean {
  const normalized = normalizePath(path);
  if (!normalized || normalized.length > 120) return false;
  return normalized
    .split("/")
    .every((segment) => pathSegmentRe.test(segment) && segment !== "." && segment !== "..");
}

const pathSchema = z.string().min(1).max(120).refine(isSafePath, "Ruta inválida");

function pathParents(path: string): string[] {
  const parts = normalizePath(path).split("/").filter(Boolean);
  const parents: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    parents.push(parts.slice(0, i).join("/"));
  }
  return parents;
}

function pathPrefix(path: string): string {
  return `${normalizePath(path)}/`;
}

function escapeLikePattern(path: string): string {
  return normalizePath(path).replace(/[\\%_]/g, "\\$&");
}

function javaPackageFromPath(path: string): string | null {
  const normalized = normalizePath(path);
  const prefix = "src/main/java/";
  if (!normalized.startsWith(prefix) || !normalized.endsWith(".java")) return null;
  const relative = normalized.slice(prefix.length);
  const parts = relative.split("/").filter(Boolean);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join(".");
}

function rewriteJavaPackage(content: string, nextPackage: string | null): string {
  const packageLine = nextPackage ? `package ${nextPackage};` : "";
  const packageRe = /^\s*package\s+[\w.]+;\s*(?:\r?\n)?/m;
  if (packageRe.test(content)) {
    return nextPackage
      ? content.replace(packageRe, `${packageLine}\n\n`)
      : content.replace(packageRe, "");
  }
  if (!nextPackage) return content;
  return `${packageLine}\n\n${content}`;
}

async function loadNodes(
  s: ReturnType<typeof sql>,
  functionId: string,
  ownerId: string,
  excludeId?: string,
): Promise<NodeRow[]> {
  const rows = excludeId
    ? await s`
      SELECT id, path, kind
      FROM function_files
      WHERE function_id = ${functionId}
        AND owner_id = ${ownerId}
        AND id <> ${excludeId}
    `
    : await s`
      SELECT id, path, kind
      FROM function_files
      WHERE function_id = ${functionId}
        AND owner_id = ${ownerId}
    `;
  return rows as NodeRow[];
}

function exactNode(nodes: NodeRow[], targetPath: string): NodeRow | undefined {
  return nodes.find((node) => node.path === targetPath);
}

function ancestorFileConflict(nodes: NodeRow[], targetPath: string): NodeRow | undefined {
  for (const ancestor of pathParents(targetPath)) {
    const node = exactNode(nodes, ancestor);
    if (node?.kind === "file") return node;
  }
  return undefined;
}

function descendantConflict(nodes: NodeRow[], targetPath: string): NodeRow | undefined {
  const prefix = pathPrefix(targetPath);
  return nodes.find((node) => node.path.startsWith(prefix));
}

export const listFiles = createServerFn({ method: "GET" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ functionId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureSchema();
    const s = sql();
    const rows =
      await s`SELECT id, path, content, updated_at, kind FROM function_files WHERE function_id = ${data.functionId} AND owner_id = ${context.userId} ORDER BY path ASC`;
    return rows as FileRow[];
  });

export const upsertFile = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) =>
    z
      .object({
        functionId: z.string().uuid(),
        path: pathSchema,
        content: z.string().max(1_000_000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureSchema();
    const s = sql();
    const path = normalizePath(data.path);
    const nodes = await loadNodes(s, data.functionId, context.userId);
    const exact = exactNode(nodes, path);

    if (exact?.kind === "dir") {
      throw new Error("Ya existe una carpeta con esa ruta");
    }

    if (exact?.kind === "file") {
      const rows = await s`
        UPDATE function_files
        SET content = ${data.content}, updated_at = now()
        WHERE id = ${exact.id} AND owner_id = ${context.userId}
        RETURNING id, path, content, updated_at, kind
      `;
      await s`UPDATE functions SET updated_at = now(), status = 'modified' WHERE id = ${data.functionId} AND owner_id = ${context.userId}`;
      return (rows as FileRow[])[0];
    }

    const ancestorFile = ancestorFileConflict(nodes, path);
    if (ancestorFile) {
      throw new Error(
        `No puedes crear un archivo dentro de una ruta que ya es un archivo: ${ancestorFile.path}`,
      );
    }

    const childConflict = descendantConflict(nodes, path);
    if (childConflict) {
      throw new Error("No puedes crear un archivo dentro de una ruta que ya tiene contenido hijo");
    }

    const rows = await s`
      INSERT INTO function_files (function_id, owner_id, path, content, kind)
      VALUES (${data.functionId}, ${context.userId}, ${path}, ${data.content}, 'file')
      RETURNING id, path, content, updated_at, kind
    `;
    await s`UPDATE functions SET updated_at = now(), status = 'modified' WHERE id = ${data.functionId} AND owner_id = ${context.userId}`;
    return (rows as FileRow[])[0];
  });

export const createDirectory = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) =>
    z
      .object({
        functionId: z.string().uuid(),
        path: pathSchema,
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureSchema();
    const s = sql();
    const path = normalizePath(data.path);
    const nodes = await loadNodes(s, data.functionId, context.userId);
    const exact = exactNode(nodes, path);
    if (exact) {
      throw new Error(
        exact.kind === "dir"
          ? "Ya existe una carpeta con esa ruta"
          : "Ya existe un archivo con esa ruta",
      );
    }

    const ancestorFile = ancestorFileConflict(nodes, path);
    if (ancestorFile) {
      throw new Error(
        `No puedes crear una carpeta dentro de un archivo existente: ${ancestorFile.path}`,
      );
    }

    const rows = await s`
      INSERT INTO function_files (function_id, owner_id, path, content, kind)
      VALUES (${data.functionId}, ${context.userId}, ${path}, '', 'dir')
      RETURNING id, path, content, updated_at, kind
    `;
    await s`UPDATE functions SET updated_at = now(), status = 'modified' WHERE id = ${data.functionId} AND owner_id = ${context.userId}`;
    return (rows as FileRow[])[0];
  });

export const renameFile = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        path: pathSchema,
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureSchema();
    const s = sql();
    const nextPath = normalizePath(data.path);
    const rows = (await s`
      SELECT ff.id, ff.function_id, ff.path, ff.content, ff.kind, f.entrypoint, p.runtime
      FROM function_files ff
      JOIN functions f ON f.id = ff.function_id
      JOIN projects p ON p.id = f.project_id
      WHERE ff.id = ${data.id} AND ff.owner_id = ${context.userId}
      LIMIT 1
    `) as Array<{
      id: string;
      function_id: string;
      path: string;
      content: string;
      kind: FileKind;
      entrypoint: string;
      runtime: string | null;
    }>;
    if (!rows[0]) throw new Error("File not found");
    const current = rows[0];
    if (current.kind !== "file") {
      throw new Error("Renombrar carpetas todavía no está soportado");
    }
    if (current.path === nextPath) {
      return {
        ok: true,
        id: current.id,
        path: current.path,
        content: current.content,
        kind: current.kind,
      };
    }

    const nodes = await loadNodes(s, current.function_id, context.userId, current.id);
    const exact = exactNode(nodes, nextPath);
    if (exact) {
      throw new Error(
        exact.kind === "dir"
          ? "Ya existe una carpeta con esa ruta"
          : "Ya existe un archivo con esa ruta",
      );
    }

    const ancestorFile = ancestorFileConflict(nodes, nextPath);
    if (ancestorFile) {
      throw new Error(
        `No puedes mover el archivo dentro de una ruta que ya es un archivo: ${ancestorFile.path}`,
      );
    }

    const childConflict = descendantConflict(nodes, nextPath);
    if (childConflict) {
      throw new Error("No puedes mover el archivo dentro de una ruta que ya tiene contenido hijo");
    }

    const runtime = getRuntimeConfig(current.runtime);
    const nextContent =
      runtime.id === "java"
        ? rewriteJavaPackage(current.content, javaPackageFromPath(nextPath))
        : current.content;

    await s`
      UPDATE function_files
      SET path = ${nextPath}, content = ${nextContent}, updated_at = now()
      WHERE id = ${current.id} AND owner_id = ${context.userId}
    `;
    await s`
      UPDATE functions
      SET
        entrypoint = CASE WHEN entrypoint = ${current.path} THEN ${nextPath} ELSE entrypoint END,
        updated_at = now(),
        status = 'modified'
      WHERE id = ${current.function_id} AND owner_id = ${context.userId}
    `;
    return { ok: true, id: current.id, path: nextPath, content: nextContent, kind: current.kind };
  });

export const deleteFile = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid().optional(),
        functionId: z.string().uuid().optional(),
        path: z.string().min(1).max(120).optional(),
      })
      .refine((value) => Boolean(value.id || (value.functionId && value.path)), {
        message: "Debes indicar un archivo o una ruta",
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureSchema();
    const s = sql();

    let functionId = data.functionId ?? null;
    let targetPath = data.path ? normalizePath(data.path) : null;

    if (targetPath && !isSafePath(targetPath)) {
      throw new Error("Ruta inválida");
    }

    if (data.id) {
      const rows = (await s`
        SELECT ff.id, ff.function_id, ff.path, ff.kind, f.entrypoint
        FROM function_files ff
        JOIN functions f ON f.id = ff.function_id
        WHERE ff.id = ${data.id} AND ff.owner_id = ${context.userId}
        LIMIT 1
      `) as Array<{
        id: string;
        function_id: string;
        path: string;
        kind: FileKind;
        entrypoint: string;
      }>;
      if (!rows[0]) throw new Error("File not found");
      functionId = rows[0].function_id;
      targetPath = rows[0].path;
      if (rows[0].entrypoint === targetPath || rows[0].entrypoint.startsWith(`${targetPath}/`)) {
        throw new Error("No puedes borrar la ruta de entrada del proyecto");
      }
    } else {
      const projectRows = (await s`
        SELECT entrypoint
        FROM functions
        WHERE id = ${functionId} AND owner_id = ${context.userId}
        LIMIT 1
      `) as Array<{ entrypoint: string }>;
      if (!projectRows[0]) throw new Error("Function not found");
      if (
        projectRows[0].entrypoint === targetPath ||
        projectRows[0].entrypoint.startsWith(`${targetPath}/`)
      ) {
        throw new Error("No puedes borrar la ruta de entrada del proyecto");
      }
    }

    if (!functionId || !targetPath) throw new Error("Debes indicar un archivo o una ruta");

    const rows = (await s`
      DELETE FROM function_files
      WHERE function_id = ${functionId}
        AND owner_id = ${context.userId}
        AND (
          path = ${targetPath}
          OR path LIKE ${`${escapeLikePattern(targetPath)}/%`} ESCAPE '\\'
        )
      RETURNING id
    `) as Array<{ id: string }>;
    if (!rows.length) throw new Error("File not found");

    await s`
      UPDATE functions
      SET updated_at = now(), status = 'modified'
      WHERE id = ${functionId} AND owner_id = ${context.userId}
    `;
    return { ok: true };
  });
