# syntax=docker/dockerfile:1.7
# Forge — image de production (adapter-node), multi-stage.

# --- 1. Dépendances + build ------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
# Outils de compilation pour better-sqlite3 si aucun binaire précompilé ne correspond.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

# --- 2. Exécution ------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
# ping (contrôle des IP libres) et tini (signaux propres).
RUN apt-get update && apt-get install -y --no-install-recommends iputils-ping tini ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
	PORT=3000 \
	HOST=0.0.0.0 \
	DATABASE_PATH=/data/forge.db \
	FORGE_MIGRATIONS_DIR=/app/drizzle \
	BODY_SIZE_LIMIT=110M
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/drizzle ./drizzle
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "build"]
