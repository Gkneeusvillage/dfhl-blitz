# DFHL Blitz — one container serving the game and the websocket.
#
# The client is built into server/public and served by the same Node process
# that hosts the Colyseus endpoint, so the league gets ONE url and there is no
# cross-origin anything to configure.

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Manifests first, so a source-only change does not re-run npm ci.
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
COPY shared/package.json shared/
RUN npm ci

COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY shared/package.json shared/
# Only what the server needs at runtime. `tsup` bundles @dfhl/shared INTO
# dist/index.js, but leaves colyseus and express external, so they are still
# required here.
RUN npm ci --omit=dev --workspaces --include-workspace-root && npm cache clean --force

COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/public server/public

# The generated league data is READ FROM DISK at runtime, not bundled — that is
# what lets a roster refresh be `npm run build:rosters` plus a redeploy of this
# file, with no rebuild of the server. Leaving it out produces a container that
# boots happily and then fails on the first match, which is the worst possible
# time to discover it.
COPY --from=build /app/shared/data shared/data

# Informational; the platform supplies the real port through $PORT.
EXPOSE 2567

# Run as the unprivileged user the base image already provides.
USER node

CMD ["node", "server/dist/index.js"]
