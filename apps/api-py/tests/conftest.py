"""Test databases: TEST_DB_CLIENT=postgres|sqlite, like the TypeScript suite.

Postgres uses its own schema, canvas_py, inside the TypeScript tests' database (canvas_test on
localhost:5433, locally and in CI), so both suites can run on one machine without touching each
other's tables. The schema is recreated for each test session.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import psycopg
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine

from canvas_api.app import create_app
from canvas_api.config import Settings
from canvas_api.db import create_db_engine
from canvas_api.migrations import run_migrations

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
    if client == "sqlite":
        return Settings(DB_CLIENT="sqlite", DATABASE_URL=":memory:")
    return Settings(DB_CLIENT="postgres", DATABASE_URL=_fresh_postgres())


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
