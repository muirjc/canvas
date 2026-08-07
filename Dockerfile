# canvas-ycu: production image for apps/api, built from the repo root so npm workspace
# resolution (apps/api -> @canvas/diagram-core) works exactly as it does locally -- no
# dereference-symlinks zip trick like docs/azure-deployment.md's older App Service path needed.
#
# node:20-slim (Debian glibc), not alpine: @resvg/resvg-js (apps/api's SVG->PNG export renderer)
# ships prebuilt native binaries per platform via npm optionalDependencies: `npm ci` on Linux
# fetches the right one automatically, but alpine's musl libc is a real compatibility risk for
# native modules that only publish glibc builds -- slim avoids that question entirely rather than
# debugging it on a first deploy.
#
# Single stage, no --omit=dev pruning: this repo has no build step that needs devDependencies
# gone from the runtime image (no native compiler toolchain, no huge unused packages) and the
# added complexity of a leaner multi-stage prune isn't worth it for a first version -- optimize
# later if image size or cold-start actually becomes a problem.
FROM node:20-slim AS build
WORKDIR /app

# Root + every workspace's package.json first (better layer caching -- `npm ci` only re-runs
# when a dependency actually changed, not on every source edit).
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/diagram-core/package.json packages/diagram-core/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY packages/diagram-core packages/diagram-core
COPY apps/api apps/api
# apps/web is NOT built or copied into this image (canvas-ycu keeps the existing split-origin
# topology: the frontend deploys separately to Storage static website hosting, matching
# docs/azure-deployment.md's already-working COOKIE_SAME_SITE=none configuration -- see
# infra/azure/README.md for the full reasoning). A root `npm run build` would try to build every
# workspace including web, so build diagram-core and api explicitly instead of `--workspaces`.
RUN npm run build --workspace=@canvas/diagram-core && npm run build --workspace=@canvas/api

# The runtime image still needs node_modules (this Dockerfile does not prune devDependencies,
# see the top-of-file note) and the migrations/ directory (read by dist/db/migrate.js at a path
# relative to itself, not bundled into the compiled JS).
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/diagram-core/dist packages/diagram-core/dist
COPY --from=build /app/packages/diagram-core/package.json packages/diagram-core/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/migrations apps/api/migrations

# Semgrep (dockerfile.security.missing-user) correctly flags running as root by default -- the
# official node:20-slim base already ships a non-root `node` user (uid/gid 1000) for exactly this,
# no separate useradd needed. chown happens as one layer over everything already copied, rather
# than --chown on each COPY above, so file ownership can't drift between them.
RUN chown -R node:node /app
USER node

EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
