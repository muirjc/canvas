"""Telemetry to the same Application Insights resource as the TypeScript service (canvas-6upe).

Spans are named like the TypeScript service's ("GET /diagrams/:id"), so the "Canvas performance"
workbook and the key-route alert see one route whichever service answered it.
"""

from __future__ import annotations

import re

from fastapi import FastAPI, Request, Response
from opentelemetry import trace
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

_PARAM = re.compile(r"\{([^}:]+)(?::[^}]*)?\}")


def route_template(path: str) -> str:
    """FastAPI's "/diagrams/{id}" in the TypeScript service's form, "/diagrams/:id"."""
    return _PARAM.sub(r":\1", path)


class RouteNameMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        response = await call_next(request)
        route = request.scope.get("route")
        path = getattr(route, "path", None)
        if path:
            trace.get_current_span().update_name(f"{request.method} {route_template(path)}")
        return response


def configure_telemetry(app: FastAPI, connection_string: str | None) -> bool:
    """Sends traces to Application Insights when a connection string is set; off otherwise."""
    if not connection_string:
        return False
    from azure.monitor.opentelemetry import configure_azure_monitor

    configure_azure_monitor(connection_string=connection_string)
    app.add_middleware(RouteNameMiddleware)
    return True
