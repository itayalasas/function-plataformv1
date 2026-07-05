// Registry of supported runtimes for project deployments.
// Each runtime knows its base image, startup script, resources, health path,
// default file template, and Monaco language hint.
//
// IMPORTANT: only "deno" keeps hot-reload (current Deno runner pulls code
// from Neon at runtime). All other runtimes bundle files at deploy time via
// FILES_B64 env var — code changes require a redeploy.

export type RuntimeId = "deno" | "node" | "python" | "java" | "dotnet";

export const RUNTIMES: RuntimeId[] = ["deno", "node", "python", "java", "dotnet"];

export interface RuntimeConfig {
  id: RuntimeId;
  label: string;
  description: string;
  image: string;
  /** Container target port. Always 8000 for our runners except where the framework forces another (Spring/.NET use 8000 too). */
  port: number;
  cpu: number;
  /** ACA memory string, e.g. "1Gi", "2Gi". */
  memory: string;
  /** HTTP path for liveness/startup probes. */
  healthPath: string;
  /** Initial delay for startup probe in seconds (Java/.NET need longer because of build-at-boot). */
  startupInitialDelaySeconds: number;
  /** failureThreshold * periodSeconds = max cold-start budget. */
  startupFailureThreshold: number;
  startupPeriodSeconds: number;
  /** Default entrypoint filename shown in editor / used by createFunction. */
  defaultEntrypoint: string;
  /** Monaco language id (for the editor). */
  monacoLanguage: string;
  /** True when the runtime supports multi-function routing /{slug}/... handled by the runner. */
  multiFunction: boolean;
  /** True when code changes require redeploy (everything except Deno). */
  requiresRedeploy: boolean;
  /** Default starter file(s) seeded when a function is created. */
  starterFiles: Array<{ path: string; content: string }>;
  /** Shell script the container runs at boot. Receives RUNNER_SCRIPT_B64 (interpreted runners) and FILES_B64. */
  startupScript: string;
}

function startupNode(): string {
  return [
    "set -e",
    'echo "[boot] node container starting $(date -u +%FT%TZ)"',
    "mkdir -p /app/src",
    "cd /app",
    'if [ -z "$RUNNER_SCRIPT_B64" ]; then echo "[FATAL] RUNNER_SCRIPT_B64 missing"; exit 1; fi',
    'printf "%s" "$RUNNER_SCRIPT_B64" | base64 -d > /app/runner.cjs',
    'echo "[boot] runner.cjs: $(wc -c < /app/runner.cjs) bytes"',
    'if [ -n "$FILES_B64" ]; then printf "%s" "$FILES_B64" | base64 -d > /tmp/files.json; else echo "[]" > /tmp/files.json; fi',
    'node -e "const fs=require(\\"fs\\"),p=require(\\"path\\");const a=JSON.parse(fs.readFileSync(\\"/tmp/files.json\\",\\"utf8\\"));const entrypoints={};for(const f of a){const full=p.join(\\"/app/src\\",f.slug,f.path);if(f.entrypoint) entrypoints[f.slug]=f.entrypoint;if(f.kind===\\"dir\\"){fs.mkdirSync(full,{recursive:true});continue;}fs.mkdirSync(p.dirname(full),{recursive:true});fs.writeFileSync(full,f.content);}for(const [slug,entry] of Object.entries(entrypoints)){if(!entry) continue;const manifest=p.join(\\"/app/src\\",slug,\\".vortex-entrypoint\\");fs.mkdirSync(p.dirname(manifest),{recursive:true});fs.writeFileSync(manifest,entry);}console.log(\\"[boot] extracted \\"+a.length+\\" file(s)\\");"',
    'echo "[boot] launching node runner"',
    "exec node /app/runner.cjs",
  ].join("; ");
}

function startupPython(): string {
  return [
    "set -e",
    'echo "[boot] python container starting $(date -u +%FT%TZ)"',
    "mkdir -p /app/src",
    "cd /app",
    'if [ -z "$RUNNER_SCRIPT_B64" ]; then echo "[FATAL] RUNNER_SCRIPT_B64 missing"; exit 1; fi',
    'printf "%s" "$RUNNER_SCRIPT_B64" | base64 -d > /app/runner.py',
    'echo "[boot] runner.py: $(wc -c < /app/runner.py) bytes"',
    'if [ -n "$FILES_B64" ]; then printf "%s" "$FILES_B64" | base64 -d > /tmp/files.json; else echo "[]" > /tmp/files.json; fi',
    `python3 - <<'PY'
import json
import os

with open("/tmp/files.json", "r", encoding="utf-8") as fh:
    files = json.load(fh)

entrypoints = {}
for f in files:
    slug = f["slug"]
    full = os.path.join("/app/src", slug, f["path"])
    entrypoint = f.get("entrypoint")
    if entrypoint:
        entrypoints[slug] = entrypoint
    if f.get("kind") == "dir":
        os.makedirs(full, exist_ok=True)
        continue
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as out:
        out.write(f.get("content", ""))

for slug, entry in entrypoints.items():
    if not entry:
        continue
    manifest = os.path.join("/app/src", slug, ".vortex-entrypoint")
    os.makedirs(os.path.dirname(manifest), exist_ok=True)
    with open(manifest, "w", encoding="utf-8") as out:
        out.write(entry)

print("[boot] extracted", len(files), "file(s)")
PY
`,
    'echo "[boot] launching python runner"',
    "exec python3 /app/runner.py",
  ].join("; ");
}

