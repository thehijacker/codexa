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
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build
# A plain `npm prune --omit=dev` was the next bottleneck once the npm ci fix above landed:
# confirmed on real builds going from ~55s (fresh npm ci, both archs) to 100-234s for prune
# alone — a huge jump for removing the same ~29 devDep packages that used to take ~10s before
# this project's dependency tree grew the vendor-stubs override. `npm prune` diffs against the
# existing installed tree (walking/reconciling every node it finds, including the override's
# local `file:` link) rather than just installing fresh from the lockfile — and also calls out
# to the npm registry for an audit/funding check by default, network round-trips a Docker build
# has no business depending on the timing of. A clean `rm -rf node_modules && npm ci --omit=dev`
# sidesteps both: it's a deterministic fresh install of only the ~125 production packages
# straight from the (already-verified, already-cached-by-Docker-layer) lockfile, no tree-diffing
# and no registry calls — confirmed locally at ~1.5s for the equivalent step.
RUN rm -rf node_modules && npm ci --omit=dev --no-audit --no-fund

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
