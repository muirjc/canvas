# canvas-ycu: production image for apps/api, built from the repo root so npm workspace
# resolution (apps/api -> @canvas/diagram-core) works exactly as it does locally -- no
# dereference-symlinks zip trick like docs/azure-deployment.md's older App Service path needed.
#
# node:22-slim (Debian glibc), not alpine: @resvg/resvg-js (apps/api's SVG->PNG export renderer)
# ships prebuilt native binaries per platform via npm optionalDependencies: `npm ci` on Linux
# fetches the right one automatically, but alpine's musl libc is a real compatibility risk for
# native modules that only publish glibc builds -- slim avoids that question entirely rather than
# debugging it on a first deploy. Node 22 (not 20) to match this project's actual documented/CI-
# pinned runtime (README.md, RUNBOOK.md, .github/workflows/ci.yml's NODE_VERSION) -- this image was
# stuck on node:20-slim, and better-sqlite3@13.0.3 declares `engines: {node: '>=22'}`, so node:20
# triggered an EBADENGINE warning on top of its own separate problem below.
#
# python3/make/g++ in the build stage only (never copied into the runtime stage): a real,
# independently-confirmed break found live during canvas-haz's Phase 7 deploy -- unlike
# @resvg/resvg-js, better-sqlite3 has NO prebuilt-binary install path at all (confirmed directly:
# its package.json has no "install"/postinstall script and no prebuild-install dependency; node-gyp
# auto-runs because a binding.gyp is present). It always compiles its bundled SQLite C amalgamation
# from source via node-gyp at `npm ci` time, on every platform, every time -- CLAUDE.md's prior
# claim that this project had "confirmed" a prebuilt binary was never actually verified against a
# truly from-scratch Docker build (this Dockerfile's own build had apparently never been exercised
# end-to-end before, since a local dev machine/WSL distro's ambient python3 masks the gap). Without
# a C++ compiler and Python, `npm ci` fails outright on this base image (and would on node:20-slim
# too, independent of the engines mismatch above -- confirmed by reproducing the failure on both).
#
# Single stage, no --omit=dev pruning: this repo has no build step that needs devDependencies
# gone from the runtime image (no native compiler toolchain, no huge unused packages) and the
# added complexity of a leaner multi-stage prune isn't worth it for a first version -- optimize
# later if image size or cold-start actually becomes a problem.
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Root + every workspace's package.json first (better layer caching -- `npm ci` only re-runs
# when a dependency actually changed, not on every source edit).
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/diagram-core/package.json packages/diagram-core/package.json
COPY packages/validator-cli/package.json packages/validator-cli/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY packages/diagram-core packages/diagram-core
COPY packages/validator-cli packages/validator-cli
COPY apps/api apps/api
# canvas-r3y: the web app is built here and served by the API from its own origin (one origin:
# first-party session cookie, no CORS preflight, one IP allow-list rule). Relative API URLs
# (VITE_API_BASE_URL empty); Help bundles docs/user-guide + docs/admin-guide; the build also
# emits the licence notices. Each text file gets .br/.gz copies served by @fastify/static.
COPY apps/web apps/web
COPY docs docs
COPY LICENSE THIRD-PARTY-NOTICES.md ./
RUN npm run build --workspace=@canvas/diagram-core && npm run build --workspace=@canvas/api
# canvas-3s5.3: the CI validator bundle (dist/validator.mjs + the example workflow), which the API
# commits to repositories with each GitHub submission.
RUN npm run build --workspace=@canvas/validator-cli
RUN VITE_API_BASE_URL= npm run build --workspace=@canvas/web && node apps/web/scripts/precompress.mjs apps/web/dist

# The runtime image still needs node_modules (this Dockerfile does not prune devDependencies,
# see the top-of-file note) and the migrations/ directory (read by dist/db/migrate.js at a path
# relative to itself, not bundled into the compiled JS).
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/diagram-core/dist packages/diagram-core/dist
COPY --from=build /app/packages/diagram-core/package.json packages/diagram-core/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/migrations apps/api/migrations
COPY --from=build /app/packages/validator-cli/dist packages/validator-cli/dist
# jmuir-dtu.29: a locally generated AWS icon library (vendor-icons/aws-icons.json), if the deploying
# machine has one -- the catalog seed loads it in place of the placeholder AWS icons. The folder
# always exists (its README is committed), so this COPY never fails when the file is absent.
COPY vendor-icons vendor-icons
# canvas-qrvn: the licence and the third-party notices the bundled npm packages require.
COPY LICENSE THIRD-PARTY-NOTICES.md ./
# canvas-r3y: the web app, and the page shown while the environment is paused.
COPY --from=build /app/apps/web/dist apps/web/dist
COPY infra/azure/paused.html paused.html
ENV WEB_DIST_DIR=/app/apps/web/dist PAUSED_PAGE_PATH=/app/paused.html

# Semgrep (dockerfile.security.missing-user) correctly flags running as root by default -- the
# official node:22-slim base already ships a non-root `node` user (uid/gid 1000) for exactly this,
# no separate useradd needed. chown happens as one layer over everything already copied, rather
# than --chown on each COPY above, so file ownership can't drift between them.
RUN chown -R node:node /app
USER node

EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
