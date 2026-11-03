"""Applies the plain-SQL migrations in apps/api/migrations, recording them in `schema_migrations`.

A port of apps/api/src/db/migrate.ts: same table and same bookkeeping, so either runner can pick up where the
other left off. Postgres reads apps/api/migrations/*.sql, SQLite the squashed apps/api/migrations/sqlite/*.sql;
files apply in name order, each in its own transaction together with its schema_migrations row (a file that
fails leaves nothing behind). The migrate job (canvas_api.jobs.migrate) is the command-line front end; the
tests and the other jobs call run_migrations directly.
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import Engine, text

#: The one place the migrations' location is written (they move under apps/api-py with phase 12b).
MIGRATIONS_ROOT = Path(__file__).resolve().parents[3] / "api" / "migrations"


class MigrationError(RuntimeError):
    """A migration file failed; nothing of it was applied."""


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
        try:
            with engine.begin() as conn:
                driver = conn.connection.driver_connection
                if dialect == "sqlite":
                    # sqlite3 runs one statement per execute(); executescript runs the whole file, but commits
                    # first and then runs in autocommit, so the file opens its own transaction, which the
                    # schema_migrations insert joins and the block's commit (or rollback) ends.
                    driver.executescript("BEGIN;\n" + sql)  # type: ignore[union-attr]
                else:
                    # Straight to psycopg with no parameters, so a % in the SQL is just a %.
                    driver.execute(sql)  # type: ignore[union-attr]
                conn.execute(text("INSERT INTO schema_migrations (filename) VALUES (:f)"), {"f": file.name})
        except Exception as error:
            raise MigrationError(f"Migration {file.name} failed: {error}") from error
        applied.append(file.name)
    return applied
