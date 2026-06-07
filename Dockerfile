# --- Build stage ---
# Use Microsoft-hosted base images so CI does not depend on Docker Hub.
FROM mcr.microsoft.com/devcontainers/javascript-node:22 AS builder
WORKDIR /app

# Install deps (cacheable layer)
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# Copy sources and build with Node server preset (Nitro)
COPY . .
ENV NITRO_PRESET=node-server
ENV NODE_ENV=production
RUN npm run build

# --- Runtime stage ---
FROM mcr.microsoft.com/devcontainers/javascript-node:22 AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

# TanStack Start emits dist/server/server.js plus client/server assets.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY scripts/aca-node-server.mjs ./aca-node-server.mjs

EXPOSE 8080
CMD ["node", "aca-node-server.mjs"]
