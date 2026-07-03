import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toAbsolutePath(specifier, parentURL) {
  const parentDir = parentURL ? path.dirname(fileURLToPath(parentURL)) : process.cwd();
  return path.isAbsolute(specifier) ? specifier : path.resolve(parentDir, specifier);
}

export async function resolve(specifier, context, defaultResolve) {
  if (specifier.startsWith("node:") || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)) {
    return defaultResolve(specifier, context, defaultResolve);
  }

  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const candidates = [
      specifier,
      `${specifier}.ts`,
      `${specifier}.tsx`,
      `${specifier}.mts`,
      `${specifier}.js`,
      `${specifier}.mjs`,
      `${specifier}.cjs`,
    ];

    for (const candidate of candidates) {
      const abs = toAbsolutePath(candidate, context.parentURL);
      if (await exists(abs)) {
        return { url: pathToFileURL(abs).href, shortCircuit: true };
      }
    }
  }

  return defaultResolve(specifier, context, defaultResolve);
}

export async function load(url, context, defaultLoad) {
  if (url.endsWith(".ts") || url.endsWith(".tsx") || url.endsWith(".mts")) {
    const source = await fs.readFile(fileURLToPath(url), "utf8");
    const result = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        esModuleInterop: true,
        verbatimModuleSyntax: false,
      },
      fileName: fileURLToPath(url),
    });
    return { format: "module", source: result.outputText, shortCircuit: true };
  }

  return defaultLoad(url, context, defaultLoad);
}
