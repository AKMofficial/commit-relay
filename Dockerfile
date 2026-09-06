# syntax=docker/dockerfile:1

# ---- build: typecheck + emit dist/ -------------------------------------
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.node.json ./
COPY src ./src
COPY types ./types
# Typechecks and emits the node project only. The workers project needs the generated
# worker-configuration.d.ts, which .dockerignore excludes; CI runs the full typecheck.
RUN pnpm run typecheck:build && pnpm run build:node

# ---- deps: production dependency tree only -----------------------------
FROM node:24-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# ---- runtime -----------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS="--max-old-space-size=128 --max-semi-space-size=4"

# Files are root-owned; the process runs as node and therefore cannot rewrite
# its own code. MALLOC_ARENA_MAX is deliberately NOT set: it is a glibc tunable
# and a no-op under musl, which alpine uses. The V8 flags above are real, and
# they live in NODE_OPTIONS (not in CMD) so an operator can override one
# variable instead of rewriting the entrypoint.
COPY --from=deps  --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root package.json ./

USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]
