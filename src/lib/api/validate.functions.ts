import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuthSystemAuth } from "@/lib/auth/server-middleware";
import { sql, ensureSchema, logEvent } from "@/lib/neon/db.server";
import { getRuntimeConfig } from "@/lib/runtimes";

function normalizeJavaPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function javaPackageFromPath(path: string): string | null {
  const normalized = normalizeJavaPath(path);
  const prefix = "src/main/java/";
  if (!normalized.startsWith(prefix) || !normalized.endsWith(".java")) return null;
  const relative = normalized.slice(prefix.length);
  const parts = relative.split("/").filter(Boolean);
  if (!parts.length) return null;
  return parts.slice(0, -1).join(".");
}

function javaDeclaredPackage(content: string): string | null {
  const match = content.match(/^\s*package\s+([A-Za-z_][\w.]*)\s*;\s*$/m);
  return match?.[1] ?? null;
}

function javaPublicTypeName(content: string): string | null {
  const match = content.match(
    /^\s*public\s+(?:(?:abstract|final|sealed|non-sealed)\s+)?(?:class|interface|enum|record)\s+([A-Za-z_][\w]*)\b/m,
  );
  return match?.[1] ?? null;
}

function validateJavaStructure(files: Array<{ path: string; content: string }>): string | null {
  for (const file of files) {
    if (!normalizeJavaPath(file.path).endsWith(".java")) continue;
    const expectedPackage = javaPackageFromPath(file.path);
    const declaredPackage = javaDeclaredPackage(file.content);
    if ((declaredPackage ?? "") !== (expectedPackage ?? "")) {
      return expectedPackage
        ? `El archivo ${file.path} declara package ${declaredPackage ?? "(sin package)"} pero su ruta exige package ${expectedPackage}.`
        : `El archivo ${file.path} declara package ${declaredPackage ?? "(sin package)"} pero está en src/main/java sin carpeta de package.`;
    }

    const publicType = javaPublicTypeName(file.content);
    if (publicType) {
      const fileName = normalizeJavaPath(file.path)
        .split("/")
        .pop()
        ?.replace(/\.java$/i, "");
      if (fileName && fileName !== publicType) {
        return `El archivo ${file.path} contiene un tipo público ${publicType}. En Java el nombre del archivo debe coincidir: ${publicType}.java.`;
      }
    }
  }

  return null;
}