function startupJava(): string {
  // Image is maven:3.9-eclipse-temurin-21-alpine which has mvn + JDK21, but
  // `java` is only available under /opt/java/openjdk/bin, not always on PATH.
  return [
    "set -e",
    'echo "[boot] java/spring-boot container starting $(date -u +%FT%TZ)"',
    "mkdir -p /app/build",
    "cd /app/build",
    "find /app/build -mindepth 1 -maxdepth 1 -exec rm -rf {} +",
    'if [ -z "$FILES_B64" ]; then echo "[FATAL] FILES_B64 missing — Java project has no source"; exit 1; fi',
    'printf "%s" "$FILES_B64" | base64 -d > /tmp/files.json',
    // Extract files: ignore slug — treat entire bundle as ONE project. Use the FIRST function's tree (project = single Spring Boot app).
    "apk add --no-cache jq curl netcat-openbsd >/dev/null 2>&1 || true",
    'seen=/tmp/java-seen-paths.txt; : > "$seen"; jq -c ".[]" /tmp/files.json | while IFS= read -r row; do kind=$(echo "$row" | jq -r \'.kind // "file"\'); path=$(echo "$row" | jq -r \'.path\'); if grep -Fxq "$path" "$seen"; then echo "[boot] skipping duplicate path $path"; continue; fi; printf "%s\\n" "$path" >> "$seen"; if [ "$kind" = "dir" ]; then mkdir -p "$path"; else content=$(echo "$row" | jq -r \'.content\'); mkdir -p "$(dirname "$path")"; printf "%s" "$content" > "$path"; fi; done',
    'echo "[boot] extracted java sources"; ls -R /app/build | head -50; (while [ ! -f /tmp/build-done ]; do (printf \'HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n{"status":"building"}\' | nc -l -p 8000 -q 1 >/dev/null 2>&1) || sleep 1; done) & echo "[boot] running mvn package (this may take 1-3 min)"',
    `JAVA_APP_FILE=$(find /app/build/src/main/java -name App.java | head -n1)
if [ -n "$JAVA_APP_FILE" ]; then
  JAVA_APP_DIR=$(dirname "$JAVA_APP_FILE")
  JAVA_APP_PACKAGE_PATH=$(printf '%s' "$JAVA_APP_FILE" | sed 's#^/app/build/src/main/java/##; s#/App.java$##')
  JAVA_APP_PACKAGE=$(printf '%s' "$JAVA_APP_PACKAGE_PATH" | tr '/' '.')
  if [ -n "$JAVA_APP_PACKAGE" ]; then
    JAVA_RUNTIME_DIR="$JAVA_APP_DIR/logging"
    mkdir -p "$JAVA_RUNTIME_DIR"
    cat > "$JAVA_RUNTIME_DIR/RuntimeLoggingFilter.java" <<'JAVA'
package __JAVA_RUNTIME_PACKAGE__.logging;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.ContentCachingRequestWrapper;
import org.springframework.web.filter.ContentCachingResponseWrapper;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.Map;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RuntimeLoggingFilter extends OncePerRequestFilter {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final HttpClient CLIENT = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    private static final int LIMIT = 8000;
    private final String ingestUrl = System.getenv("VORTEX_LOG_INGEST_URL");
    private final String token = System.getenv("VORTEX_LOG_TOKEN");
    private final String projectId = System.getenv("PROJECT_ID");

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return ingestUrl == null || ingestUrl.isBlank() || token == null || token.isBlank() || projectId == null || projectId.isBlank();
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {
        ContentCachingRequestWrapper requestWrapper = new ContentCachingRequestWrapper(request);
        ContentCachingResponseWrapper responseWrapper = new ContentCachingResponseWrapper(response);
        long startedAt = System.currentTimeMillis();
        Exception error = null;
        try {
            filterChain.doFilter(requestWrapper, responseWrapper);
        } catch (Exception e) {
            error = e;
            if (!responseWrapper.isCommitted()) {
                responseWrapper.setStatus(HttpServletResponse.SC_INTERNAL_SERVER_ERROR);
            }
            if (e instanceof ServletException servletException) throw servletException;
            if (e instanceof IOException ioException) throw ioException;
            throw new ServletException(e);
        } finally {
            try {
                String requestBody = trimText(new String(requestWrapper.getContentAsByteArray(), StandardCharsets.UTF_8));
                String responseBody = trimText(new String(responseWrapper.getContentAsByteArray(), StandardCharsets.UTF_8));
                Map<String, Object> payload = new LinkedHashMap<>();
                payload.put("projectId", projectId);
                payload.put("token", token);
                payload.put("level", error != null ? "error" : (responseWrapper.getStatus() >= 400 ? "warn" : "info"));
                payload.put("source", "runtime");
                payload.put("message", "-> " + request.getMethod() + " " + requestPath(request) + " | <- " + (error != null ? "ERR" : responseWrapper.getStatus()) + " (" + (System.currentTimeMillis() - startedAt) + "ms)");

                Map<String, Object> meta = new LinkedHashMap<>();
                meta.put("runtime", "java");
                meta.put("function", request.getRequestURI());
                meta.put("request", requestPayload(request, requestBody));
                meta.put("response", responsePayload(responseWrapper, responseBody));
                meta.put("durationMs", System.currentTimeMillis() - startedAt);
                if (error != null) {
                    meta.put("error", error.getMessage());
                }
                payload.put("meta", meta);

                sendRuntimeLog(payload);
            } finally {
                responseWrapper.copyBodyToResponse();
            }
        }
    }

    private static Map<String, Object> requestPayload(HttpServletRequest request, String requestBody) {
        Map<String, Object> requestPayload = new LinkedHashMap<>();
        requestPayload.put("method", request.getMethod());
        requestPayload.put("path", requestPath(request));
        requestPayload.put("headers", redactHeaders(request));
        requestPayload.put("body", requestBody.isEmpty() ? null : requestBody);
        Map<String, Object> query = new LinkedHashMap<>();
        if (request.getParameterMap() != null) {
            for (Map.Entry<String, String[]> entry : request.getParameterMap().entrySet()) {
                String[] values = entry.getValue();
                if (values == null || values.length == 0) {
                    query.put(entry.getKey(), "");
                } else if (values.length == 1) {
                    query.put(entry.getKey(), values[0]);
                } else {
                    query.put(entry.getKey(), values);
                }
            }
        }
        requestPayload.put("query", query);
        return requestPayload;
    }

    private static Map<String, Object> responsePayload(ContentCachingResponseWrapper response, String responseBody) {
        Map<String, Object> responsePayload = new LinkedHashMap<>();
        responsePayload.put("status", response.getStatus());
        responsePayload.put("headers", redactHeaders(response));
        responsePayload.put("body", responseBody);
        return responsePayload;
    }

    private static String requestPath(HttpServletRequest request) {
        String query = request.getQueryString();
        return request.getRequestURI() + (query == null || query.isBlank() ? "" : "?" + query);
    }

    private static Map<String, Object> redactHeaders(HttpServletRequest request) {
        Map<String, Object> headers = new LinkedHashMap<>();
        Enumeration<String> names = request.getHeaderNames();
        if (names == null) return headers;
        while (names.hasMoreElements()) {
            String name = names.nextElement();
            headers.put(name, redactHeaderValue(name, request.getHeader(name)));
        }
        return headers;
    }

    private static Map<String, Object> redactHeaders(ContentCachingResponseWrapper response) {
        Map<String, Object> headers = new LinkedHashMap<>();
        for (String name : response.getHeaderNames()) {
            headers.put(name, redactHeaderValue(name, response.getHeader(name)));
        }
        return headers;
    }

    private static Object redactHeaderValue(String name, String value) {
        if (name == null) return value;
        String normalized = name.toLowerCase();
        if (normalized.equals("authorization") || normalized.equals("x-api-key") || normalized.equals("x-admin-token") || normalized.equals("x-vortex-log-token")) {
            return "[redacted]";
        }
        return value;
    }

    private static String trimText(String value) {
        if (value == null) return "";
        if (value.length() <= LIMIT) return value;
        return value.substring(0, LIMIT) + "... [truncated " + (value.length() - LIMIT) + " chars]";
    }

    private void sendRuntimeLog(Map<String, Object> payload) {
        try {
            String json = MAPPER.writeValueAsString(payload);
            HttpRequest request = HttpRequest.newBuilder(URI.create(ingestUrl))
                    .header("content-type", "application/json")
                    .header("x-vortex-log-token", token)
                    .timeout(Duration.ofSeconds(3))
                    .POST(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8))
                    .build();
            CLIENT.sendAsync(request, HttpResponse.BodyHandlers.discarding())
                    .exceptionally(error -> {
                        System.out.println("[runner] failed to send runtime log: " + error);
                        return null;
                    });
        } catch (Exception error) {
            System.out.println("[runner] failed to send runtime log: " + error);
        }
    }
}
JAVA
    perl -0pi -e "s/__JAVA_RUNTIME_PACKAGE__/$JAVA_APP_PACKAGE/g" "$JAVA_RUNTIME_DIR/RuntimeLoggingFilter.java"
    echo "[boot] injected Java runtime logging filter"
  else
    echo "[boot][warn] Java App.java found but package path was empty; skipping runtime logging filter injection"
  fi
else
  echo "[boot][warn] no App.java found; skipping runtime logging filter injection"
fi`,
    "mvn -B -q -DskipTests clean package",
    "touch /tmp/build-done; sleep 1; pkill -f 'nc -l -p 8000' >/dev/null 2>&1 || true",
    'JAR=$(ls target/*.jar 2>/dev/null | grep -v "original" | head -n1)',
    'if [ -z "$JAR" ]; then echo "[FATAL] no JAR built in target/"; ls -la target/ 2>&1; exit 1; fi',
    'echo "[boot] launching $JAR"',
    'export JAVA_HOME="${JAVA_HOME:-/opt/java/openjdk}"',
    'export PATH="$JAVA_HOME/bin:$PATH"',
    'exec java -jar "$JAR" --server.port=8000',
  ].join("; ");
}

