# Vortex Function Platform

Platform for building and deploying multi-runtime function projects with a
TanStack Start UI, Neon as the application database, and Azure Container Apps
as the runtime target.

## What this repo includes

- Project and function management UI
- File tree editor with folders and nested files
- Runtime support for Deno, Node.js 20, Python 3.12, Java 21 / Spring Boot,
  and .NET 8
- Secrets and tokens management
- Azure Container Apps deployment flow
- Neon-backed persistence for projects, files, deploys, logs, and auth metadata

## Local setup

1. Install dependencies:

```bash
bun install
```

2. Create `.env.local` from `.env.local.example`.

3. Fill in the required values:

- `NEON_DATABASE_URL`
- `VORTEX_CLONE_API_TOKEN` to call the project clone API
- `VORTEX_CONNECTOR_API_TOKEN` for the connector API used by agents and external apps
- `VORTEX_CONNECTOR_OWNER_ID` optional default owner for connector-token requests
- `OPENAI_API_KEY`
- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_RESOURCE_GROUP`
- `AZURE_LOCATION`
- `AZURE_ACA_ENVIRONMENT`
- `AZURE_STORAGE_ACCOUNT_NAME`
- `AZURE_STORAGE_ACCOUNT_KEY`
- `AZURE_STORAGE_RESOURCE_GROUP` if the storage account lives in another RG
- `FN_RUNNER_IMAGE`
- `VORTEX_DEFAULT_STORAGE_MOUNT_PATH` optional, defaults to `/data`

4. Start the app:

```bash
bun run dev
```

## Useful scripts

```bash
bun run dev
bun run build
bun run preview
bun run lint
bun run format
```

## Local deploy CLI

This repo now includes a command-line deploy helper that syncs local function
folders into the platform and then triggers the same project deploy flow used
by the web UI.

Create a project link once:

```bash
npm run vortex -- link --project-id <project-uuid> --source-root functions
```

Then deploy everything in that local root:

```bash
npm run vortex -- deploy
```

Or deploy a single function folder:

```bash
npm run vortex -- deploy hello-world
```

Expected layout:

```text
functions/
  hello-world/
    index.ts
    _shared/
      utils.ts
  another-function/
    index.ts
```

The CLI only includes `_shared` when the function entrypoint imports it.
It understands the common import styles for Node/TypeScript, Python, Java,
and .NET.
If the function already has its own `_shared` folder, that version is used.
If not, the CLI can source a shared `_shared` folder from the project tree
and materialize it inside the function bundle at the path each runtime
expects (`_shared` for Node/Python/.NET, `src/main/java/_shared` for Java).

If a function needs a custom entrypoint, add a `vortex.json` file inside that
function folder:

```json
{
  "entrypoint": "src/main/java/com/example/App.java"
}
```

The CLI reads `.vortex/.env`, `.env.local`, and `.env` from the project root,
so the same Neon and Azure variables used by the web app are reused
automatically. The web installer writes the hidden `.vortex/.env` file for you
when the platform has those values configured.

To call the project clone API from another app or a CLI, send the shared token
in either of these headers:

```http
x-vortex-clone-token: <token>
```

or:

```http
Authorization: Bearer <token>
```

### Web installer

If you want to install the CLI into another project without copying the
`scripts/` folder manually, open the dashboard and click `Instalar CLI`.
That downloads a self-contained `vortex-install.mjs` installer.

Run it once from the root of the target project:

```bash
node vortex-install.mjs
```

The installer creates `.vortex/cli`, installs the local CLI dependencies,
adds `.vortex/` to `.gitignore`, writes a hidden `.vortex/.env` with the
platform connection values, and injects an `npm run vortex` script when the
project already has a `package.json`.

## Connector API

Use this API when another app or an agent needs to create projects and deploy
the code it generated.

Flow:

1. `POST /api/connector/projects` to create the project.
2. `POST /api/connector/projects/:projectId/functions/sync` to reconcile the
   desired functions and files.
3. `POST /api/connector/projects/:projectId/deploy` to deploy the project.

Auth options:

- `Authorization: Bearer <AuthSystem access token>`
- `x-vortex-connector-token: <token>`
- If you use the connector token, also send `x-vortex-owner-id: <owner_id>`
  unless `VORTEX_CONNECTOR_OWNER_ID` is set.

The `functions/sync` call is a full reconciliation. Send the complete desired
function list and each function's full file tree.

Example:

```bash
curl -X POST "$BASE_URL/api/connector/projects" \
  -H "Content-Type: application/json" \
  -H "x-vortex-connector-token: $VORTEX_CONNECTOR_API_TOKEN" \
  -H "x-vortex-owner-id: $OWNER_ID" \
  -d '{
    "name": "Acme App",
    "runtime": "deno",
    "deploymentProfile": { "storageMountPath": "/data" }
  }'
