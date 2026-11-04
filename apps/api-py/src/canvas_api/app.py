"""The FastAPI application."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request, Response
from sqlalchemy import Engine
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from canvas_api.auth.graph import GraphClient
from canvas_api.auth.oidc import OidcClient
from canvas_api.auth.rate_limit import LoginRateLimiter
from canvas_api.config import Settings
from canvas_api.db import create_db_engine
from canvas_api.diagram_core import DiagramCore
from canvas_api.errors import register_error_handlers
from canvas_api.front_door import install as install_front_door
from canvas_api.github.client import GitHubClient
from canvas_api.routes import (
    admin_users,
    ai,
    app_settings,
    auth,
    comments,
    diagram_types,
    diagrams,
    export,
    github,
    libraries,
    library_admin,
    notifications,
    projects,
    sharing,
    standards,
)
from canvas_api.telemetry import configure_telemetry

#: Put on every response (as the TypeScript API's onSend hook did).
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
    oidc_transport: httpx.BaseTransport | None = None,
) -> FastAPI:
    """`github_transport`, `oidc_transport`: tests answer GitHub's API and the identity provider in-process
    (tests/fake_github.py)."""
    settings = settings or Settings()  # type: ignore[call-arg]  # read from the environment
    # canvas-1bty.11: a bad GitHub App key or URL fails startup here, not at first use.
    github_config = settings.github
    # canvas-1bty.13: so do bad sign-in settings (AUTH_MODE, the Entra issuer, the MFA key, LOGIN_RATE_LIMIT).
    oidc_config = settings.oidc
    _ = settings.mfa_encryption_key
    oidc_client = OidcClient(oidc_config, settings.web_origin_list[0], oidc_transport) if oidc_config else None
    db = engine or create_db_engine(settings)
    # canvas-1bty.15: diagram-core, native Python.
    diagram_core = DiagramCore()
    github_client = GitHubClient(github_config, github_transport) if github_config else None
    # canvas-2h2w.3: the Entra groups people can share with (through the identity platform's own HTTP client).
    graph_client = GraphClient(oidc_client, settings.graph_api_url) if oidc_client and settings.entra_groups else None

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        yield
        if github_client is not None:
            github_client.close()
        if oidc_client is not None:
            oidc_client.close()
        if engine is None:
            db.dispose()

    # canvas-1bty.16: FastAPI's own OpenAPI page at /docs, only with ENABLE_API_DOCS=true (the document too).
    docs = settings.enable_api_docs
    app = FastAPI(
        title="Canvas API",
        lifespan=lifespan,
        docs_url="/docs" if docs else None,
        openapi_url="/openapi.json" if docs else None,
        redoc_url=None,
    )
    app.state.settings = settings
    app.state.db = db
    app.state.diagram_core = diagram_core
    app.state.github_client = github_client
    app.state.oidc_client = oidc_client
    app.state.graph_client = graph_client
    app.state.login_rate_limiter = LoginRateLimiter(settings.login_rate_limit_per_minute)
    # canvas-1bty.12: tests replace the AI model (a callable: chosen model id -> LanguageModel) and the
    # provider clients used to list models; None = the configured provider.
    app.state.language_model = None
    app.state.anthropic_client = None
    app.state.openai_client = None
    configure_telemetry(app, settings.applicationinsights_connection_string)
    register_error_handlers(app)

    # The route groups, in the order they moved from TypeScript (canvas-1bty.6 to .14).
    for group in (
        auth,
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
        library_admin,
        notifications,
    ):
        app.include_router(group.router)

    @app.get("/health", tags=["Health"])
    def health() -> dict[str, str]:
        return {"status": "ok"}

    # canvas-1bty.14: the front door's jobs (the web app, paused mode, CORS), after every route so the web
    # app's files never shadow one.
    install_front_door(app, settings)
    # Outermost, so every response carries them: the front door's own (web files, 404s, the paused page) and
    # CORS preflights too.
    app.add_middleware(SecurityHeadersMiddleware)
    return app