function startupDotnet(): string {
  // Image: mcr.microsoft.com/dotnet/sdk:8.0
  return [
    "set -e",
    'echo "[boot] .NET container starting $(date -u +%FT%TZ)"',
    "mkdir -p /app/build /app/publish",
    "cd /app/build",
    'if [ -z "$FILES_B64" ]; then echo "[FATAL] FILES_B64 missing — .NET project has no source"; exit 1; fi',
    'printf "%s" "$FILES_B64" | base64 -d > /tmp/files.json',
    "apt-get update -qq && apt-get install -y -qq jq netcat-openbsd >/dev/null 2>&1 || true",
    'jq -c ".[]" /tmp/files.json | while IFS= read -r row; do kind=$(echo "$row" | jq -r ".kind // \\"file\\""); path=$(echo "$row" | jq -r ".path"); if [ "$kind" = "dir" ]; then mkdir -p "$path"; else content=$(echo "$row" | jq -r ".content"); mkdir -p "$(dirname "$path")"; printf "%s" "$content" > "$path"; fi; done',
    'echo "[boot] extracted .NET sources"; ls -R /app/build | head -50; (while [ ! -f /tmp/build-done ]; do (printf \'HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n{"status":"building"}\' | nc -l -p 8000 -q 1 >/dev/null 2>&1) || sleep 1; done) & echo "[boot] running dotnet publish (this may take 1-2 min)"',
    `DOTNET_PROGRAM_FILE=$(find /app/build -name Program.cs | head -n1)
if [ -n "$DOTNET_PROGRAM_FILE" ]; then
  DOTNET_PROJECT_DIR=$(dirname "$DOTNET_PROGRAM_FILE")
  if ! grep -q "UseRuntimeLogging" "$DOTNET_PROGRAM_FILE"; then
    cat > "$DOTNET_PROJECT_DIR/RuntimeLogging.cs" <<'CS'
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;

namespace VortexRuntime;

public static class RuntimeLoggingExtensions
{
    private const int LIMIT = 8000;
    private static readonly HttpClient Client = new()
    {
        Timeout = TimeSpan.FromSeconds(3)
    };

    public static WebApplication UseRuntimeLogging(this WebApplication app)
    {
        var ingestUrl = Environment.GetEnvironmentVariable("VORTEX_LOG_INGEST_URL");
        var token = Environment.GetEnvironmentVariable("VORTEX_LOG_TOKEN");
        var projectId = Environment.GetEnvironmentVariable("PROJECT_ID");
        if (string.IsNullOrWhiteSpace(ingestUrl) || string.IsNullOrWhiteSpace(token) || string.IsNullOrWhiteSpace(projectId))
        {
            return app;
        }

        app.Use(async (context, next) =>
        {
            var startedAt = DateTimeOffset.UtcNow;
            context.Request.EnableBuffering();
            var requestBody = await ReadBodyAsync(context.Request.Body);
            context.Request.Body.Position = 0;

            var originalBody = context.Response.Body;
            await using var responseBuffer = new MemoryStream();
            context.Response.Body = responseBuffer;

            Exception? error = null;
            try
            {
                await next();
            }
            catch (Exception ex)
            {
                error = ex;
                if (!context.Response.HasStarted)
                {
                    context.Response.StatusCode = StatusCodes.Status500InternalServerError;
                }
                throw;
            }
            finally
            {
                try
                {
                    responseBuffer.Position = 0;
                    var responseBody = await ReadBodyAsync(responseBuffer);
                    var durationMs = (long)(DateTimeOffset.UtcNow - startedAt).TotalMilliseconds;
                    var requestPath = context.Request.Path + context.Request.QueryString;
                    var payload = BuildPayload(
                        projectId,
                        token,
                        context.Request.Method,
                        requestPath,
                        requestBody,
                        context.Request.Headers,
                        context.Response.StatusCode,
                        context.Response.Headers,
                        responseBody,
                        durationMs,
                        error
                    );
                    _ = SendRuntimeLogAsync(ingestUrl, token, payload);
                    responseBuffer.Position = 0;
                    await responseBuffer.CopyToAsync(originalBody);
                }
                finally
                {
                    context.Response.Body = originalBody;
                }
            }
        });

        return app;
    }

    private static Dictionary<string, object?> BuildPayload(
        string projectId,
        string token,
        string method,
        string requestPath,
        string requestBody,
        IHeaderDictionary requestHeaders,
        int statusCode,
        IHeaderDictionary responseHeaders,
        string responseBody,
        long durationMs,
        Exception? error
    )
    {
        var payload = new Dictionary<string, object?>
        {
            ["projectId"] = projectId,
            ["token"] = token,
            ["level"] = error != null ? "error" : statusCode >= 400 ? "warn" : "info",
            ["source"] = "runtime",
            ["message"] = "-> " + method + " " + requestPath + " | <- " + (error != null ? "ERR" : statusCode) + " (" + durationMs + "ms)",
        };

        var request = new Dictionary<string, object?>
        {
            ["method"] = method,
            ["path"] = requestPath,
            ["headers"] = RedactHeaders(requestHeaders),
            ["body"] = string.IsNullOrWhiteSpace(requestBody) ? null : TrimText(requestBody),
            ["query"] = RequestQuery(requestPath),
        };

        var response = new Dictionary<string, object?>
        {
            ["status"] = statusCode,
            ["headers"] = RedactHeaders(responseHeaders),
            ["body"] = TrimText(responseBody),
        };

        var meta = new Dictionary<string, object?>
        {
            ["runtime"] = "dotnet",
            ["function"] = requestPath,
            ["request"] = request,
            ["response"] = response,
            ["durationMs"] = durationMs,
        };

        if (error != null)
        {
            meta["error"] = error.Message;
        }

        payload["meta"] = meta;
        return payload;
    }

    private static Dictionary<string, object?> RequestQuery(string requestPath)
    {
        var query = new Dictionary<string, object?>();
        var index = requestPath.IndexOf('?');
        if (index < 0 || index + 1 >= requestPath.Length)
        {
            return query;
        }

        var raw = requestPath[(index + 1)..];
        foreach (var pair in raw.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            var key = Uri.UnescapeDataString(parts[0]);
            var value = parts.Length > 1 ? Uri.UnescapeDataString(parts[1]) : "";
            query[key] = value;
        }
        return query;
    }

    private static Dictionary<string, object?> RedactHeaders(IHeaderDictionary headers)
    {
        var redacted = new Dictionary<string, object?>();
        foreach (var header in headers)
        {
            redacted[header.Key] = RedactHeaderValue(header.Key, header.Value.ToString());
        }
        return redacted;
    }

    private static object RedactHeaderValue(string name, string? value)
    {
        var normalized = name.ToLowerInvariant();
        if (normalized is "authorization" or "x-api-key" or "x-admin-token" or "x-vortex-log-token")
        {
            return "[redacted]";
        }
        return value ?? "";
    }

    private static string TrimText(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return "";
        }

        if (value.Length <= LIMIT)
        {
            return value;
        }

        return value[..LIMIT] + "... [truncated " + (value.Length - LIMIT) + " chars]";
    }

    private static async Task<string> ReadBodyAsync(Stream stream)
    {
        using var reader = new StreamReader(stream, Encoding.UTF8, leaveOpen: true);
        var text = await reader.ReadToEndAsync();
        return TrimText(text);
    }

    private static async Task SendRuntimeLogAsync(string ingestUrl, string token, Dictionary<string, object?> payload)
    {
        try
        {
            var json = JsonSerializer.Serialize(payload);
            using var request = new HttpRequestMessage(HttpMethod.Post, ingestUrl);
            request.Headers.TryAddWithoutValidation("x-vortex-log-token", token);
            request.Content = new StringContent(json, Encoding.UTF8, "application/json");
            using var response = await Client.SendAsync(request);
            _ = await response.Content.ReadAsStringAsync();
        }
        catch (Exception error)
        {
            Console.WriteLine("[runner] failed to send runtime log: " + error.Message);
        }
    }
}
CS
    perl -0pi -e "s/^/using VortexRuntime;\\n\\n/" "$DOTNET_PROGRAM_FILE"
    perl -0pi -e "s/var app = builder.Build\\(\\);/var app = builder.Build();\\napp.UseRuntimeLogging();/" "$DOTNET_PROGRAM_FILE"
    echo "[boot] injected .NET runtime logging middleware"
  fi
fi`,
    "dotnet publish -c Release -o /app/publish",
    "touch /tmp/build-done; sleep 1; pkill -f 'nc -l -p 8000' >/dev/null 2>&1 || true",
    "DLL=$(ls /app/publish/*.dll 2>/dev/null | head -n1)",
    'if [ -z "$DLL" ]; then echo "[FATAL] no DLL produced"; ls -la /app/publish/ 2>&1; exit 1; fi',
    'echo "[boot] launching $DLL"',
    "export ASPNETCORE_URLS=http://0.0.0.0:8000",
    'exec dotnet "$DLL"',
  ].join("; ");
}

