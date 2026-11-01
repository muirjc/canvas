"""Test databases: TEST_DB_CLIENT=postgres|sqlite, like the TypeScript suite.

Postgres uses its own schema, canvas_py, inside the TypeScript tests' database (canvas_test on
localhost:5433, locally and in CI), so both suites can run on one machine without touching each
other's tables. The schema is recreated for each test session.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
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


@pytest.fixture(scope="session")
def settings() -> Settings:
    client = os.environ.get("TEST_DB_CLIENT", "postgres")
    common = {"SESSION_SECRET": TEST_SESSION_SECRET}
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
