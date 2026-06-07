import { neon } from "@neondatabase/serverless";
import fs from "node:fs";
import crypto from "node:crypto";

function env(name) {
  const text = fs.readFileSync(".env.local", "utf8");
  return text
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1)
    ?.trim();
}

const neonUrl = env("NEON_DATABASE_URL");
const tenantId = env("AZURE_TENANT_ID");
const clientId = env("AZURE_CLIENT_ID");
const clientSecret = env("AZURE_CLIENT_SECRET");
const subscriptionId = env("AZURE_SUBSCRIPTION_ID");
const resourceGroup = env("AZURE_RESOURCE_GROUP");
const environmentName = env("AZURE_ACA_ENVIRONMENT");
const location = (env("AZURE_LOCATION") || "North Central US").toLowerCase().replace(/\s+/g, "");

if (
  !neonUrl ||
  !tenantId ||
  !clientId ||
  !clientSecret ||
  !subscriptionId ||
  !resourceGroup ||
  !environmentName
) {
  throw new Error("Missing required environment values");
}

const sql = neon(neonUrl);

const projectRows = await sql`
  select id, slug, runtime, container_app_name, fqdn, admin_token, owner_id
  from projects
  where slug = 'testv1-nlsn'
  limit 1
`;
const project = projectRows[0];
if (!project) throw new Error("Project not found");
const runtimeId = project.runtime || "deno";
const containerAppName =
  project.container_app_name || `proj-${project.slug}-${project.id.slice(0, 6)}`;

let adminToken = project.admin_token;
if (!adminToken) {
  adminToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await sql`update projects set admin_token = ${adminToken} where id = ${project.id}`;
}

const secretRows = await sql`
  select name, value
  from secrets
  where project_id = ${project.id} and owner_id = ${project.owner_id}
`;
const tokenRows = await sql`
  select ft.name, ft.value
  from function_tokens ft
  join functions f on f.id = ft.function_id
  where f.project_id = ${project.id} and ft.owner_id = ${project.owner_id}
  order by f.slug asc, ft.name asc
`;

const secrets = {};
for (const row of secretRows) secrets[row.name] = row.value;
const tokenValues = tokenRows.map((row) => row.value).filter(Boolean);

const secretsArr = Object.entries(secrets).map(([name, value]) => ({
  name: name.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
  value,
}));

const nextVersionRows = await sql`
  select coalesce(max(version), 0) + 1 as v
  from deployments
  where project_id = ${project.id}
`;
const version = nextVersionRows[0].v;

const filesRows = await sql`
  select f.slug, f.entrypoint, ff.path, ff.content, ff.kind
  from function_files ff
  join functions f on f.id = ff.function_id
  where f.project_id = ${project.id} and ff.owner_id = ${project.owner_id}
  order by f.slug asc, ff.path asc
`;
const filesB64 = Buffer.from(JSON.stringify(filesRows), "utf8").toString("base64");

const startupScript = [
  "set -e",
  'echo "[boot] java/spring-boot container starting $(date -u +%FT%TZ)"',
  "mkdir -p /app/build",
  "cd /app/build",
  "find /app/build -mindepth 1 -maxdepth 1 -exec rm -rf {} +",
  'if [ -z "$FILES_B64" ]; then echo "[FATAL] FILES_B64 missing — Java project has no source"; exit 1; fi',
  'printf "%s" "$FILES_B64" | base64 -d > /tmp/files.json',
  "apk add --no-cache jq curl netcat-openbsd >/dev/null 2>&1 || true",
  'seen=/tmp/java-seen-paths.txt; : > "$seen"; jq -c \'.[]\' /tmp/files.json | while IFS= read -r row; do kind=$(echo "$row" | jq -r \'.kind // "file"\'); path=$(echo "$row" | jq -r \'.path\'); if grep -Fxq "$path" "$seen"; then echo "[boot] skipping duplicate path $path"; continue; fi; printf "%s\\n" "$path" >> "$seen"; if [ "$kind" = "dir" ]; then mkdir -p "$path"; else content=$(echo "$row" | jq -r \'.content\'); mkdir -p "$(dirname "$path")"; printf "%s" "$content" > "$path"; fi; done',
  'echo "[boot] extracted java sources"; ls -R /app/build | head -50; (while [ ! -f /tmp/build-done ]; do (printf \'HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n{"status":"building"}\' | nc -l -p 8000 -q 1 >/dev/null 2>&1) || sleep 1; done) & echo "[boot] running mvn package (this may take 1-3 min)"',
  "mvn -B -q -DskipTests clean package",
  "touch /tmp/build-done; sleep 1; pkill -f 'nc -l -p 8000' >/dev/null 2>&1 || true",
  'JAR=$(ls target/*.jar 2>/dev/null | grep -v "original" | head -n1)',
  'if [ -z "$JAR" ]; then echo "[FATAL] no JAR built in target/"; ls -la target/ 2>&1; exit 1; fi',
  'echo "[boot] launching $JAR"',
  'export JAVA_HOME="${JAVA_HOME:-/opt/java/openjdk}"',
  'export PATH="$JAVA_HOME/bin:$PATH"',
  'exec java -jar "$JAR" --server.port=8000',
].join("; ");