function startupDeno(): string {
  // Preserved from the original aca.server.ts implementation (Deno hot-reload runner).
  return [
    "set -e",
    'echo "[boot] deno container starting $(date -u +%FT%TZ)"',
    "mkdir -p /app",
    'if [ -z "$RUNNER_SCRIPT_B64" ]; then echo "[boot][FATAL] RUNNER_SCRIPT_B64 missing"; exit 1; fi',
    'printf "%s" "$RUNNER_SCRIPT_B64" | base64 -d > /app/runner.ts',
    'echo "[boot] runner.ts written: $(wc -c < /app/runner.ts) bytes"',
    'if [ "$(wc -c < /app/runner.ts)" -lt 100 ]; then echo "[boot][FATAL] runner.ts too small"; cat /app/runner.ts; exit 1; fi',
    "cd /app",
    'echo "[boot] launching deno"',
    "exec deno run --allow-net --allow-env --allow-read --allow-write runner.ts",
  ].join("; ");
}

const NODE_STARTER = `// Edge function (Node 20). Export a default async handler.
// req: { method, url, headers, query, body, params }
// Return: { status?, headers?, body? } OR a Response-like object.

module.exports = async function handler(req) {
  const name = req.query?.name ?? "mundo";
  console.log("Invoked with name =", name);
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: name, at: new Date().toISOString(), runtime: "node" }),
  };
};
`;

