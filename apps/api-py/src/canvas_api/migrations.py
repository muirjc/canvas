"""Applies the plain-SQL migrations in apps/api/migrations, recording them in `schema_migrations`.

The SQL files stay the single source of the schema while both services run (no Alembic until the
TypeScript service is gone). Same table and same bookkeeping as apps/api/src/db/migrate.ts, so either
runner can pick up where the other left off. Until the migrate job moves to Python (phase 12) the
TypeScript runner is the one deployments use; this one serves the Python tests.
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import Engine, text

MIGRATIONS_ROOT = Path(__file__).resolve().parents[3] / "api" / "migrations"


# The bookkeeping table, as apps/api/src/db/migrate.ts creates it on each engine. Fixed statements:
# nothing from outside ever reaches this SQL.
_CREATE_TABLE = {
    "postgresql": text(
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        "filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
    ),
    "sqlite": text(
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        "filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ),
}


def migration_dir(dialect: str) -> Path:
    return MIGRATIONS_ROOT / "sqlite" if dialect == "sqlite" else MIGRATIONS_ROOT


def run_migrations(engine: Engine) -> list[str]:
    """Applies every not-yet-applied migration file in name order. Returns the files applied."""
    dialect = engine.dialect.name
    with engine.begin() as conn:
        conn.execute(_CREATE_TABLE[dialect])
        done = {row[0] for row in conn.execute(text("SELECT filename FROM schema_migrations"))}

    applied: list[str] = []
    for file in sorted(migration_dir(dialect).glob("*.sql")):
        if file.name in done:
            continue
        sql = file.read_text(encoding="utf-8")
        with engine.begin() as conn:
            driver = conn.connection.driver_connection
            if dialect == "sqlite":
                # sqlite3 runs one statement per execute(); executescript runs the whole file.
                driver.executescript(sql)  # type: ignore[union-attr]
            else:
                # Straight to psycopg with no parameters, so a % in the SQL is just a %.
                driver.execute(sql)  # type: ignore[union-attr]
            conn.execute(text("INSERT INTO schema_migrations (filename) VALUES (:f)"), {"f": file.name})
        applied.append(file.name)
    return applied
