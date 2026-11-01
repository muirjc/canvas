"""The database connection: SQLAlchemy Core over Postgres (psycopg 3) or SQLite, like Kysely in apps/api.

Core only, never the ORM (Constitution Principle VI: a query compiler, not an ORM).
"""

from __future__ import annotations

from fastapi import Request
from sqlalchemy import Engine, create_engine, event
from sqlalchemy.pool import StaticPool

from canvas_api.config import Settings


def sqlalchemy_url(settings: Settings) -> str:
    """The SQLAlchemy URL for the configured database."""
    if settings.db_client == "sqlite":
        return (
            "sqlite+pysqlite:///:memory:"
            if settings.database_url == ":memory:"
            else f"sqlite+pysqlite:///{settings.database_url}"
        )
    url = settings.database_url
    for prefix in ("postgresql://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix) :]
    return url


def create_db_engine(settings: Settings) -> Engine:
    if settings.db_client == "sqlite":
        # One shared connection for :memory: (each new connection would be an empty database).
        memory = settings.database_url == ":memory:"
        engine = create_engine(
            sqlalchemy_url(settings),
            connect_args={"check_same_thread": False},
            poolclass=StaticPool if memory else None,
        )

        @event.listens_for(engine, "connect")
        def _foreign_keys(dbapi_connection, _record):  # type: ignore[no-untyped-def]
            # The TypeScript service (better-sqlite3) enforces foreign keys; so must this one.
            dbapi_connection.execute("PRAGMA foreign_keys = ON")

        return engine
    return create_engine(sqlalchemy_url(settings), pool_pre_ping=True)


def get_engine(request: Request) -> Engine:
    """FastAPI dependency: the app's engine. Routes open their own connection or transaction with it,
    so a write is committed before the response goes out."""
    engine: Engine = request.app.state.db
    return engine