const NODE_PACKAGE_JSON = `{
  "name": "node-function",
  "private": true,
  "type": "commonjs",
  "main": "index.js"
}
`;

const PYTHON_STARTER = `# Edge function (Python 3.12). Define a 'handler(req)' function.
# req is a dict: { method, url, headers, query, body, params }
# Return a dict: { status?, headers?, body? }

import json
from datetime import datetime, timezone

def handler(req):
    name = (req.get("query") or {}).get("name", "mundo")
    print("Invoked with name =", name)
    return {
        "status": 200,
        "headers": {"content-type": "application/json"},
        "body": json.dumps({"hello": name, "at": datetime.now(timezone.utc).isoformat(), "runtime": "python"}),
    }
`;

const DENO_STARTER = `// Edge function — escribe tu handler aquí.
// Tienes acceso a Deno.env.get("MY_SECRET") con los secrets del proyecto.

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const name = url.searchParams.get("name") ?? "mundo";
  console.log("Invocada con name =", name);
  return new Response(
    JSON.stringify({ hello: name, at: new Date().toISOString(), runtime: "deno" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
});
`;

const JAVA_BASE_PACKAGE = "com.example";

const SPRING_POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.4</version>
    <relativePath/>
  </parent>
  <groupId>__JAVA_BASE_PACKAGE__</groupId>
  <artifactId>app</artifactId>
  <version>0.0.1</version>
  <properties>
    <java.version>21</java.version>
    <mainClass>__JAVA_MAIN_CLASS__</mainClass>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-data-jpa</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-validation</artifactId>
    </dependency>
    <dependency>
      <groupId>org.postgresql</groupId>
      <artifactId>postgresql</artifactId>
      <scope>runtime</scope>
    </dependency>
    <dependency>
      <groupId>com.h2database</groupId>
      <artifactId>h2</artifactId>
      <scope>runtime</scope>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
        <configuration>
          <mainClass>\${mainClass}</mainClass>
        </configuration>
      </plugin>
    </plugins>
  </build>
