# canvas-1bty.1: the Python backend's image. Build from the repository root (it needs
# apps/api/migrations, the schema both services share):
#   docker build -f apps/api-py/Dockerfile -t canvas-api-py .
# Not deployed yet: phase 0d (canvas-1bty.3) adds it to Azure as an internal container.

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
ENV PATH="/app/apps/api-py/.venv/bin:$PATH" PYTHONUNBUFFERED=1
USER canvas
EXPOSE 8000
CMD ["uvicorn", "canvas_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