const tokenForm = new URLSearchParams();
tokenForm.set("client_id", clientId);
tokenForm.set("client_secret", clientSecret);
tokenForm.set("grant_type", "client_credentials");
tokenForm.set("scope", "https://management.azure.com/.default");

const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: tokenForm,
});
if (!tokenRes.ok) throw new Error(`Azure token error: ${tokenRes.status} ${await tokenRes.text()}`);
const accessToken = (await tokenRes.json()).access_token;

const base = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.App`;
const envId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.App/managedEnvironments/${environmentName}`;
const putUrl = `${base}/containerApps/${containerAppName}?api-version=2024-03-01`;
const headers = { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" };

const body = {
  location,
  properties: {
    managedEnvironmentId: envId,
    configuration: {
      activeRevisionsMode: "Single",
      ingress: {
        external: true,
        targetPort: 8000,
        transport: "auto",
        allowInsecure: false,
        traffic: [{ latestRevision: true, weight: 100 }],
      },
      secrets: secretsArr,
    },
    template: {
      revisionSuffix: `v${version}`,
      containers: [
        {
          name: "main",
          image: "maven:3.9-eclipse-temurin-21-alpine",
          resources: { cpu: 1, memory: "2Gi" },
          env: [
            { name: "NEON_URL", value: neonUrl },
            { name: "PROJECT_ID", value: project.id },
            { name: "ADMIN_TOKEN", value: adminToken },
            { name: "DEPLOYMENT_VERSION", value: String(version) },
            { name: "RUNTIME", value: runtimeId },
            { name: "PORT", value: "8000" },
            { name: "FILES_B64", value: filesB64 },
            ...(tokenValues.length ? [{ name: "API_KEY", value: tokenValues.join(",") }] : []),
            ...secretsArr.map((s) => ({
              name: s.name.toUpperCase().replace(/-/g, "_"),
              secretRef: s.name,
            })),
          ],
          command: ["/bin/sh", "-c"],
          args: [startupScript],
          probes: [
            {
              type: "Startup",
              httpGet: { path: "/__health", port: 8000 },
              initialDelaySeconds: 30,
              periodSeconds: 5,
              failureThreshold: 60,
              timeoutSeconds: 3,
            },
            {
              type: "Liveness",
              httpGet: { path: "/__health", port: 8000 },
              periodSeconds: 30,
              failureThreshold: 3,
              timeoutSeconds: 3,
            },
          ],
        },
      ],
      scale: { minReplicas: 1, maxReplicas: 3 },
    },
  },
};

const putRes = await fetch(putUrl, { method: "PUT", headers, body: JSON.stringify(body) });
const putText = await putRes.text();
console.log("PUT", putRes.status, putText.slice(0, 200));
if (!putRes.ok) throw new Error(`Azure PUT failed: ${putRes.status}`);

let fqdn = null;
let state = "Unknown";
for (let i = 0; i < 160; i++) {
  await new Promise((r) => setTimeout(r, 2500));
  const getRes = await fetch(putUrl, { headers });
  const getJson = await getRes.json();
  fqdn = getJson?.properties?.configuration?.ingress?.fqdn ?? null;
  state = getJson?.properties?.provisioningState ?? "Unknown";
  if (fqdn && (state === "Succeeded" || state === "Unknown")) break;
  if (state === "Failed" || state === "Canceled") throw new Error(`Provisioning ${state}`);
}
if (!fqdn) throw new Error(`No FQDN after deploy (state=${state})`);

const depInsert = await sql`
  insert into deployments (project_id, owner_id, version, container_app_name, status, runtime, fqdn)
  values (${project.id}, ${project.owner_id}, ${version}, ${containerAppName}, 'live', ${runtimeId}, ${fqdn})
  returning id
`;
const deploymentId = depInsert[0].id;
await sql`update projects set container_app_name = ${containerAppName}, fqdn = ${fqdn}, last_deployed_at = now() where id = ${project.id}`;
await sql`update functions set status = 'live', container_app_name = ${containerAppName}, fqdn = ${fqdn}, updated_at = now() where project_id = ${project.id}`;
await sql`update deployments set status = 'live', fqdn = ${fqdn} where id = ${deploymentId}`;

console.log(JSON.stringify({ deploymentId, version, fqdn }, null, 2));

const apiKey = tokenValues[0];
const healthRes = await fetch(`https://${fqdn}/__health`);
console.log("HEALTH", healthRes.status, await healthRes.text());
const apiHeaders = apiKey ? { "x-api-key": apiKey, authorization: `Bearer ${apiKey}` } : {};
const apiRes = await fetch(`https://${fqdn}/api/products`, { headers: apiHeaders });
console.log("API", apiRes.status, await apiRes.text());
const postRes = await fetch(`https://${fqdn}/api/products`, {
  method: "POST",
  headers: {
    ...apiHeaders,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    name: "Producto de prueba",
    description: "Validación automática del deploy",
    price: 19.99,
    active: true,
  }),
});
console.log("API_POST", postRes.status, await postRes.text());
