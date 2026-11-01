# canvas-1bty.1: the Python backend's image. Build from the repository root (it needs
# apps/api/migrations, the schema both services share):
#   docker build -f apps/api-py/Dockerfile -t canvas-api-py .
# Not deployed yet: phase 0d (canvas-1bty.3) adds it to Azure as an internal container.

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
COPY --from=validator /app/packages/validator-cli/dist /app/packages/validator-cli/dist
ENV PATH="/app/apps/api-py/.venv/bin:$PATH" PYTHONUNBUFFERED=1 \
    CANVAS_VALIDATOR_DIR=/app/packages/validator-cli/dist
USER canvas
EXPOSE 8000
CMD ["uvicorn", "canvas_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
