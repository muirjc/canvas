"""The migration runner (canvas_api/migrations.py) and its command, canvas_api.jobs.migrate (a port of
apps/api/src/db/migrate.ts). Each test runs against an empty database of its own (tests/job_helpers.py).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import inspect, text

from canvas_api import migrations
from canvas_api.jobs import migrate as migrate_job
from canvas_api.migrations import MigrationError, migration_dir, run_migrations
from tests.job_helpers import JobDb, job_db_fixture  # noqa: F401 - fixture


def applied(job_db: JobDb) -> list[str]:
    with job_db.engine.connect() as conn:
        return [r[0] for r in conn.execute(text("SELECT filename FROM schema_migrations ORDER BY filename"))]


def tables(job_db: JobDb) -> set[str]:
    return set(inspect(job_db.engine).get_table_names())


def test_the_job_applies_every_migration_in_name_order_then_has_nothing_to_do(
    job_db: JobDb, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    job_db.use(monkeypatch)
    files = sorted(p.name for p in migration_dir(job_db.engine.dialect.name).glob("*.sql"))
    assert files

    assert migrate_job.main() == 0
    assert capsys.readouterr().out == f"Applied {len(files)} migration(s): {', '.join(files)}\n"
    assert applied(job_db) == files
    assert {"diagrams", "projects", "users", "schema_migrations"} <= tables(job_db)

    assert migrate_job.main() == 0
    assert capsys.readouterr().out == "No pending migrations.\n"


@pytest.fixture()
def scratch_migrations(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A migrations folder of the test's own (both layouts: Postgres files at the top, SQLite's in sqlite/)."""
    (tmp_path / "sqlite").mkdir()
    monkeypatch.setattr(migrations, "MIGRATIONS_ROOT", tmp_path)
    return tmp_path


def write(root: Path, dialect: str, name: str, sql: str) -> None:
    (root / "sqlite" / name if dialect == "sqlite" else root / name).write_text(sql, encoding="utf-8")


def test_a_failing_file_leaves_nothing_behind_and_stops_the_run(job_db: JobDb, scratch_migrations: Path) -> None:
    dialect = job_db.engine.dialect.name
    write(scratch_migrations, dialect, "0001_first.sql", "CREATE TABLE first_table (id INTEGER PRIMARY KEY);\n")
    write(
        scratch_migrations,
        dialect,
        "0002_broken.sql",
        "CREATE TABLE half_done (id INTEGER PRIMARY KEY);\nINSERT INTO half_done VALUES (1);\nNOT SQL AT ALL;\n",
    )
    write(scratch_migrations, dialect, "0003_later.sql", "CREATE TABLE later_table (id INTEGER PRIMARY KEY);\n")

    with pytest.raises(MigrationError, match=r"^Migration 0002_broken\.sql failed: "):
        run_migrations(job_db.engine)

    assert applied(job_db) == ["0001_first.sql"]
    assert "first_table" in tables(job_db)
    assert "half_done" not in tables(job_db)
    assert "later_table" not in tables(job_db)

    # Fixed, the next run picks up where it stopped.
    write(scratch_migrations, dialect, "0002_broken.sql", "CREATE TABLE half_done (id INTEGER PRIMARY KEY);\n")
    assert run_migrations(job_db.engine) == ["0002_broken.sql", "0003_later.sql"]
    assert run_migrations(job_db.engine) == []


def test_the_job_reports_a_failing_file_and_exits_1(
    job_db: JobDb,
    scratch_migrations: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    job_db.use(monkeypatch)
    write(scratch_migrations, job_db.engine.dialect.name, "0001_broken.sql", "NOT SQL AT ALL;\n")
    assert migrate_job.main() == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.startswith("Migration 0001_broken.sql failed: ")


def test_only_sql_files_count_and_a_percent_sign_is_just_a_percent_sign(
    job_db: JobDb, scratch_migrations: Path
) -> None:
    dialect = job_db.engine.dialect.name
    write(scratch_migrations, dialect, "0001_note.txt", "NOT SQL AT ALL;\n")
    write(
        scratch_migrations,
        dialect,
        "0002_percent.sql",
        "CREATE TABLE notes (body TEXT);\nINSERT INTO notes VALUES ('100% done');\n",
    )
    assert run_migrations(job_db.engine) == ["0002_percent.sql"]
    with job_db.engine.connect() as conn:
        assert conn.execute(text("SELECT body FROM notes")).scalar() == "100% done"
