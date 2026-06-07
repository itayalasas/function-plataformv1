# --- Build stage ---
FROM oven/bun:1.1-alpine AS builder
WORKDIR /app

# Install deps (cacheable layer)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Copy sources and build with Node server preset (Nitro)
COPY . .
ENV NITRO_PRESET=node-server
ENV NODE_ENV=production
RUN bun run build

# --- Runtime stage ---
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

# Nitro node-server output lands in .output/
COPY --from=builder /app/.output ./.output

EXPOSE 8080
CMD ["node", ".output/server/index.mjs"]
