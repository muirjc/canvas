"""The FastAPI application."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import Engine

from canvas_api.config import Settings
from canvas_api.db import create_db_engine
from canvas_api.telemetry import configure_telemetry


def create_app(settings: Settings | None = None, engine: Engine | None = None) -> FastAPI:
    settings = settings or Settings()  # type: ignore[call-arg]  # read from the environment
    db = engine or create_db_engine(settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        yield
        if engine is None:
            db.dispose()

    app = FastAPI(title="Canvas API (Python)", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.settings = settings
    app.state.db = db
    configure_telemetry(app, settings.applicationinsights_connection_string)

    @app.get("/health", tags=["Health"])
    def health() -> dict[str, str]:
        """Same answer as the TypeScript service's /health."""
        return {"status": "ok"}

    return app
