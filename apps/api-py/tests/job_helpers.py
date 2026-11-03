"""A database of its own for the command-line job tests (canvas_api/jobs): a job builds its engine from the
environment and disposes of it at the end, so it can't share the suite's engine (on SQLite that is one
:memory: connection, gone once disposed). Postgres: a fresh schema in the test database. SQLite: a file.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import psycopg
import pytest
from sqlalchemy import Engine

from canvas_api.config import Settings
from canvas_api.db import create_db_engine
from tests.conftest import PG_DATABASE, TEST_SESSION_SECRET

JOBS_SCHEMA = "canvas_py_jobs"


@dataclass
class JobDb:
    settings: Settings
    engine: Engine

    def use(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Points the environment (what a job reads) at this database."""
        monkeypatch.setenv("DB_CLIENT", self.settings.db_client)
        monkeypatch.setenv("DATABASE_URL", self.settings.database_url)
        monkeypatch.setenv("SESSION_SECRET", TEST_SESSION_SECRET)


@pytest.fixture(name="job_db")
def job_db_fixture(settings: Settings, tmp_path: Path) -> Iterator[JobDb]:
    """An empty database (no tables at all), and an engine on it for the test's own seeding and checks."""
    if settings.db_client == "sqlite":
        job_settings = settings.model_copy(update={"database_url": str(tmp_path / "jobs.db")})
    else:
        with psycopg.connect(PG_DATABASE, autocommit=True) as conn:
            conn.execute(f"DROP SCHEMA IF EXISTS {JOBS_SCHEMA} CASCADE")
            conn.execute(f"CREATE SCHEMA {JOBS_SCHEMA}")
        job_settings = settings.model_copy(
            update={"database_url": f"{PG_DATABASE}?options=-csearch_path%3D{JOBS_SCHEMA}"}
        )
    engine = create_db_engine(job_settings)
    yield JobDb(job_settings, engine)
    engine.dispose()
    if settings.db_client != "sqlite":
        with psycopg.connect(PG_DATABASE, autocommit=True) as conn:
            conn.execute(f"DROP SCHEMA IF EXISTS {JOBS_SCHEMA} CASCADE")
