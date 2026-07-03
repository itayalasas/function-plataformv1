import fs from "node:fs/promises";
import path from "node:path";

export type LocalFileEntry = {
  path: string;
  content: string;
  kind: "file" | "dir";
};

export type LocalBundleConfig = {
  name?: string;
  slug?: string;
  entrypoint?: string;
};

export type LocalFunctionBundle = {
  rootDir: string;
  displayName: string;
  slug: string;
  entrypoint: string;
  files: LocalFileEntry[];
  config: LocalBundleConfig | null;
};

type WalkBundleOptions = {
  includeSharedDir?: boolean;
};

const IGNORED_DIRS = new Set([
  ".git",
  ".vortex",
  "node_modules",
  "dist",
  "build",
  "target",
  "bin",
  "obj",
  "coverage",
  ".next",
  ".turbo",
  ".idea",
  ".vscode",
  "__pycache__",
]);

const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db", ".vortex-entrypoint", "vortex.json"]);

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}

function normalizeRelativePath(input: string): string {
  return input
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function isIgnoredDirectory(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

function isIgnoredFile(name: string): boolean {
  return IGNORED_FILES.has(name);
}

function isInsideRootDir(rootDir: string, targetPath: string): boolean {
  const relative = normalizeRelativePath(path.relative(rootDir, targetPath));
  return Boolean(relative) && !relative.startsWith("..");
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}

function isBundleRootManifests(fileNames: Set<string>): boolean {
  const manifests = [
    "package.json",
    "deno.json",
    "deno.jsonc",
    "pyproject.toml",
    "requirements.txt",
    "pom.xml",
    "App.csproj",
    "app.csproj",
  ];
  return manifests.some((name) => fileNames.has(name));
}

function runtimeEntrypointCandidates(runtimeId: string): string[] {
  switch (runtimeId) {
    case "deno":
      return ["index.ts", "index.tsx", "main.ts", "handler.ts", "app.ts"];
    case "node":
      return ["index.js", "index.cjs", "index.mjs", "main.js", "handler.js", "app.js"];
    case "python":
      return ["index.py", "main.py", "handler.py", "app.py"];
    case "java":
      return [
        "src/main/java/com/example/App.java",
        "src/main/java/com/example/Application.java",
        "src/main/java/com/example/Main.java",
        "src/main/java/com/example/Controller.java",
      ];
    case "dotnet":
      return ["Program.cs", "App.cs", "Startup.cs"];
    default:
      return ["index.ts", "index.js", "index.py", "Program.cs"];
  }
}

async function readBundleConfig(rootDir: string): Promise<LocalBundleConfig | null> {
  const configPath = path.join(rootDir, "vortex.json");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as LocalBundleConfig;
    return {
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      slug: typeof parsed.slug === "string" ? parsed.slug : undefined,
      entrypoint: typeof parsed.entrypoint === "string" ? parsed.entrypoint : undefined,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${configPath}: ${error.message}`);
    }
    throw error;
  }
}

async function walkBundle(rootDir: string, currentRel = ""): Promise<LocalFileEntry[]> {
  return walkBundleWithOptions(rootDir, currentRel, {});
}

async function walkBundleWithOptions(
  rootDir: string,
  currentRel = "",
  options: WalkBundleOptions,
): Promise<LocalFileEntry[]> {
  const abs = currentRel ? path.join(rootDir, currentRel) : rootDir;
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries: LocalFileEntry[] = [];

  for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (dirent.isDirectory() && isIgnoredDirectory(dirent.name)) continue;
    if (dirent.isDirectory() && dirent.name === "_shared" && !options.includeSharedDir) continue;
    if (dirent.isFile() && isIgnoredFile(dirent.name)) continue;

    const rel = normalizeRelativePath(path.join(currentRel, dirent.name));
    if (dirent.isDirectory()) {
      entries.push({ path: rel, kind: "dir", content: "" });
      entries.push(...await walkBundleWithOptions(rootDir, rel, options));
      continue;
    }

    if (dirent.isSymbolicLink()) continue;
    if (!dirent.isFile()) continue;
    const content = await fs.readFile(path.join(rootDir, rel), "utf8");
    entries.push({ path: rel, kind: "file", content });
  }

  return entries;
}

function extractModuleSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"'`]+)["']/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"'`]+)["']/g,
    /\brequire\(\s*["']([^"'`]+)["']\s*\)/g,
    /\bimport\(\s*["']([^"'`]+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[1]?.trim();
      if (spec) specifiers.add(spec);
    }
  }

  return [...specifiers];
}

function extractPythonModuleSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();

  for (const match of source.matchAll(/^\s*from\s+([.\w]+)\s+import\s+/gm)) {
    const spec = match[1]?.trim();
    if (spec) specifiers.add(spec);
  }

  for (const match of source.matchAll(/^\s*import\s+(.+)$/gm)) {
    const clause = match[1]?.trim();
    if (!clause) continue;
    for (const segment of clause.split(",")) {
      const spec = segment.replace(/\s+as\s+.+$/i, "").trim();
      if (spec) specifiers.add(spec);
    }
  }

  return [...specifiers];
}

function extractJavaModuleSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(/^\s*import\s+(?:static\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$*]*)*)\s*;/gm)) {
    const spec = match[1]?.trim();
    if (spec) specifiers.add(spec);
  }
  return [...specifiers];
}

function extractDotnetModuleSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(/^\s*(?:global\s+)?using\s+(?:static\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/gm)) {
    const spec = match[1]?.trim();
    if (spec) specifiers.add(spec);
  }
  return [...specifiers];
}

function extractSharedReferences(runtimeId: string, source: string): string[] {
  const specifiers = (() => {
    switch (runtimeId) {
      case "python":
        return extractPythonModuleSpecifiers(source);
      case "java":
        return extractJavaModuleSpecifiers(source);
      case "dotnet":
        return extractDotnetModuleSpecifiers(source);
      case "node":
      case "deno":
      default:
        return extractModuleSpecifiers(source);
    }
  })();

  return specifiers.filter((specifier) => specifier.includes("_shared"));
}

function sharedRootFromAbsolutePath(absPath: string): string | null {
  const normalized = path.normalize(absPath);
  const parts = normalized.split(path.sep);
  const sharedIndex = parts.lastIndexOf("_shared");
  if (sharedIndex < 0) return null;
  return parts.slice(0, sharedIndex + 1).join(path.sep);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function sharedTailFromSpecifier(specifier: string): string {
  const parts = specifier.replace(/\\/g, "/").split("/").filter(Boolean);
  const sharedIndex = parts.indexOf("_shared");
  if (sharedIndex < 0) return "";
  return parts.slice(sharedIndex + 1).join("/");
}

function toRelativeImportPath(fromDir: string, toPath: string): string {
  const rel = normalizeRelativePath(path.relative(fromDir, toPath));
  if (!rel || rel === ".") return "./";
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function sharedBundleRootRelative(runtimeId: string, rootDir: string, sharedSourceRoot: string): string {
  const relative = normalizeRelativePath(path.relative(rootDir, sharedSourceRoot));
  if (runtimeId === "java") {
    if (relative && !relative.startsWith("..") && relative.startsWith("src/main/java/")) {
      return relative;
    }
    return "src/main/java/_shared";
  }

  if (relative && !relative.startsWith("..")) {
    return relative;
  }

  return "_shared";
}

function sharedRootCandidates(runtimeId: string, rootDir: string, entrypointPath: string): string[] {
  const entrypointDir = path.dirname(path.join(rootDir, entrypointPath));
  const candidates = [
    path.join(entrypointDir, "_shared"),
    ...(runtimeId === "java" ? [path.join(rootDir, "src/main/java/_shared")] : []),
    path.join(rootDir, "_shared"),
    path.join(path.dirname(rootDir), "_shared"),
  ];

  return uniquePaths(candidates.map((candidate) => path.normalize(candidate)));
}

async function resolveSharedSourceRoot(
  runtimeId: string,
  rootDir: string,
  entrypointPath: string,
  source: string,
): Promise<string | null> {
  const sharedReferences = extractSharedReferences(runtimeId, source);
  if (sharedReferences.length === 0) return null;

  const entrypointDir = path.dirname(path.join(rootDir, entrypointPath));

  if (runtimeId === "node" || runtimeId === "deno") {
    const resolvedRoots: string[] = [];
    for (const spec of sharedReferences) {
      if (!spec.startsWith(".") && !spec.startsWith("/")) continue;
      const resolved = path.resolve(entrypointDir, spec);
      const sharedRoot = sharedRootFromAbsolutePath(resolved);
      if (!sharedRoot) continue;
      if (!(await pathExists(sharedRoot))) continue;
      resolvedRoots.push(sharedRoot);
    }

    const uniqueResolvedRoots = uniquePaths(resolvedRoots.map((candidate) => path.normalize(candidate)));
    if (uniqueResolvedRoots.length > 1) {
      throw new Error(
        `El index ${path.join(rootDir, entrypointPath)} referencia mas de un directorio _shared. Deja un solo _shared por function.`,
      );
    }

    if (uniqueResolvedRoots.length === 1) {
      return uniqueResolvedRoots[0] ?? null;
    }
  }

  for (const candidate of sharedRootCandidates(runtimeId, rootDir, entrypointPath)) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

function rewriteSharedImports(
  source: string,
  entrypointDir: string,
  bundleRoot: string,
  sharedBundleRootRelative: string,
): string {
  return source.replace(
    /(\b(?:import\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?|export\s+(?:\*|\{[^}]*\}\s+from\s+)|require\(|import\()\s*["'])([^"'`]+)(["'])/g,
    (full, prefix: string, spec: string, suffix: string) => {
      if (!spec.startsWith(".") || !spec.includes("_shared")) return full;
      const replacement = toRelativeImportPath(
        entrypointDir,
        path.join(bundleRoot, sharedBundleRootRelative, sharedTailFromSpecifier(spec)),
      );
      return `${prefix}${replacement}${suffix}`;
    },
  );
}

function filePathSet(entries: LocalFileEntry[]): Set<string> {
  return new Set(entries.map((entry) => entry.path));
}

function detectEntrypointPath(
  entries: LocalFileEntry[],
  runtimeId: string,
  config: LocalBundleConfig | null,
): string | null {
  const paths = filePathSet(entries);

  if (config?.entrypoint && paths.has(normalizeRelativePath(config.entrypoint))) {
    return normalizeRelativePath(config.entrypoint);
  }

  const rootFiles = new Set(
    entries.filter((entry) => !entry.path.includes("/")).map((entry) => entry.path),
  );

  if (runtimeId === "node" && rootFiles.has("package.json")) {
    const pkg = entries.find((entry) => entry.path === "package.json" && entry.kind === "file");
    if (pkg) {
      try {
        const parsed = JSON.parse(pkg.content) as { main?: string };
        if (typeof parsed.main === "string") {
          const mainPath = normalizeRelativePath(parsed.main);
          if (paths.has(mainPath)) return mainPath;
        }
      } catch {
        // fall through to the runtime heuristics
      }
    }
  }

  for (const candidate of runtimeEntrypointCandidates(runtimeId)) {
    const normalized = normalizeRelativePath(candidate);
    if (paths.has(normalized)) return normalized;
  }

  if (runtimeId === "java") {
    const javaCandidates = entries
      .filter((entry) => entry.kind === "file" && entry.path.startsWith("src/main/java/") && entry.path.endsWith(".java"))
      .map((entry) => entry.path)
      .sort((a, b) => {
        const preferred = ["App.java", "Application.java", "Main.java", "Controller.java"];
        const aName = path.posix.basename(a);
        const bName = path.posix.basename(b);
        const aIndex = preferred.indexOf(aName);
        const bIndex = preferred.indexOf(bName);
        if (aIndex !== bIndex) return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
        return a.localeCompare(b);
      });
    if (javaCandidates.length) return javaCandidates[0];
  }

  if (runtimeId === "dotnet") {
    const csCandidates = entries
      .filter((entry) => entry.kind === "file" && entry.path.endsWith(".cs"))
      .map((entry) => entry.path)
      .sort((a, b) => {
        const preferred = ["Program.cs", "App.cs", "Startup.cs"];
        const aName = path.posix.basename(a);
        const bName = path.posix.basename(b);
        const aIndex = preferred.indexOf(aName);
        const bIndex = preferred.indexOf(bName);
        if (aIndex !== bIndex) return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
        return a.localeCompare(b);
      });
    if (csCandidates.length) return csCandidates[0];
  }

  const manifestPaths = new Set([
    "package.json",
    "deno.json",
    "deno.jsonc",
    "pyproject.toml",
    "requirements.txt",
    "pom.xml",
    "App.csproj",
    "app.csproj",
  ]);
  for (const manifest of manifestPaths) {
    if (rootFiles.has(manifest)) {
      const fallback = runtimeEntrypointCandidates(runtimeId).find((candidate) => paths.has(candidate));
      return fallback ?? null;
    }
  }

  return null;
}

async function buildBundleFromRoot(rootDir: string, runtimeId: string): Promise<LocalFunctionBundle> {
  const config = await readBundleConfig(rootDir);
  const entries = await walkBundle(rootDir);
  const entrypoint = detectEntrypointPath(entries, runtimeId, config);
  if (!entrypoint) {
    throw new Error(`No pude detectar un entrypoint en ${rootDir}. Agrega vortex.json con { "entrypoint": "..." }.`);
  }

  const entrypointIndex = entries.findIndex(
    (entry) => entry.path === entrypoint && entry.kind === "file",
  );
  if (entrypointIndex >= 0) {
    const entrypointSource = entries[entrypointIndex].content;
    const sharedReferences = extractSharedReferences(runtimeId, entrypointSource);
    const sharedSourceRoot = await resolveSharedSourceRoot(runtimeId, rootDir, entrypoint, entrypointSource);
    if (sharedReferences.length > 0 && !sharedSourceRoot) {
      throw new Error(
        `El index ${path.join(rootDir, entrypoint)} importa _shared pero no encontré una carpeta compartida correspondiente.`,
      );
    }

    if (sharedSourceRoot) {
      const bundleSharedRootRelative = sharedBundleRootRelative(runtimeId, rootDir, sharedSourceRoot);

      if (runtimeId === "node" || runtimeId === "deno") {
        for (const spec of sharedReferences) {
          if (!spec.startsWith(".") && !spec.startsWith("/")) continue;
          const sharedTail = sharedTailFromSpecifier(spec);
          const expectedPath = path.join(sharedSourceRoot, sharedTail);
          if (!(await pathExists(expectedPath))) {
            throw new Error(
              `El index ${path.join(rootDir, entrypoint)} importa "${spec}" pero no existe dentro de ${sharedSourceRoot}.`,
            );
          }
        }
      }

      const sharedEntries = await walkBundleWithOptions(sharedSourceRoot, "", { includeSharedDir: true });
      const bundleEntries = new Map<string, LocalFileEntry>();
      for (const entry of entries) {
        bundleEntries.set(entry.path, entry);
      }
      for (const sharedEntry of sharedEntries) {
        const bundlePath = normalizeRelativePath(path.posix.join(bundleSharedRootRelative, sharedEntry.path));
        bundleEntries.set(bundlePath, { ...sharedEntry, path: bundlePath });
      }

      const entrypointDir = path.dirname(path.join(rootDir, entrypoint));
      const rewrittenEntry = {
        ...entries[entrypointIndex],
        content:
          runtimeId === "node" || runtimeId === "deno"
            ? rewriteSharedImports(entrypointSource, entrypointDir, rootDir, bundleSharedRootRelative)
            : entrypointSource,
      };
      bundleEntries.set(rewrittenEntry.path, rewrittenEntry);

      const mergedEntries = [...bundleEntries.values()];
      mergedEntries.sort((a, b) => a.path.localeCompare(b.path));
      entries.splice(0, entries.length, ...mergedEntries);
    }
  }

  const displayName = config?.name ?? path.basename(rootDir);
  const slug = slugify(config?.slug ?? config?.name ?? path.basename(rootDir));

  return {
    rootDir,
    displayName,
    slug,
    entrypoint,
    files: entries,
    config,
  };
}

function bundleLooksLikeSingleAppRoot(entries: LocalFileEntry[], runtimeId: string, config: LocalBundleConfig | null): boolean {
  const rootFiles = new Set(entries.filter((entry) => !entry.path.includes("/")).map((entry) => entry.path));
  if (detectEntrypointPath(entries, runtimeId, config)) return true;
  return isBundleRootManifests(rootFiles);
}

function collectImmediateSubdirs(entries: LocalFileEntry[]): string[] {
  const dirs = new Set<string>();
  for (const entry of entries) {
    const first = entry.path.includes("/")
      ? entry.path.split("/")[0]
      : entry.kind === "dir"
        ? entry.path
        : "";
    if (first) dirs.add(first);
  }
  return [...dirs];
}

export async function discoverLocalFunctionBundles({
  sourceRoot,
  runtimeId,
  functionName,
}: {
  sourceRoot: string;
  runtimeId: string;
  functionName?: string | null;
}): Promise<LocalFunctionBundle[]> {
  const absRoot = path.resolve(sourceRoot);
  const rootEntries = await walkBundle(absRoot);
  const rootConfig = await readBundleConfig(absRoot);
  const isSingleRoot = bundleLooksLikeSingleAppRoot(rootEntries, runtimeId, rootConfig);

  if (functionName) {
    if (isSingleRoot) {
      const bundle = await buildBundleFromRoot(absRoot, runtimeId);
      if (bundle.slug === slugify(functionName) || bundle.displayName.toLowerCase() === functionName.toLowerCase()) {
        return [bundle];
      }
      throw new Error(`El directorio ${absRoot} no coincide con la funcion "${functionName}".`);
    }

    const subdirNames = collectImmediateSubdirs(rootEntries);
    const match = subdirNames.find((name) => slugify(name) === slugify(functionName));
    if (!match) {
      throw new Error(`No encontre una carpeta para la funcion "${functionName}" dentro de ${absRoot}.`);
    }
    return [await buildBundleFromRoot(path.join(absRoot, match), runtimeId)];
  }

  if (isSingleRoot) {
    return [await buildBundleFromRoot(absRoot, runtimeId)];
  }

  const bundles: LocalFunctionBundle[] = [];
  for (const name of collectImmediateSubdirs(rootEntries)) {
    const child = path.join(absRoot, name);
    const childEntries = await walkBundle(child);
    const childConfig = await readBundleConfig(child);
    const entrypoint = detectEntrypointPath(childEntries, runtimeId, childConfig);
    if (!entrypoint) continue;
    bundles.push(await buildBundleFromRoot(child, runtimeId));
  }

  bundles.sort((a, b) => a.slug.localeCompare(b.slug));
  if (bundles.length === 0) {
    throw new Error(`No encontre funciones en ${absRoot}. Usa una carpeta por funcion con un entrypoint reconocible.`);
  }
  return bundles;
}
