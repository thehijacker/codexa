# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:18-alpine AS deps

WORKDIR /app

# python3/make/g++ are required to compile the native bcrypt addon
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:18-alpine

WORKDIR /app

# Non-root user for security
RUN addgroup -S codexa && adduser -S codexa -G codexa && \
    apk add --no-cache su-exec

# Copy deps and source
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Data directory — mount a named volume here for persistence
RUN mkdir -p /data && chown codexa:codexa /data && \
    chmod +x /app/entrypoint.sh
ENV DATA_DIR=/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/manifest.json > /dev/null || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