</project>
`;

const SPRING_APP = `package __JAVA_BASE_PACKAGE__;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class App {
    public static void main(String[] args) {
        SpringApplication.run(App.class, args);
    }
}
`;

const SPRING_HOME_CONTROLLER = `package __JAVA_BASE_PACKAGE__.controller;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.Map;

@RestController
public class HomeController {
    @GetMapping("/")
    public Map<String, Object> root() {
        return Map.of("hello", "mundo", "at", Instant.now().toString(), "runtime", "java");
    }

    @GetMapping("/__health")
    public Map<String, Object> health() {
        return Map.of("status", "ok", "runtime", "java");
    }
}
`;

const SPRING_PRODUCT_CONTROLLER = `package __JAVA_BASE_PACKAGE__.controller;

import __JAVA_BASE_PACKAGE__.entity.Product;
import __JAVA_BASE_PACKAGE__.service.ProductService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/products")
public class ProductController {
    private final ProductService productService;

    public ProductController(ProductService productService) {
        this.productService = productService;
    }

    @GetMapping
    public List<Product> list() {
        return productService.listActive();
    }
}
`;

const SPRING_PRODUCT_ENTITY = `package __JAVA_BASE_PACKAGE__.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.util.UUID;

@Entity
@Table(name = "products")
public class Product {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false)
    private boolean active = true;

    public Product() {
    }

    public Product(String name, boolean active) {
        this.name = name;
        this.active = active;
    }

    public UUID getId() {
        return id;
    }

    public void setId(UUID id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public boolean isActive() {
        return active;
    }

    public void setActive(boolean active) {
        this.active = active;
    }
}
`;

const SPRING_PRODUCT_REPOSITORY = `package __JAVA_BASE_PACKAGE__.repository;

import __JAVA_BASE_PACKAGE__.entity.Product;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface ProductRepository extends JpaRepository<Product, UUID> {
    List<Product> findByActiveTrue();
}
`;

const SPRING_PRODUCT_SERVICE = `package __JAVA_BASE_PACKAGE__.service;

import __JAVA_BASE_PACKAGE__.entity.Product;
import __JAVA_BASE_PACKAGE__.repository.ProductRepository;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class ProductService {
    private final ProductRepository productRepository;

    public ProductService(ProductRepository productRepository) {
        this.productRepository = productRepository;
    }

    public List<Product> listActive() {
        return productRepository.findByActiveTrue();
    }
}
`;

const SPRING_APPLICATION_PROPERTIES = `server.port=8000
spring.application.name=app
spring.datasource.url=\${SPRING_DATASOURCE_URL}
spring.datasource.username=\${SPRING_DATASOURCE_USERNAME}
spring.datasource.password=\${SPRING_DATASOURCE_PASSWORD}
spring.datasource.driver-class-name=org.postgresql.Driver
spring.jpa.hibernate.ddl-auto=\${SPRING_JPA_HIBERNATE_DDL_AUTO:update}
spring.jpa.show-sql=\${SPRING_JPA_SHOW_SQL:true}
spring.jpa.defer-datasource-initialization=true
spring.sql.init.mode=always
app.api.keys=\${API_KEY:}
`;

const SPRING_DATA_SQL = `INSERT INTO products (id, name, active) VALUES (RANDOM_UUID(), 'Producto demo', true);
INSERT INTO products (id, name, active) VALUES (RANDOM_UUID(), 'Producto inactivo', false);
`;

const JAVA_STARTER_TEMPLATE_FILES = [
  { path: "pom.xml", content: SPRING_POM },
  { path: "src/main/java/__JAVA_PACKAGE_PATH__/App.java", content: SPRING_APP },
  {
    path: "src/main/java/__JAVA_PACKAGE_PATH__/controller/HomeController.java",
    content: SPRING_HOME_CONTROLLER,
  },
  {
    path: "src/main/java/__JAVA_PACKAGE_PATH__/controller/ProductController.java",
    content: SPRING_PRODUCT_CONTROLLER,
  },
  {
    path: "src/main/java/__JAVA_PACKAGE_PATH__/entity/Product.java",
    content: SPRING_PRODUCT_ENTITY,
  },
  {
    path: "src/main/java/__JAVA_PACKAGE_PATH__/repository/ProductRepository.java",
    content: SPRING_PRODUCT_REPOSITORY,
  },
  {
    path: "src/main/java/__JAVA_PACKAGE_PATH__/service/ProductService.java",
    content: SPRING_PRODUCT_SERVICE,
  },
  {
    path: "src/main/java/__JAVA_PACKAGE_PATH__/security/ApiKeyFilter.java",
    content: `package __JAVA_BASE_PACKAGE__.security;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.Arrays;
import java.util.List;

@Component
public class ApiKeyFilter implements Filter {
    private final List<String> allowedApiKeys;

