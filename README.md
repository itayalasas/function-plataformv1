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
- `OPENAI_API_KEY`
- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_RESOURCE_GROUP`
- `AZURE_LOCATION`
- `AZURE_ACA_ENVIRONMENT`
- `FN_RUNNER_IMAGE`

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

## Azure deployment

This repo ships with a GitHub Actions workflow at
[.github/workflows/deploy-aca.yml](./.github/workflows/deploy-aca.yml).

The workflow:

- builds the container image
- pushes it to Azure Container Registry
- creates or updates the Azure Container App
- prints the public FQDN in the workflow summary

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

Set this repository secret:

- `AZURE_CREDENTIALS`

## Notes

- Do not commit `.env` or `.env.local`.
- Java projects use a single Spring Boot app per project.
- Java secrets are consumed from `Secrets`.
- Java API keys are consumed from `Tokens`.
- Neon is the source of truth for projects, files, deploy history, and logs.
