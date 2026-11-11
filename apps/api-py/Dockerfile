# canvas-1bty.1: the Python backend's image, the only API image since canvas-1bty.16. Build from the
# repository root (it also needs the web app, the validator package, vendor-icons and the paused page):
#   docker build -f apps/api-py/Dockerfile -t canvas-api-py .
# canvas-1bty.14: Azure runs it as canvas-api, the front door, so it also carries the built web app and the
# paused page (modules/apiapp.bicep).

# canvas-1bty.11: the CI validator bundle Canvas commits with every GitHub submission
# (packages/validator-cli, one esbuild file plus the example workflow).
FROM node:26-slim AS validator
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/diagram-core/package.json packages/diagram-core/
COPY packages/validator-cli/package.json packages/validator-cli/
RUN npm ci --workspace=@canvas/validator-cli --workspace=@canvas/diagram-core --include-workspace-root=false
COPY packages/diagram-core packages/diagram-core
COPY packages/validator-cli packages/validator-cli
RUN npm run build --workspace=@canvas/validator-cli

# canvas-1bty.14: the web app (canvas-r3y): relative API URLs, Help bundling docs/, the licence notices, and
# .br/.gz copies of each text file.
FROM node:26-slim AS web
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/diagram-core/package.json packages/diagram-core/package.json
COPY packages/validator-cli/package.json packages/validator-cli/package.json
COPY packages/diagram-bridge/package.json packages/diagram-bridge/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY packages/diagram-core packages/diagram-core
COPY apps/web apps/web
COPY docs docs
# The web app's tests (type-checked by `tsc -b`) import the repo's .env reader (canvas-mywp).
COPY scripts/dotenv.mjs scripts/dotenv.d.mts scripts/
COPY LICENSE THIRD-PARTY-NOTICES.md ./
RUN npm run build --workspace=@canvas/diagram-core \
  && VITE_API_BASE_URL= npm run build --workspace=@canvas/web \
  && node apps/web/scripts/precompress.mjs apps/web/dist

FROM python:3.15-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.13.6 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app/apps/api-py
COPY apps/api-py/pyproject.toml apps/api-py/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY apps/api-py/src ./src
COPY apps/api-py/migrations ./migrations
RUN uv sync --frozen --no-dev

FROM python:3.15-slim AS runtime
RUN useradd --create-home --uid 10001 canvas
WORKDIR /app/apps/api-py
COPY --from=build /app/apps/api-py /app/apps/api-py
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
