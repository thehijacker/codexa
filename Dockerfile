# ── Build stage ───────────────────────────────────────────────────────────────
# Installs all deps (including devDeps for esbuild), transpiles public/ → dist/
# for Chrome 69 / older Android WebView, then prunes devDeps before handoff.
#
# Alpine-based: the intermittent native crash ("Assertion failed: (env) != nullptr" in
# node::RemoveEnvironmentCleanupHook, thrown from better-sqlite3's Statement destructor) was
# never actually an Alpine/musl problem — it was better-sqlite3@11.x predating Node 24 support,
# so npm fell back to compiling it from source against a version never tested on Node 24's ABI,
# producing a subtly broken binary. That's fixed by bumping better-sqlite3 to ^13.x
# (package.json), which ships real prebuilt N-API binaries for Node 24 for both glibc and musl
# — so Alpine is safe again, and preferred: it keeps the pushed image under ~80MB instead of
# bookworm-slim's ~100MB+, which matters because Codeberg's container registry enforces a
# per-package storage quota (413 enforcePackagesQuota) that the larger image tripped.
FROM node:24-alpine AS build

WORKDIR /app

# python3/make/g++ are required to compile the native bcrypt addon
RUN apk add --no-cache python3 make g++

COPY package*.json ./
# vendor-stubs/ must land before `npm ci` — package.json's "overrides" points a dependency at
# a local file: path in here (see vendor-stubs/napi-canvas-stub), and npm ci resolving that
# against a not-yet-existing directory doesn't fail fast, it stalls for minutes (confirmed:
# ~5x slower build) before eventually falling back. Copying just this small folder up front
# keeps the layer-caching win (this layer still only invalidates when deps actually change)
# without needing the full `COPY . .` this early.
COPY vendor-stubs ./vendor-stubs
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:24-alpine

WORKDIR /app

# Non-root user for security. su-exec execve()s straight into the target command instead of
# forking, so node still ends up as PID 1 and receives Docker's signals directly.
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
  CMD node -e "fetch('http://localhost:3000/manifest.json').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/entrypoint.sh"]