    public ApiKeyFilter(@Value("\${app.api.keys:}") String apiKeys) {
        String envKeys = System.getenv("API_KEY");
        if (envKeys == null || envKeys.isBlank()) {
            envKeys = System.getenv("X_API_KEY");
        }
        String raw = (apiKeys == null || apiKeys.isBlank()) ? envKeys : apiKeys;
        this.allowedApiKeys = Arrays.stream((raw == null ? "" : raw).split(","))
            .map(String::trim)
            .filter(key -> !key.isBlank())
            .toList();
    }

    @Override
    public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
            throws IOException, ServletException {
        HttpServletRequest httpRequest = (HttpServletRequest) request;
        HttpServletResponse httpResponse = (HttpServletResponse) response;

        if ("OPTIONS".equalsIgnoreCase(httpRequest.getMethod())) {
            chain.doFilter(request, response);
            return;
        }

        String path = httpRequest.getRequestURI();
        if (!path.startsWith("/api/")) {
            chain.doFilter(request, response);
            return;
        }

        String apiKey = httpRequest.getHeader("x-api-key");
        if (apiKey == null || apiKey.isBlank()) {
            String authorization = httpRequest.getHeader("Authorization");
            if (authorization != null && authorization.regionMatches(true, 0, "Bearer ", 0, 7)) {
                apiKey = authorization.substring(7).trim();
            }
        }
        if (apiKey == null || !allowedApiKeys.contains(apiKey)) {
            httpResponse.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            httpResponse.setContentType("application/json");
            httpResponse.getWriter().write("""
                {
                  "data": null,
                  "error": {
                    "message": "Unauthorized",
                    "code": "UNAUTHORIZED",
                    "hint": null
                  },
                  "count": 0
                }
                """);
            return;
        }

        chain.doFilter(request, response);
    }
}
`,
  },
  { path: "src/main/resources/application.properties", content: SPRING_APPLICATION_PROPERTIES },
  { path: "src/main/resources/data.sql", content: SPRING_DATA_SQL },
] as const;

export function renderJavaStarterFiles(
  basePackage: string,
): Array<{ path: string; content: string }> {
  const packagePath = basePackage.replace(/\./g, "/");
  const mainClass = `${basePackage}.App`;
  return JAVA_STARTER_TEMPLATE_FILES.map((file) => ({
    path: file.path.replaceAll("__JAVA_PACKAGE_PATH__", packagePath),
    content: file.content
      .replaceAll("__JAVA_BASE_PACKAGE__", basePackage)
      .replaceAll("__JAVA_MAIN_CLASS__", mainClass),
  }));
}

const JAVA_MODULE_TEMPLATE_FILES = [
  {
    path: "src/main/java/__JAVA_PACKAGE_PATH__/__JAVA_FUNCTION_SEGMENT__/controller/FeatureController.java",
    content: `package __JAVA_BASE_PACKAGE__.__JAVA_FUNCTION_SEGMENT__.controller;

import __JAVA_BASE_PACKAGE__.__JAVA_FUNCTION_SEGMENT__.entity.Feature;
import __JAVA_BASE_PACKAGE__.__JAVA_FUNCTION_SEGMENT__.service.FeatureService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/__JAVA_FUNCTION_ROUTE__")
public class FeatureController {
    private final FeatureService featureService;

    public FeatureController(FeatureService featureService) {
        this.featureService = featureService;
    }

    @GetMapping
    public List<Feature> list() {
        return featureService.listActive();
    }
}
`,
  },
  {
    path: "src/main/java/__JAVA_PACKAGE_PATH__/__JAVA_FUNCTION_SEGMENT__/entity/Feature.java",
    content: `package __JAVA_BASE_PACKAGE__.__JAVA_FUNCTION_SEGMENT__.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.util.UUID;

@Entity
@Table(name = "__JAVA_TABLE_NAME__")
public class Feature {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false)
    private boolean active = true;

    public Feature() {
    }

    public Feature(String name, boolean active) {
        this.name = name;
        this.active = active;
    }

    public UUID getId() {
        return id;
    }

    public void setId(UUID id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public boolean isActive() {
        return active;
    }

    public void setActive(boolean active) {
        this.active = active;
    }
}
`,
  },
  {
    path: "src/main/java/__JAVA_PACKAGE_PATH__/__JAVA_FUNCTION_SEGMENT__/repository/FeatureRepository.java",
    content: `package __JAVA_BASE_PACKAGE__.__JAVA_FUNCTION_SEGMENT__.repository;

import __JAVA_BASE_PACKAGE__.__JAVA_FUNCTION_SEGMENT__.entity.Feature;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface FeatureRepository extends JpaRepository<Feature, UUID> {
    List<Feature> findByActiveTrue();
}
`,
  },
  {
    path: "src/main/java/__JAVA_PACKAGE_PATH__/__JAVA_FUNCTION_SEGMENT__/service/FeatureService.java",
    content: `package __JAVA_BASE_PACKAGE__.__JAVA_FUNCTION_SEGMENT__.service;

