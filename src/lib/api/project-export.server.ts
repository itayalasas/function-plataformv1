import { deflateRawSync } from "node:zlib";

import { ensureSchema, sql } from "@/lib/neon/db.server";

type ExportFunctionRow = {
  id: string;
  slug: string;
  created_at: string;
};

type ExportFileRow = {
  function_slug: string;
  path: string;
  content: string;
  kind: "file" | "dir";
  updated_at: string;
};

type ZipEntry = {
  name: string;
  kind: "file" | "dir";
  data: Buffer;
  updatedAt: Date;
};

export type ProjectExportArchive = {
  filename: string;
  bytes: Buffer;
};

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let j = 0; j < 8; j += 1) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

function normalizeArchivePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function collectParentDirectories(path: string): string[] {
  const parts = normalizeArchivePath(path).split("/").filter(Boolean);
  const parents: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    parents.push(parts.slice(0, i).join("/"));
  }
  return parents;
}

function ensureTrailingSlash(path: string): string {
  const normalized = normalizeArchivePath(path);
  return normalized ? `${normalized}/` : "";
}

function toDosDateTime(date: Date): { time: number; date: number } {
  const safeYear = Math.max(1980, date.getFullYear());
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    Math.floor(date.getSeconds() / 2);
  const dosDate =
    (((safeYear - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { time, date: dosDate };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUInt16LE(target: Buffer, offset: number, value: number): void {
  target.writeUInt16LE(value & 0xffff, offset);
}

function writeUInt32LE(target: Buffer, offset: number, value: number): void {
  target.writeUInt32LE(value >>> 0, offset);
}

function createZipArchive(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localHeaderOffset = 0;

  for (const entry of entries) {
    const name =
      entry.kind === "dir" ? ensureTrailingSlash(entry.name) : normalizeArchivePath(entry.name);
    if (!name) continue;

    const nameBytes = Buffer.from(name, "utf8");
    const uncompressed = entry.kind === "dir" ? Buffer.alloc(0) : entry.data;
    const compressed =
      entry.kind === "dir" ? Buffer.alloc(0) : Buffer.from(deflateRawSync(uncompressed));
    const method = entry.kind === "dir" ? 0 : 8;
    const { time, date } = toDosDateTime(entry.updatedAt);
    const crc = crc32(uncompressed);
    const fileSize = uncompressed.length;
    const compressedSize = compressed.length;

    const localHeader = Buffer.alloc(30);
    writeUInt32LE(localHeader, 0, 0x04034b50);
    writeUInt16LE(localHeader, 4, 20);
    writeUInt16LE(localHeader, 6, 0x0800);
    writeUInt16LE(localHeader, 8, method);
    writeUInt16LE(localHeader, 10, time);
    writeUInt16LE(localHeader, 12, date);
    writeUInt32LE(localHeader, 14, crc);
    writeUInt32LE(localHeader, 18, compressedSize);
    writeUInt32LE(localHeader, 22, fileSize);
    writeUInt16LE(localHeader, 26, nameBytes.length);
    writeUInt16LE(localHeader, 28, 0);

    localParts.push(localHeader, nameBytes, compressed);

    const centralHeader = Buffer.alloc(46);
    writeUInt32LE(centralHeader, 0, 0x02014b50);
    writeUInt16LE(centralHeader, 4, 20);
    writeUInt16LE(centralHeader, 6, 20);
    writeUInt16LE(centralHeader, 8, 0x0800);
    writeUInt16LE(centralHeader, 10, method);
    writeUInt16LE(centralHeader, 12, time);
    writeUInt16LE(centralHeader, 14, date);
    writeUInt32LE(centralHeader, 16, crc);
    writeUInt32LE(centralHeader, 20, compressedSize);
    writeUInt32LE(centralHeader, 24, fileSize);
    writeUInt16LE(centralHeader, 28, nameBytes.length);
    writeUInt16LE(centralHeader, 30, 0);
    writeUInt16LE(centralHeader, 32, 0);
    writeUInt16LE(centralHeader, 34, 0);
    writeUInt16LE(centralHeader, 36, 0);
    const externalAttrs = entry.kind === "dir" ? 0x10 << 16 : 0;
    writeUInt32LE(centralHeader, 38, externalAttrs);
    writeUInt32LE(centralHeader, 42, localHeaderOffset);

    centralParts.push(centralHeader, nameBytes);

    localHeaderOffset += localHeader.length + nameBytes.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endOfCentralDirectory = Buffer.alloc(22);
  writeUInt32LE(endOfCentralDirectory, 0, 0x06054b50);
  writeUInt16LE(endOfCentralDirectory, 4, 0);
  writeUInt16LE(endOfCentralDirectory, 6, 0);
  writeUInt16LE(endOfCentralDirectory, 8, entries.length);
  writeUInt16LE(endOfCentralDirectory, 10, entries.length);
  writeUInt32LE(endOfCentralDirectory, 12, centralDirectory.length);
  writeUInt32LE(endOfCentralDirectory, 16, localHeaderOffset);
  writeUInt16LE(endOfCentralDirectory, 20, 0);

  return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]);
}

function addDirectory(directories: Map<string, Date>, rawPath: string, updatedAt: string): void {
  const normalized = ensureTrailingSlash(rawPath);
  if (!normalized || directories.has(normalized)) return;
  directories.set(normalized, new Date(updatedAt));
}

export async function buildProjectExportArchive({
  projectId,
  ownerId,
}: {
  projectId: string;
  ownerId: string;
}): Promise<ProjectExportArchive | null> {
  await ensureSchema();
  const s = sql();

  const projectRows = (await s`
    SELECT id, slug
    FROM projects
    WHERE id = ${projectId} AND owner_id = ${ownerId}
    LIMIT 1
  `) as Array<{ id: string; slug: string }>;
  const project = projectRows[0];
  if (!project) return null;

  const functionRows = (await s`
    SELECT id, slug, created_at
    FROM functions
    WHERE project_id = ${projectId} AND owner_id = ${ownerId}
    ORDER BY slug ASC
  `) as ExportFunctionRow[];

  const fileRows = (await s`
    SELECT f.slug AS function_slug, ff.path, ff.content, ff.kind, ff.updated_at
    FROM function_files ff
    JOIN functions f ON f.id = ff.function_id
    WHERE f.project_id = ${projectId}
      AND f.owner_id = ${ownerId}
      AND ff.owner_id = ${ownerId}
    ORDER BY f.slug ASC, ff.path ASC
  `) as ExportFileRow[];

  const directories = new Map<string, Date>();
  const files: ZipEntry[] = [];

  for (const fn of functionRows) {
    addDirectory(directories, `${fn.slug}/`, fn.created_at);
  }

  for (const row of fileRows) {
    const rootPrefix = `${row.function_slug}/`;
    const filePath = normalizeArchivePath(row.path);
    if (!filePath) continue;

    const updatedAt = row.updated_at;
    if (row.kind === "dir") {
      addDirectory(directories, `${rootPrefix}${filePath}/`, updatedAt);
      continue;
    }

    for (const parent of collectParentDirectories(filePath)) {
      addDirectory(directories, `${rootPrefix}${parent}/`, updatedAt);
    }

    files.push({
      name: `${rootPrefix}${filePath}`,
      kind: "file",
      data: Buffer.from(row.content ?? "", "utf8"),
      updatedAt: new Date(updatedAt),
    });
  }

  const entries: ZipEntry[] = [];
  const sortedDirectories = [...directories.entries()].sort(([a], [b]) => {
    const aDepth = a.split("/").filter(Boolean).length;
    const bDepth = b.split("/").filter(Boolean).length;
    if (aDepth !== bDepth) return aDepth - bDepth;
    return a.localeCompare(b);
  });

  for (const [name, updatedAt] of sortedDirectories) {
    entries.push({
      name,
      kind: "dir",
      data: Buffer.alloc(0),
      updatedAt,
    });
  }

  files.sort((a, b) => a.name.localeCompare(b.name));
  entries.push(...files);

  const bytes = createZipArchive(entries);
  return {
    filename: `${project.slug}-functions.zip`,
    bytes,
  };
}
