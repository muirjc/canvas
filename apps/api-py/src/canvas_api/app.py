"""The FastAPI application."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, Request, Response
from sqlalchemy import Engine
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from canvas_api.auth.session import SessionUser, current_user
from canvas_api.config import Settings
from canvas_api.db import create_db_engine
from canvas_api.diagram_core import BridgeError, DiagramBridge
from canvas_api.errors import register_error_handlers
from canvas_api.github.client import GitHubClient
from canvas_api.routes import (
    admin_users,
    ai,
    app_settings,
    comments,
    diagram_types,
    diagrams,
    export,
    github,
    libraries,
    projects,
    sharing,
    standards,
)
from canvas_api.telemetry import configure_telemetry

#: The headers apps/api's onSend hook puts on every response (app.ts). Behind the TypeScript front door
#: it sets them again on forwarded responses; Python sets them itself so nothing changes when it becomes
#: the front door (phase 10).
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
}


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        response = await call_next(request)
        for name, value in SECURITY_HEADERS.items():
            response.headers[name] = value
        return response


def create_app(
    settings: Settings | None = None,
    engine: Engine | None = None,
    github_transport: httpx.BaseTransport | None = None,
) -> FastAPI:
    """`github_transport`: tests answer GitHub's API in-process (tests/fake_github.py)."""
    settings = settings or Settings()  # type: ignore[call-arg]  # read from the environment
    # canvas-1bty.11: a bad GitHub App key or URL fails startup here, not at first use.
    github_config = settings.github
    db = engine or create_db_engine(settings)
    bridge = DiagramBridge(settings.diagram_bridge_url) if settings.diagram_bridge_url else None
    github_client = GitHubClient(github_config, github_transport) if github_config else None

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        yield
        if bridge is not None:
            bridge.close()
        if github_client is not None:
            github_client.close()
        if engine is None:
            db.dispose()

    app = FastAPI(title="Canvas API (Python)", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.settings = settings
    app.state.db = db
    app.state.diagram_bridge = bridge
    app.state.github_client = github_client
    # canvas-1bty.12: tests replace the AI model (a callable: chosen model id -> LanguageModel) and the
    # provider clients used to list models; None = the configured provider.
    app.state.language_model = None
    app.state.anthropic_client = None
    app.state.openai_client = None
    configure_telemetry(app, settings.applicationinsights_connection_string)
    app.add_middleware(SecurityHeadersMiddleware)
    register_error_handlers(app)

    # The route groups apps/api forwards here (apps/api/src/python/route-groups.ts): phase 2
    # (canvas-1bty.6), phase 3 (canvas-1bty.7), phase 4 (canvas-1bty.8), phase 5 (canvas-1bty.9),
    # phase 6 (canvas-1bty.10), phase 7 (canvas-1bty.11), phase 8 (canvas-1bty.12).
    for group in (
        projects,
        diagram_types,
        libraries,
        app_settings,
        comments,
        sharing,
        admin_users,
        diagrams,
        standards,
        export,
        github,
        ai,
    ):
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
