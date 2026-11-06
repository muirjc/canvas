"""Run by tests/test_telemetry.py in its own process (configure_azure_monitor sets process-wide providers): the real
app with a connection string that points nowhere, every span kept in memory. Prints one line per span:
"<KIND> <name> <db.query.text or ->"."""

from __future__ import annotations

import os
import sys

os.environ.update(
    {
        "DB_CLIENT": "sqlite",
        "DATABASE_URL": sys.argv[1],
        "SESSION_SECRET": "x" * 40,
        "AUTH_MODE": "local",
        "ALLOW_LOCAL_AUTH": "true",
        "OTEL_TRACES_SAMPLER": "always_on",
        "APPLICATIONINSIGHTS_CONNECTION_STRING": (
            "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=http://127.0.0.1:9/"
        ),
    }
)

from fastapi.testclient import TestClient
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from canvas_api.app import create_app
from canvas_api.config import Settings
from canvas_api.db import create_db_engine
from canvas_api.migrations import run_migrations

engine = create_db_engine(Settings())  # type: ignore[call-arg]
run_migrations(engine)
app = create_app(engine=engine)
provider = trace.get_tracer_provider()
assert isinstance(provider, TracerProvider)
memory = InMemorySpanExporter()
provider.add_span_processor(SimpleSpanProcessor(memory))
with TestClient(app) as client:
    client.post("/auth/local/login", json={"email": "nobody@example.com", "password": "wrong-password-123"})
    client.get("/diagrams/00000000-0000-0000-0000-000000000000")
for span in memory.get_finished_spans():
    query = (span.attributes or {}).get("db.query.text", "-")
    print(f"{span.kind.name} {span.name} {str(query)[:40]}")
