# ── Build stage ───────────────────────────────────────────────────────────────
# Installs all deps (including devDeps for esbuild), transpiles public/ → dist/
# for Chrome 69 / older Android WebView, then prunes devDeps before handoff.
FROM node:18-alpine AS build

WORKDIR /app

# python3/make/g++ are required to compile the native bcrypt addon
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:18-alpine

WORKDIR /app

# Non-root user for security
RUN addgroup -S codexa && adduser -S codexa -G codexa && \
    apk add --no-cache su-exec

# Production node_modules (devDeps already pruned) + transpiled dist/
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Source files (public/ kept as server-side fallback; dist/ wins at runtime)
COPY . .

# Data directory — mount a named volume here for persistence
RUN mkdir -p /data && chown codexa:codexa /data && \
    chmod +x /app/entrypoint.sh
ENV DATA_DIR=/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/manifest.json > /dev/null || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