import __JAVA_BASE_PACKAGE__.__JAVA_FUNCTION_SEGMENT__.entity.Feature;
import __JAVA_BASE_PACKAGE__.__JAVA_FUNCTION_SEGMENT__.repository.FeatureRepository;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class FeatureService {
    private final FeatureRepository featureRepository;

    public FeatureService(FeatureRepository featureRepository) {
        this.featureRepository = featureRepository;
    }

    public List<Feature> listActive() {
        return featureRepository.findByActiveTrue();
    }
}
`,
  },
] as const;

export function renderJavaFunctionFiles(
  basePackage: string,
  functionSegment: string,
  functionRoute: string,
): Array<{ path: string; content: string }> {
  const packagePath = basePackage.replace(/\./g, "/");
  return JAVA_MODULE_TEMPLATE_FILES.map((file) => ({
    path: file.path
      .replaceAll("__JAVA_PACKAGE_PATH__", packagePath)
      .replaceAll("__JAVA_FUNCTION_SEGMENT__", functionSegment),
    content: file.content
      .replaceAll("__JAVA_BASE_PACKAGE__", basePackage)
      .replaceAll("__JAVA_FUNCTION_SEGMENT__", functionSegment)
      .replaceAll("__JAVA_FUNCTION_ROUTE__", functionRoute)
      .replaceAll("__JAVA_TABLE_NAME__", functionRoute.replace(/-/g, "_")),
  }));
}

const DOTNET_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <AssemblyName>App</AssemblyName>
  </PropertyGroup>
</Project>
`;

const DOTNET_PROGRAM = `var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/", (string? name) => Results.Ok(new {
  hello = name ?? "mundo",
  at = DateTime.UtcNow.ToString("o"),
  runtime = "dotnet"
}));

app.MapGet("/__health", () => Results.Ok(new { status = "ok", runtime = "dotnet" }));

app.Run();
`;

export const RUNTIME_CONFIGS: Record<RuntimeId, RuntimeConfig> = {
  deno: {
    id: "deno",
    label: "Deno",
    description: "TypeScript / JavaScript con hot-reload (sin redeploy al cambiar código).",
    image: "denoland/deno:alpine-1.46.3",
    port: 8000,
    cpu: 0.5,
    memory: "1Gi",
    healthPath: "/__health",
    startupInitialDelaySeconds: 10,
    startupFailureThreshold: 30,
    startupPeriodSeconds: 5,
    defaultEntrypoint: "index.ts",
    monacoLanguage: "typescript",
    multiFunction: true,
    requiresRedeploy: false,
    starterFiles: [{ path: "index.ts", content: DENO_STARTER }],
    startupScript: startupDeno(),
  },
  node: {
    id: "node",
    label: "Node.js 20",
    description:
      "JavaScript con runtime de Node 20 (Express-style). Requiere redeploy al cambiar código.",
    image: "mcr.microsoft.com/devcontainers/javascript-node:22",
    port: 8000,
    cpu: 0.5,
    memory: "1Gi",
    healthPath: "/__health",
    startupInitialDelaySeconds: 5,
    startupFailureThreshold: 24,
    startupPeriodSeconds: 5,
    defaultEntrypoint: "index.js",
    monacoLanguage: "javascript",
    multiFunction: true,
    requiresRedeploy: true,
    starterFiles: [
      { path: "index.js", content: NODE_STARTER },
      { path: "package.json", content: NODE_PACKAGE_JSON },
    ],
    startupScript: startupNode(),
  },
  python: {
    id: "python",
    label: "Python 3.12",
    description: "Python 3.12 slim. Requiere redeploy al cambiar código.",
    image: "python:3.12-slim",
    port: 8000,
    cpu: 0.5,
    memory: "1Gi",
    healthPath: "/__health",
    startupInitialDelaySeconds: 5,
    startupFailureThreshold: 24,
    startupPeriodSeconds: 5,
    defaultEntrypoint: "index.py",
    monacoLanguage: "python",
    multiFunction: true,
    requiresRedeploy: true,
    starterFiles: [{ path: "index.py", content: PYTHON_STARTER }],
    startupScript: startupPython(),
  },
  java: {
    id: "java",
    label: "Java 21 / Spring Boot",
    description:
      "Spring Boot 3.3 sobre Java 21. Build de Maven en boot (~1-3 min). Single-app por proyecto.",
    image: "maven:3.9-eclipse-temurin-21-alpine",
    port: 8000,
    cpu: 1.0,
    memory: "2Gi",
    healthPath: "/__health",
    startupInitialDelaySeconds: 30,
    startupFailureThreshold: 60,
    startupPeriodSeconds: 5, // up to 5 min of cold start
    defaultEntrypoint: "src/main/java/com/example/App.java",
    monacoLanguage: "java",
    multiFunction: false,
    requiresRedeploy: true,
    starterFiles: renderJavaStarterFiles(JAVA_BASE_PACKAGE),
    startupScript: startupJava(),
  },
  dotnet: {
    id: "dotnet",
    label: ".NET 8 (ASP.NET Core)",
    description:
      "ASP.NET Core Minimal API sobre .NET 8. Build con `dotnet publish` en boot (~1-2 min). Single-app por proyecto.",
    image: "mcr.microsoft.com/dotnet/sdk:8.0",
    port: 8000,
    cpu: 1.0,
    memory: "2Gi",
    healthPath: "/__health",
    startupInitialDelaySeconds: 30,
    startupFailureThreshold: 48,
    startupPeriodSeconds: 5,
    defaultEntrypoint: "Program.cs",
    monacoLanguage: "csharp",
    multiFunction: false,
    requiresRedeploy: true,
    starterFiles: [
      { path: "App.csproj", content: DOTNET_CSPROJ },
      { path: "Program.cs", content: DOTNET_PROGRAM },
    ],
    startupScript: startupDotnet(),
  },
};

export function getRuntimeConfig(id: string | null | undefined): RuntimeConfig {
  const key = (id as RuntimeId) ?? "deno";
  return RUNTIME_CONFIGS[key] ?? RUNTIME_CONFIGS.deno;
}
