"""Test databases: TEST_DB_CLIENT=postgres|sqlite, like the TypeScript suite.

Postgres uses its own schema, canvas_py, inside the TypeScript tests' database (canvas_test on
localhost:5433, locally and in CI), so both suites can run on one machine without touching each
other's tables. The schema is recreated for each test session.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine

from canvas_api.app import create_app
from canvas_api.config import Settings
from canvas_api.db import create_db_engine
from canvas_api.migrations import run_migrations

#: The TypeScript tests' fixed session secret (apps/api/src/config.ts TEST_SESSION_SECRET).
TEST_SESSION_SECRET = "test-secret-at-least-32-characters-long"
PG_DATABASE = "postgresql://canvas:canvas_dev_password@localhost:5433/canvas_test"
PG_SCHEMA = "canvas_py"


def _fresh_postgres() -> str:
    with psycopg.connect(PG_DATABASE, autocommit=True) as conn:
        conn.execute(f"DROP SCHEMA IF EXISTS {PG_SCHEMA} CASCADE")
        conn.execute(f"CREATE SCHEMA {PG_SCHEMA}")
    return f"{PG_DATABASE}?options=-csearch_path%3D{PG_SCHEMA}"


#: canvas-1bty.8: the diagram-core bridge (packages/diagram-bridge), for routes that parse or validate.
BRIDGE_BUNDLE = Path(__file__).resolve().parents[3] / "packages" / "diagram-bridge" / "dist" / "bridge.mjs"
BRIDGE_AVAILABLE = shutil.which("node") is not None and BRIDGE_BUNDLE.exists()
if not BRIDGE_AVAILABLE and os.environ.get("REQUIRE_BRIDGE") == "1":
    raise RuntimeError("REQUIRE_BRIDGE=1 but node or packages/diagram-bridge/dist/bridge.mjs is missing")


@pytest.fixture(scope="session")
def bridge_url() -> Iterator[str | None]:
    """One bridge process for the whole run, or None without Node and the built bundle."""
    if not BRIDGE_AVAILABLE:
        yield None
        return
    proc = subprocess.Popen(  # noqa: S603 - fixed command, test only
        ["node", str(BRIDGE_BUNDLE)],  # noqa: S607
        env={**os.environ, "BRIDGE_PORT": "0", "BRIDGE_HOST": "127.0.0.1"},
        stdout=subprocess.PIPE,
        text=True,
    )
    assert proc.stdout is not None
    line = proc.stdout.readline()
    match = re.search(r":(\d+)$", line.strip())
    assert match, f"unexpected bridge output: {line!r}"
    yield f"http://127.0.0.1:{match.group(1)}"
    proc.terminate()
    proc.wait(timeout=5)


@pytest.fixture()
def needs_bridge(bridge_url: str | None) -> str:
    """Skips a test that needs the bridge when it isn't available (never in CI: REQUIRE_BRIDGE=1)."""
    if bridge_url is None:
        pytest.skip("needs node and packages/diagram-bridge/dist/bridge.mjs")
    return bridge_url


@pytest.fixture(scope="session")
def settings(bridge_url: str | None) -> Settings:
    client = os.environ.get("TEST_DB_CLIENT", "postgres")
    common = {"SESSION_SECRET": TEST_SESSION_SECRET, **({"DIAGRAM_BRIDGE_URL": bridge_url} if bridge_url else {})}
    if client == "sqlite":
        return Settings(DB_CLIENT="sqlite", DATABASE_URL=":memory:", **common)
    return Settings(DB_CLIENT="postgres", DATABASE_URL=_fresh_postgres(), **common)


@pytest.fixture(scope="session")
def engine(settings: Settings) -> Iterator[Engine]:
    engine = create_db_engine(settings)
    run_migrations(engine)
    yield engine
    engine.dispose()


@pytest.fixture()
def client(settings: Settings, engine: Engine) -> Iterator[TestClient]:
    with TestClient(create_app(settings, engine)) as test_client:
        yield test_client


@pytest.fixture()
def api(client: TestClient, engine: Engine) -> Iterator[Any]:
    """A clean database and a contract-checking client (tests/api.py)."""
    from tests.api import Api, reset

    reset(engine)
    yield Api(client, engine)
