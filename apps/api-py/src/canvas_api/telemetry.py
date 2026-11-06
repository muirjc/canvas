"""Telemetry to the same Application Insights resource as the TypeScript service (canvas-6upe).

Spans are named like the TypeScript service's ("GET /diagrams/:id"), so the "Canvas performance"
workbook and the key-route alert see one route whichever service answered it.

canvas-znz5: azure-monitor-opentelemetry instruments FastAPI and httpx (GitHub, Entra, the AI providers) but not
SQLAlchemy, so `instrument_queries` adds one span per SQL query, as the TypeScript service's Kysely hook did, and
`work_span` times app work (rendering, validation, an AI turn) as its `withSpan` did. The exporter keeps every
`db.*` attribute out of customDimensions and puts the query text in the dependency's `data` column, which is what
the workbook reads.
"""

from __future__ import annotations

import re
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from fastapi import FastAPI, Request, Response
from opentelemetry import trace
from opentelemetry.trace import Span, SpanKind, Status, StatusCode
from sqlalchemy import event
from sqlalchemy.engine import Engine
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

_PARAM = re.compile(r"\{([^}:]+)(?::[^}]*)?\}")
_TRACER_NAME = "canvas_api"
#: Longer query text is cut here (with "…"), as in the TypeScript service.
MAX_SQL_LENGTH = 1000
_STARTS = "canvas_query_starts"


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


@contextmanager
def work_span(name: str, attributes: dict[str, Any] | None = None) -> Iterator[Span]:
    """Times a piece of app work as a child span of the current request; an exception marks it failed. A no-op
    when telemetry is off."""
    with trace.get_tracer(_TRACER_NAME).start_as_current_span(name, attributes=attributes or {}) as span:
        yield span


def query_span_name(statement: str, system: str) -> str:
    """`SELECT postgresql`: the statement's first word and the database, as the TypeScript service named them."""
    words = statement.split(None, 1)
    return f"{words[0].upper() if words else 'QUERY'} {system}"


def instrument_queries(engine: Engine) -> None:
    """One CLIENT span per SQL query run inside a request, back-dated to when the query started. The text is the
    parameterised statement: values are never included. Queries outside a request (migrations, jobs) are skipped."""
    system = engine.dialect.name

    @event.listens_for(engine, "before_cursor_execute")
    def _started(conn: Any, _cursor: Any, _statement: str, _params: Any, _context: Any, _many: bool) -> None:
        conn.info.setdefault(_STARTS, []).append(time.time_ns())

    def record(conn: Any, statement: str | None, failed: bool) -> None:
        starts = conn.info.get(_STARTS) if conn is not None else None
        if not starts:
            return
        started = starts.pop()
        if not trace.get_current_span().is_recording():
            return
        text = statement or ""
        span = trace.get_tracer(_TRACER_NAME).start_span(
            query_span_name(text, system),
            kind=SpanKind.CLIENT,
            start_time=started,
            attributes={
                "db.system.name": system,
                "db.query.text": text if len(text) <= MAX_SQL_LENGTH else f"{text[:MAX_SQL_LENGTH]}…",
            },
        )
        if failed:
            span.set_status(Status(StatusCode.ERROR))
        span.end()

    @event.listens_for(engine, "after_cursor_execute")
    def _finished(conn: Any, _cursor: Any, statement: str, _params: Any, _context: Any, _many: bool) -> None:
        record(conn, statement, failed=False)

    @event.listens_for(engine, "handle_error")
    def _failed(context: Any) -> None:
        record(context.connection, context.statement, failed=True)


def configure_telemetry(app: FastAPI, connection_string: str | None, engine: Engine | None = None) -> bool:
    """Sends traces to Application Insights when a connection string is set; off otherwise."""
    if not connection_string:
        return False
    from azure.monitor.opentelemetry import configure_azure_monitor
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    configure_azure_monitor(connection_string=connection_string)
    # canvas-znz5: this app is instrumented explicitly (create_app made it before configure_azure_monitor ran), so a
    # request is one span with its queries under it. Left to the default, each request also brought FastAPI
    # dependency/endpoint spans, and the ASGI send/receive spans are excluded here: Application Insights stores
    # every such span as an "InProc" dependency, which would fill the outbound-calls panel.
    if not getattr(app, "_is_instrumented_by_opentelemetry", False):
        FastAPIInstrumentor.instrument_app(app, exclude_spans=["receive", "send"])
    app.add_middleware(RouteNameMiddleware)
    if engine is not None:
        instrument_queries(engine)
    return True
