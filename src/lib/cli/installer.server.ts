import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

type InstallerFile = {
  path: string;
  content: string;
};

type InstallerPayload = {
  packageDir: string;
  rootScript: string;
  gitignoreEntry: string;
  rootFiles: InstallerFile[];
  packageJson: {
    name: string;
    private: boolean;
    type: "module";
    version: string;
    engines: { node: string };
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
  };
  files: InstallerFile[];
};

type PackageVersions = {
  typescript: string;
  neon: string;
};

const CLI_SOURCE_FILES = [
  "scripts/vortex-cli.ts",
  "scripts/register-ts-loader.mjs",
  "scripts/ts-loader.mjs",
  "src/lib/neon/db.server.ts",
  "src/lib/runtimes/index.ts",
  "src/lib/runtimes/runner-node.ts",
  "src/lib/runtimes/runner-python.ts",
  "src/lib/azure/aca.server.ts",
  "src/lib/api/deployments.shared.ts",
  "src/lib/cli/local-source.ts",
  "src/lib/cli/local-sync.server.ts",
  "src/lib/runner-source.generated.ts",
] as const;

const ROOT_SCRIPT =
  "node --import ./.vortex/cli/scripts/register-ts-loader.mjs ./.vortex/cli/scripts/vortex-cli.ts";

