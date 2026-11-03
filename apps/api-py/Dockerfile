# canvas-1bty.1: the Python backend's image. Build from the repository root (it needs
# apps/api/migrations, the schema both services share):
#   docker build -f apps/api-py/Dockerfile -t canvas-api-py .
# canvas-1bty.14: Azure runs it as canvas-api, the front door, so it also carries the built web app and the
# paused page (modules/apiapp.bicep).

# canvas-1bty.11: the CI validator bundle Canvas commits with every GitHub submission
# (packages/validator-cli, one esbuild file plus the example workflow), as the canvas-api image builds it.
FROM node:22-slim AS validator
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/diagram-core/package.json packages/diagram-core/
COPY packages/validator-cli/package.json packages/validator-cli/
RUN npm ci --workspace=@canvas/validator-cli --workspace=@canvas/diagram-core --include-workspace-root=false
COPY packages/diagram-core packages/diagram-core
COPY packages/validator-cli packages/validator-cli
RUN npm run build --workspace=@canvas/validator-cli

# canvas-1bty.14: the web app, built as the repo-root Dockerfile builds it (canvas-r3y): relative API URLs,
# Help bundling docs/, the licence notices, and .br/.gz copies of each text file. A full `npm ci` with the
# C++ toolchain, as there (a workspace dependency compiles better-sqlite3 from source).
FROM node:22-slim AS web
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/diagram-core/package.json packages/diagram-core/package.json
COPY packages/validator-cli/package.json packages/validator-cli/package.json
COPY packages/diagram-bridge/package.json packages/diagram-bridge/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY packages/diagram-core packages/diagram-core
COPY apps/web apps/web
COPY docs docs
COPY LICENSE THIRD-PARTY-NOTICES.md ./
RUN npm run build --workspace=@canvas/diagram-core \
  && VITE_API_BASE_URL= npm run build --workspace=@canvas/web \
  && node apps/web/scripts/precompress.mjs apps/web/dist

FROM python:3.13-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app/apps/api-py
COPY apps/api-py/pyproject.toml apps/api-py/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY apps/api-py/src ./src
RUN uv sync --frozen --no-dev

FROM python:3.13-slim AS runtime
RUN useradd --create-home --uid 10001 canvas
WORKDIR /app/apps/api-py
COPY --from=build /app/apps/api-py /app/apps/api-py
COPY apps/api/migrations /app/apps/api/migrations
# jmuir-dtu.29: a locally generated AWS icon library (vendor-icons/aws-icons.json), if the deploying machine has
# one -- the catalog seed job (canvas_api.jobs.seed_catalog) loads it in place of the placeholder AWS icons. The
# folder always exists (its README is committed), so this COPY never fails when the file is absent.
COPY vendor-icons /app/vendor-icons
COPY --from=validator /app/packages/validator-cli/dist /app/packages/validator-cli/dist
COPY --from=web /app/apps/web/dist /app/apps/web/dist
COPY infra/azure/paused.html /app/paused.html
ENV PATH="/app/apps/api-py/.venv/bin:$PATH" PYTHONUNBUFFERED=1 \
    CANVAS_VALIDATOR_DIR=/app/packages/validator-cli/dist \
    WEB_DIST_DIR=/app/apps/web/dist PAUSED_PAGE_PATH=/app/paused.html
USER canvas
EXPOSE 8000
CMD ["uvicorn", "canvas_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
