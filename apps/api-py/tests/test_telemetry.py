"""Telemetry: route names, and (canvas-znz5) request, query and work spans as Application Insights gets them."""

import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind, StatusCode
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

from canvas_api.telemetry import (
    EXCLUDED_URLS,
    MAX_SQL_LENGTH,
    instrument_queries,
    query_span_name,
    route_template,
    work_span,
)


@pytest.mark.parametrize(
    ("fastapi_path", "expected"),
    [
        ("/health", "/health"),
        ("/diagrams/{id}", "/diagrams/:id"),
        ("/diagrams/{diagram_id}/versions/{version_id}/restore", "/diagrams/:diagram_id/versions/:version_id/restore"),
        ("/files/{path:path}", "/files/:path"),
    ],
)
def test_span_names_use_the_typescript_route_form(fastapi_path: str, expected: str) -> None:
    assert route_template(fastapi_path) == expected


def test_telemetry_is_off_without_a_connection_string() -> None:
    from fastapi import FastAPI

    from canvas_api.telemetry import configure_telemetry

    assert configure_telemetry(FastAPI(), None) is False


# --- canvas-znz5: query and work spans --------------------------------------------------------------------------


@pytest.fixture
def spans(monkeypatch: pytest.MonkeyPatch) -> Iterator[InMemorySpanExporter]:
    """Spans recorded in memory: the telemetry module's tracer comes from a local provider for the test."""
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(trace, "get_tracer", lambda name, *args, **kwargs: provider.get_tracer(name))
    yield exporter
    provider.shutdown()


@pytest.fixture
def engine() -> Engine:
    created = create_engine("sqlite://")
    instrument_queries(created)
    return created


def _named(exporter: InMemorySpanExporter, prefix: str) -> list[ReadableSpan]:
    return [s for s in exporter.get_finished_spans() if s.name.startswith(prefix)]


def test_a_query_inside_a_request_is_a_client_span_with_its_text(spans: InMemorySpanExporter, engine: Engine) -> None:
    with trace.get_tracer("test").start_as_current_span("GET /diagrams/:id") as request, engine.connect() as conn:
        conn.execute(text("SELECT :value AS answer"), {"value": "secret-value"})
    [query] = _named(spans, "SELECT")
    assert query.name == "SELECT sqlite"
    assert query.kind == SpanKind.CLIENT
    assert query.parent is not None and query.parent.span_id == request.get_span_context().span_id
    assert query.attributes == {"db.system.name": "sqlite", "db.query.text": "SELECT ? AS answer"}
    assert "secret-value" not in str(query.attributes)  # parameters, never values
    assert query.start_time is not None and query.end_time is not None and query.start_time <= query.end_time


def test_a_failed_query_is_marked_failed(spans: InMemorySpanExporter, engine: Engine) -> None:
    with (
        trace.get_tracer("test").start_as_current_span("GET /x"),
        engine.connect() as conn,
        pytest.raises(Exception, match="no such table"),
    ):
        conn.execute(text("SELECT * FROM missing_table"))
    [query] = _named(spans, "SELECT")
    assert query.status.status_code == StatusCode.ERROR


def test_queries_outside_a_request_make_no_spans(spans: InMemorySpanExporter, engine: Engine) -> None:
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
    assert spans.get_finished_spans() == ()


def test_long_query_text_is_cut(spans: InMemorySpanExporter, engine: Engine) -> None:
    long_sql = "SELECT 1 AS " + "x" * (MAX_SQL_LENGTH + 50)
    with trace.get_tracer("test").start_as_current_span("GET /x"), engine.connect() as conn:
        conn.execute(text(long_sql))
    [query] = _named(spans, "SELECT")
    assert query.attributes is not None
    assert query.attributes["db.query.text"] == long_sql[:MAX_SQL_LENGTH] + "…"


def test_query_span_names_take_the_first_word() -> None:
    assert query_span_name("  insert into t values (1)", "postgresql") == "INSERT postgresql"
    assert query_span_name("", "sqlite") == "QUERY sqlite"


def test_work_spans_time_app_work_and_record_failures(spans: InMemorySpanExporter) -> None:
    with trace.get_tracer("test").start_as_current_span("GET /x"):
        with work_span("render svg", {"canvas.diagram.family": "flowchart"}):
            pass
        with pytest.raises(ValueError, match="boom"), work_span("rasterize png"):
            raise ValueError("boom")
    [render] = _named(spans, "render svg")
    assert render.attributes == {"canvas.diagram.family": "flowchart"}
    [png] = _named(spans, "rasterize png")
    assert png.status.status_code == StatusCode.ERROR


def test_application_insights_gets_the_query_text_where_the_workbook_reads_it(
    spans: InMemorySpanExporter, engine: Engine
) -> None:
    """The exporter keeps db.* attributes out of customDimensions; the text goes in the dependency's `data` and the
    database in its `type` (the "Canvas performance" workbook queries those)."""
    from azure.monitor.opentelemetry.exporter.export.trace._exporter import _convert_span_to_envelope

    with trace.get_tracer("test").start_as_current_span("GET /x"), engine.connect() as conn:
        conn.execute(text("SELECT 1"))
    [query] = _named(spans, "SELECT")
    dependency = _convert_span_to_envelope(query).data.base_data  # type: ignore[union-attr]
    assert dependency.data == "SELECT 1"
    assert dependency.type == "SQL"  # SQLite; Postgres is "postgresql"
    assert "db.query.text" not in (dependency.properties or {})
    with trace.get_tracer("test").start_as_current_span(
        "SELECT postgresql",
        kind=SpanKind.CLIENT,
        attributes={"db.system.name": "postgresql", "db.query.text": "SELECT 2"},
    ):
        pass
    [postgres] = _named(spans, "SELECT postgresql")
    assert _convert_span_to_envelope(postgres).data.base_data.type == "postgresql"  # type: ignore[union-attr]


def test_the_real_app_sends_request_and_query_spans(tmp_path: Path) -> None:
    """canvas-znz5: one request span per request (named the TypeScript way) with its SQL queries under it, and no
    per-request internal spans (FastAPI's dependency/endpoint or ASGI send/receive spans would each become an
    "InProc" dependency in Application Insights), and none for /health. Run in its own process:
    configure_azure_monitor sets process-wide providers."""
    script = Path(__file__).parent / "data" / "telemetry_smoke.py"
    result = subprocess.run(  # noqa: S603 - fixed command, test only
        [sys.executable, str(script), str(tmp_path / "canvas.db")],
        capture_output=True,
        text=True,
        timeout=120,
        check=True,
    )
    lines = result.stdout.splitlines()
    assert "SERVER POST /auth/local/login -" in lines
    assert "SERVER GET /diagrams/:id -" in lines
    assert any(line.startswith("CLIENT SELECT sqlite SELECT u.id") for line in lines), lines
    assert not any(line.startswith("INTERNAL") for line in lines), lines
    # Azure's health probes are left out (EXCLUDED_URLS).
    assert not any("/health" in line for line in lines), lines


@pytest.mark.parametrize(
    ("url", "excluded"),
    [
        ("http://testserver/health", True),
        ("https://canvas-api.example.net/health", True),
        ("https://canvas-api.example.net/health/extra", False),
        ("https://canvas-api.example.net/diagrams/health", False),
        ("https://canvas-api.example.net/healthy", False),
    ],
)
def test_only_the_health_probe_is_left_out(url: str, excluded: bool) -> None:
    from opentelemetry.util.http import ExcludeList

    assert ExcludeList([EXCLUDED_URLS]).url_disabled(url) is excluded
