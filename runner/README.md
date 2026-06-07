# Function runner image

This is the source of the Deno runner that runs inside every Azure Container App.
The image is referenced by the env var `FN_RUNNER_IMAGE`.

## Default

By default the app uses the public image `denoland/deno:alpine-1.46.3` and ships the
`runner/main.ts` source to the container via the `RUNNER_SCRIPT` env var (written to
disk on startup). This means **no custom image build is required** to get started.

## Why a custom image?

For faster cold starts (~200 ms instead of ~1.5 s) you can pre-bake `runner/main.ts`
into a Docker image:

```dockerfile
FROM denoland/deno:alpine-1.46.3
WORKDIR /app
COPY runner/main.ts ./runner.ts
# Pre-cache the Neon driver so cold-start doesn't hit esm.sh
RUN deno cache runner.ts
EXPOSE 8000
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "runner.ts"]
```

Build & push to any registry (Docker Hub, GHCR, ACR), then set the `FN_RUNNER_IMAGE`
secret in the project to e.g. `ghcr.io/yourorg/lovable-fn-runner:1`.
