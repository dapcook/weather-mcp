# Weather MCP server: HTTP /mcp endpoint for AI clients + web console.
# Builds for linux/amd64 and linux/arm64 (e.g. Raspberry Pi 5).
# See docs/planning/DOCKER_DEPLOYMENT_PLAN.md
#
#   docker compose up -d --build
#
# Debian slim, not Alpine: the GRIB decoder's native Linux builds are glibc only.

ARG NODE_VERSION=22

# ---- Build: compile TypeScript ----------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Production dependencies --------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
# @mattnucc/gribberish (NOMADS model data) has no native build for some platforms,
# including linux/arm64. Its WebAssembly build is a drop-in fallback with identical
# output, but npm skips it (it's published for cpu "wasm32"), so install it when the
# native module won't load, pinned to the same version.
RUN if ! node -e "require('@mattnucc/gribberish')" 2>/dev/null; then \
      version=$(node -p "require('@mattnucc/gribberish/package.json').version") && \
      echo "No native GRIB decoder for $(uname -m); installing WebAssembly build ${version}" && \
      npm install --no-save --force --omit=dev --no-audit --no-fund "@mattnucc/gribberish-wasm32-wasi@${version}" && \
      node -e "require('@mattnucc/gribberish')"; \
    fi && \
    npm cache clean --force

# ---- Runtime --------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    WEB_HOST=0.0.0.0 \
    WEB_PORT=3003 \
    WEATHER_MCP_DATA_DIR=/app/data \
    ENABLED_TOOLS=all
WORKDIR /app

# Application files stay root-owned, so the app can't modify its own code
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY web ./web

# Saved locations live here; mount a volume over it to keep them across rebuilds
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

USER node
EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.WEB_PORT || 3003) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# HTTP /mcp + web console. For stdio instead:  docker exec -i weather-mcp node dist/index.js
CMD ["node", "dist/web/server.js"]