function validateJavaApplicationProperties(
  files: Array<{ path: string; content: string }>,
): string | null {
  const props = files.find(
    (file) => normalizeJavaPath(file.path) === "src/main/resources/application.properties",
  );
  if (!props) return null;

  if (/jdbc:h2:/i.test(props.content)) {
    return [
      "Java debe usar la conexion definida en Secrets y no un fallback a H2.",
      "Deja spring.datasource.url=${SPRING_DATASOURCE_URL} y elimina cualquier jdbc:h2 del application.properties.",
    ].join(" ");
  }

  if (
    /^\s*spring\.datasource\.url\s*=\s*\$\{\s*SPRING_DATASOURCE_URL\s*:\s*/m.test(props.content)
  ) {
    return [
      "spring.datasource.url no debe tener fallback en Java.",
      "Usa spring.datasource.url=${SPRING_DATASOURCE_URL} para forzar la conexion configurada en Secrets.",
    ].join(" ");
  }

  if (/^\s*app\.api\.keys\s*=\s*\$\{\s*app\.api\.keys\s*:/m.test(props.content)) {
    return [
      "application.properties no debe referenciar app.api.keys a sí misma.",
      "Usa app.api.keys=${API_KEY:} o elimina esa línea; la API key se inyecta desde Tokens.",
    ].join(" ");
  }

  return null;
}

export const validateFunction = createServerFn({ method: "POST" })
  .middleware([requireAuthSystemAuth])
  .inputValidator((d) => z.object({ functionId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const expectedRunnerVersion = "2026-05-31-deno-serve-stub-preinstall";
    await ensureSchema();
    const s = sql();
    const fns =
      (await s`SELECT f.id, f.name, f.slug, f.entrypoint, f.project_id, p.fqdn, p.admin_token, p.runtime
      FROM functions f JOIN projects p ON p.id = f.project_id
      WHERE f.id = ${data.functionId} AND f.owner_id = ${context.userId} LIMIT 1`) as Array<{
        id: string;
        name: string;
        slug: string;
        entrypoint: string;
        project_id: string;
        fqdn: string | null;
        admin_token: string | null;
        runtime: string | null;
      }>;
    if (!fns[0]) throw new Error("Function not found");
    const fn = fns[0];
    const runtime = getRuntimeConfig(fn.runtime);
    if (!fn.fqdn || !fn.admin_token) {
      await logEvent(
        fn.project_id,
        context.userId,
        "warn",
        "validate",
        `Validate "${fn.name}" - proyecto sin desplegar`,
      );
      return {
        ok: false,
        error:
          "El proyecto aun no esta desplegado. Haz un primer deploy para activar la validacion en caliente.",
      };
    }
    const files =
      (await s`SELECT path, content, kind FROM function_files WHERE function_id = ${fn.id}`) as Array<{
        path: string;
        content: string;
        kind: string;
      }>;
    const sourceFiles = files.filter((file) => file.kind !== "dir");
    if (!sourceFiles.length) return { ok: false, error: "La funcion no tiene ficheros." };

    if (runtime.id === "java") {
      const javaError = validateJavaStructure(sourceFiles);
      if (javaError) {
        await logEvent(
          fn.project_id,
          context.userId,
          "warn",
          "validate",
          "Java structure invalid",
          {
            function: fn.name,
            error: javaError,
          },
        );
        return { ok: false, error: javaError };
      }

      const javaPropsError = validateJavaApplicationProperties(sourceFiles);
      if (javaPropsError) {
        await logEvent(
          fn.project_id,
          context.userId,
          "warn",
          "validate",
          "Java application.properties invalid",
          {
            function: fn.name,
            error: javaPropsError,
          },
        );
        return { ok: false, error: javaPropsError };
      }
    }

    const url = `https://${fn.fqdn}/__validate`;
    const healthUrl = `https://${fn.fqdn}/__health`;
    const startedAt = Date.now();
    await logEvent(fn.project_id, context.userId, "info", "validate", `-> POST ${url}`, {
      function: fn.name,
      files: sourceFiles.length,
      entrypoint: fn.entrypoint || "index.ts",
    });

    try {
      const health = await fetch(healthUrl, { method: "GET" });
      const healthText = await health.text();
      if (!health.ok) {
        const error =
          "No se pudo validar porque el contenedor no responde. Haz Deploy para levantarlo de nuevo y vuelve a probar.";
        await logEvent(fn.project_id, context.userId, "warn", "validate", "Health check failed", {
          function: fn.name,
          health: healthText.slice(0, 300),
          runtime: runtime.id,
        });
        return { ok: false, error };
      }

      if (runtime.id !== "deno") {
        await logEvent(
          fn.project_id,
          context.userId,
          "info",
          "validate",
          "Runtime no-Deno: validation reduced to health check",
          {
            function: fn.name,
            runtime: runtime.id,
          },
        );
        return { ok: true };
      }

      if (!healthText.includes(expectedRunnerVersion)) {
        const error =
          "El contenedor todavia esta ejecutando una version anterior del runner. Haz Deploy para reiniciar el contenedor con la correccion de Deno.serve y luego vuelve a validar.";
        await logEvent(fn.project_id, context.userId, "warn", "validate", "Runner desactualizado", {
          function: fn.name,
          health: healthText.slice(0, 300),
          expected: expectedRunnerVersion,
        });
        return { ok: false, error };
      }

      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": fn.admin_token },
        body: JSON.stringify({ files, entrypoint: fn.entrypoint || "index.ts", functionId: fn.id }),
      });
      const text = await res.text();
      let json: { ok: boolean; error?: string };
      try {
        json = JSON.parse(text);
      } catch {
        json = { ok: false, error: `Respuesta no JSON (${res.status}): ${text.slice(0, 500)}` };
      }

      const ms = Date.now() - startedAt;
      await logEvent(
        fn.project_id,
        context.userId,
        json.ok ? "info" : "warn",
        "validate",
        `<= ${res.status} ${json.ok ? "OK" : "FAIL"} (${ms}ms)`,
        { function: fn.name, response: text.slice(0, 2000) },
      );
      return json;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logEvent(
        fn.project_id,
        context.userId,
        "error",
        "validate",
        "Fallo de red contactando contenedor",
        { error: msg, url },
      );
      return { ok: false, error: `No se pudo contactar con el contenedor: ${msg}` };
    }
  });