```

```bash
curl -X POST "$BASE_URL/api/connector/projects/$PROJECT_ID/functions/sync" \
  -H "Content-Type: application/json" \
  -H "x-vortex-connector-token: $VORTEX_CONNECTOR_API_TOKEN" \
  -H "x-vortex-owner-id: $OWNER_ID" \
  -d '{
    "functions": [
      {
        "name": "api",
        "entrypoint": "index.ts",
        "files": [
          { "path": "index.ts", "content": "export default async function handler() { return new Response(\"ok\") }" }
        ]
      }
    ]
  }'
```

## Azure deployment

This repo ships with a GitHub Actions workflow at
[.github/workflows/deploy-aca.yml](./.github/workflows/deploy-aca.yml).

The workflow:

- builds the container image
- pushes it to Azure Container Registry
- creates the Azure Container App on the first deploy, then updates the image in place on later deploys so existing env vars and secrets stay intact
- prints the public FQDN in the workflow summary

Project clones and newly created projects now default to a persistent storage
mount path so data can survive restarts. The platform provisions the Azure
Files share and the Container Apps environment storage entry during deploy.
That means the deploy environment must include:

- an Azure Files-capable storage account
- the storage account name and key in the app env/secrets
- the storage resource group if it differs from the ACA resource group

The container app must be able to pull from the private ACR. By default, the
workflow assumes the Container App managed identity already has `AcrPull` on
the registry. If you want GitHub Actions to create that role assignment for
you, set the repository variable `MANAGE_ACR_RBAC=true` and make sure the
Azure identity in `AZURE_CREDENTIALS` has `Owner` or `User Access
Administrator` on the registry or subscription.

`.env.local` is only for local development. Docker and Azure Container Apps do
not read it automatically because `.env*` files are excluded from the image.
Set runtime values in the Container App itself or in the GitHub Actions
deployment flow.

Note: this workflow deploys the main web app container. Java function projects
are deployed from the platform UI or with the Java deployment script in
[scripts/deploy-java-fix.mjs](./scripts/deploy-java-fix.mjs).

### Required GitHub settings

Set these repository variables:

- `AZURE_RESOURCE_GROUP`
- `ACA_NAME`
- `ACA_ENVIRONMENT`
- `ACR_NAME`
- `IMAGE_NAME`
- `AZURE_LOCATION`
- `MANAGE_ACR_RBAC` optional, set to `true` only if the deployment identity
  can write Azure role assignments

Set this repository secret:

- `AZURE_CREDENTIALS`

For runtime environment variables inside the container, set them on the Azure
Container App, for example with `az containerapp update --set-env-vars ...` or
through the Azure Portal. Secrets should be added as Container App secrets and
referenced as environment variables from there.

## Notes

- Do not commit `.env` or `.env.local`.
- Java projects use a single Spring Boot app per project.
- Java secrets are consumed from `Secrets`.
- Java API keys are consumed from `Tokens`.
- Neon is the source of truth for projects, files, deploy history, and logs.