function findRepoRoot(startDir: string): string {
  let current = path.resolve(startDir);
  while (true) {
    const cliEntry = path.join(current, "scripts", "vortex-cli.ts");
    const dbEntry = path.join(current, "src", "lib", "neon", "db.server.ts");
    if (fs.existsSync(cliEntry) && fs.existsSync(dbEntry)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(startDir);
}

async function readPackageVersions(repoRoot: string): Promise<PackageVersions> {
  const fallback: PackageVersions = {
    typescript: "^5.8.3",
    neon: "^1.1.0",
  };

  try {
    const raw = await fsPromises.readFile(path.join(repoRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      typescript:
        parsed.devDependencies?.typescript ?? parsed.dependencies?.typescript ?? fallback.typescript,
      neon:
        parsed.dependencies?.["@neondatabase/serverless"] ??
        fallback.neon,
    };
  } catch {
    return fallback;
  }
}

async function readInstallerFiles(repoRoot: string): Promise<InstallerFile[]> {
  const files = await Promise.all(
    CLI_SOURCE_FILES.map(async (relPath) => {
      const absPath = path.join(repoRoot, relPath);
      const content = await fsPromises.readFile(absPath, "utf8");
      return {
        path: relPath,
        content,
      };
    }),
  );

  return files;
}

const INSTALLER_ENV_KEYS = [
  "NEON_DATABASE_URL_POOLER",
  "NEON_DATABASE_URL",
  "DATABASE_URL",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_SUBSCRIPTION_ID",
  "AZURE_RESOURCE_GROUP",
  "AZURE_ACA_ENVIRONMENT",
  "AZURE_LOCATION",
  "FN_RUNNER_IMAGE",
] as const;

function escapeEnvValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildInstallerEnvFile(): InstallerFile | null {
  const lines: string[] = [];

  for (const key of INSTALLER_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (!value) continue;
    lines.push(`${key}="${escapeEnvValue(value)}"`);
  }

  if (!lines.length) return null;

  return {
    path: ".vortex/.env",
    content: `${lines.join("\n")}\n`,
  };
}

function renderInstallerScript(payload: InstallerPayload): string {
  const serialized = JSON.stringify(payload, null, 2);

  return `#!/usr/bin/env node
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const PAYLOAD = ${serialized};

function log(message) {
  console.log(\`[vortex] \${message}\`);
}

function warn(message) {
  console.warn(\`[vortex] \${message}\`);
}

async function writeTextFile(targetPath, content) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf8");
}

async function appendGitignoreEntry(rootDir, entry) {
  const gitignorePath = path.join(rootDir, ".gitignore");
  let current = "";
  if (fsSync.existsSync(gitignorePath)) {
    current = await fs.readFile(gitignorePath, "utf8");
  }

  const lines = current.split(/\\r?\\n/).map((line) => line.trim());
  if (lines.includes(entry)) return false;

  const next = current && !current.endsWith("\\n") ? \`\${current}\\n\` : current;
  await fs.writeFile(gitignorePath, \`\${next}\${entry}\\n\`, "utf8");
  return true;
}

async function ensureRootScript(rootDir, rootScript) {
  const pkgPath = path.join(rootDir, "package.json");
  if (!fsSync.existsSync(pkgPath)) {
    warn("No package.json found in the current folder; skipping npm script injection.");
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  } catch (error) {
    warn(\`package.json could not be parsed, leaving it untouched: \${error instanceof Error ? error.message : String(error)}\`);
    return;
  }

  if (!parsed || typeof parsed !== "object") {
    warn("package.json does not contain a JSON object; leaving it untouched.");
    return;
  }

  parsed.scripts ??= {};
  if (typeof parsed.scripts !== "object") {
    parsed.scripts = {};
  }

  if (!parsed.scripts.vortex) {
    parsed.scripts.vortex = rootScript;
    await fs.writeFile(pkgPath, \`\${JSON.stringify(parsed, null, 2)}\\n\`, "utf8");
    log("Added npm script: vortex");
    return;
  }

  if (parsed.scripts.vortex !== rootScript) {
    warn("package.json already has a different vortex script. Leaving it unchanged.");
  }
}

async function installCliDependencies(cliDir) {
  const nodeModulesPath = path.join(cliDir, "node_modules");
  if (fsSync.existsSync(nodeModulesPath)) {
    log("CLI dependencies already installed, skipping npm install.");
    return;
  }

  const args = [
    "install",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
  ];

  log("Installing CLI dependencies with npm...");
  execSync(\`npm \${args.join(" ")}\`, { cwd: cliDir, stdio: "inherit" });
}

async function main() {
  const rootDir = process.cwd();
  const cliDir = path.join(rootDir, PAYLOAD.packageDir);
  const force = process.argv.includes("--force") || process.argv.includes("--reinstall");

  log(\`Installing Vortex CLI into \${path.relative(rootDir, cliDir) || PAYLOAD.packageDir}\`);

  await fs.mkdir(cliDir, { recursive: true });
  for (const file of PAYLOAD.files) {
    await writeTextFile(path.join(cliDir, file.path), file.content);
  }

  await writeTextFile(path.join(cliDir, "package.json"), \`\${JSON.stringify(PAYLOAD.packageJson, null, 2)}\\n\`);
  const gitignoreUpdated = await appendGitignoreEntry(rootDir, PAYLOAD.gitignoreEntry);
  if (gitignoreUpdated) {
    log(\`Updated .gitignore with \${PAYLOAD.gitignoreEntry}\`);
  }

  for (const file of PAYLOAD.rootFiles) {
    await writeTextFile(path.join(rootDir, file.path), file.content);
  }

  await ensureRootScript(rootDir, PAYLOAD.rootScript);

  if (force && fsSync.existsSync(path.join(cliDir, "node_modules"))) {
    await fs.rm(path.join(cliDir, "node_modules"), { recursive: true, force: true });
  }

  await installCliDependencies(cliDir);

  log("Installation complete.");
  log("Run: npm run vortex -- --help");
  log("Then link a platform project with: npm run vortex -- link --project-id <uuid> --source-root functions");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exitCode = 1;
});
`;
}

export async function buildVortexInstallerScript(): Promise<{ filename: string; script: string }> {
  const repoRoot = findRepoRoot(process.cwd());
  const versions = await readPackageVersions(repoRoot);
  const files = await readInstallerFiles(repoRoot);
  const rootEnvFile = buildInstallerEnvFile();

  const payload: InstallerPayload = {
    packageDir: ".vortex/cli",
    rootScript: ROOT_SCRIPT,
    gitignoreEntry: ".vortex/",
    rootFiles: rootEnvFile ? [rootEnvFile] : [],
    packageJson: {
      name: "vortex-local-cli",
      private: true,
      type: "module",
      version: "0.0.0",
      engines: {
        node: ">=20",
      },
      scripts: {
        vortex: "node --import ./scripts/register-ts-loader.mjs ./scripts/vortex-cli.ts",
      },
      dependencies: {
        "@neondatabase/serverless": versions.neon,
        typescript: versions.typescript,
      },
    },
    files,
  };

  return {
    filename: "vortex-install.mjs",
    script: renderInstallerScript(payload),
  };
}
