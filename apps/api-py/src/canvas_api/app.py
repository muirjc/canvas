"""The FastAPI application."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI
from sqlalchemy import Engine

from canvas_api.auth.session import SessionUser, current_user
from canvas_api.config import Settings
from canvas_api.db import create_db_engine
from canvas_api.diagram_core import BridgeError, DiagramBridge
from canvas_api.errors import register_error_handlers
from canvas_api.routes import admin_users, app_settings, comments, diagram_types, libraries, projects, sharing
from canvas_api.telemetry import configure_telemetry


def create_app(settings: Settings | None = None, engine: Engine | None = None) -> FastAPI:
    settings = settings or Settings()  # type: ignore[call-arg]  # read from the environment
    db = engine or create_db_engine(settings)
    bridge = DiagramBridge(settings.diagram_bridge_url) if settings.diagram_bridge_url else None

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        yield
        if bridge is not None:
            bridge.close()
        if engine is None:
            db.dispose()

    app = FastAPI(title="Canvas API (Python)", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.settings = settings
    app.state.db = db
    app.state.diagram_bridge = bridge
    configure_telemetry(app, settings.applicationinsights_connection_string)
    register_error_handlers(app)

    # The route groups apps/api forwards here (apps/api/src/python/route-groups.ts): phase 2
    # (canvas-1bty.6), then phase 3 (canvas-1bty.7).
    for group in (projects, diagram_types, libraries, app_settings, comments, sharing, admin_users):
        app.include_router(group.router)

    @app.get("/health", tags=["Health"])
    def health() -> dict[str, str]:
        """Same answer as the TypeScript service's /health."""
        return {"status": "ok"}

    @app.get("/py/me", tags=["Auth"])
    def python_me(user: Annotated[SessionUser, Depends(current_user)]) -> dict[str, str]:
        """canvas-1bty.2: who the Python service thinks is signed in. Proves a session made by the
        TypeScript service works here; removed once real routes have moved."""
        return {"id": user.id, "email": user.email, "role": user.role, "service": "python"}

    @app.get("/py/diagram-core", tags=["Diagnostics"])
    def python_diagram_core(_user: Annotated[SessionUser, Depends(current_user)]) -> dict[str, str]:
        """canvas-1bty.4: proves the Python service reaches diagram-core through the bridge (parses a
        one-line flowchart). Signed-in users only; removed once real routes use the bridge."""
        if bridge is None:
            return {"bridge": "not configured"}
        try:
            parsed = bridge.parse("flowchart", "flowchart TD\n  A --> B\n")
        except BridgeError:
            return {"bridge": "unreachable"}
        return {"bridge": "ok" if "model" in parsed else "error"}

    return app
