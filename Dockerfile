# --- Build stage ---
# Use Microsoft-hosted base images so CI does not depend on Docker Hub.
FROM mcr.microsoft.com/devcontainers/javascript-node:22 AS builder

WORKDIR /app

# Install dependencies
# NOTE:
# package-lock.json is currently out of sync with package.json,
# so we use npm install instead of npm ci.
COPY package.json package-lock.json* ./
RUN npm install

# Copy sources and build
COPY . .

ENV NODE_ENV=production
ENV NITRO_PRESET=node-server

RUN npm run build

# Remove dev dependencies after build
RUN npm prune --omit=dev --omit=optional


# --- Runtime stage ---
FROM mcr.microsoft.com/devcontainers/javascript-node:22 AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

# Copy production build and runtime dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/neon ./neon
COPY scripts/aca-node-server.mjs ./aca-node-server.mjs

EXPOSE 8080

CMD ["node", "aca-node-server.mjs"]
