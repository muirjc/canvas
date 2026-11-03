"""Local e2e reset (apps/api/src/seed/reset-e2e.ts, `npm run e2e:reset`): permanently deletes every diagram in
the seeded "Smoke Test" project (E2E_PROJECT_ID) and the e2e-user-* accounts local-user-management.spec.ts
creates, so local Playwright runs don't pile up hundreds of diagrams per run. apps/web's Playwright global setup
runs it before each LOCAL run (CI starts from an empty database); the demo seed then restores the project's
starting state. Only the "Smoke Test" fixture is touched. Refuses with NODE_ENV=production.

Usage: python -m canvas_api.jobs.e2e_reset
Env: DB_CLIENT (postgres | sqlite), DATABASE_URL, SESSION_SECRET (unused, but Settings requires it).
"""

from __future__ import annotations

import os
import sys

from sqlalchemy import Engine, text
from sqlalchemy.exc import SQLAlchemyError

from canvas_api.config import Settings
from canvas_api.db import create_db_engine
from canvas_api.migrations import run_migrations
from canvas_api.retention import purge_project_diagrams

#: A user's own rows that don't cascade with it, then the user. MFA rows cascade.
_DELETE_USER = (
    text("DELETE FROM sessions WHERE user_id = :id"),
    text("DELETE FROM users_personas WHERE user_id = :id"),
    text("DELETE FROM local_credentials WHERE user_id = :id"),
    text("DELETE FROM users WHERE id = :id"),
)


def remove_e2e_users(engine: Engine) -> tuple[int, int]:
    """Deletes the e2e-user-*@example.com accounts, each in its own transaction; one that owns or is referenced
    by something (a project, a share) is left alone. Returns (removed, found)."""
    with engine.connect() as conn:
        ids = [
            str(row[0]) for row in conn.execute(text("SELECT id FROM users WHERE email LIKE 'e2e-user-%@example.com'"))
        ]
    removed = 0
    for user_id in ids:
        try:
            with engine.begin() as conn:
                for statement in _DELETE_USER:
                    conn.execute(statement, {"id": user_id})
        except SQLAlchemyError:
            continue
        removed += 1
    return removed, len(ids)


def reset_e2e(engine: Engine) -> None:
    run_migrations(engine)
    removed, found = remove_e2e_users(engine)
    if found:
        print(f"e2e reset: removed {removed} of {found} e2e user account(s).")
    with engine.connect() as conn:
        project = conn.execute(text("SELECT id FROM projects WHERE name = 'Smoke Test' LIMIT 1")).first()
    if project is None:
        print('e2e reset: no "Smoke Test" project yet -- nothing to clear.')
        return
    purged = purge_project_diagrams(engine, str(project[0]))
    print(f'e2e reset: removed {len(purged)} diagram(s) from the "Smoke Test" project.')


def main() -> int:
    if os.environ.get("NODE_ENV") == "production":
        print("e2e:reset refuses to run with NODE_ENV=production.", file=sys.stderr)
        return 1
    settings = Settings()  # type: ignore[call-arg]  # read from the environment
    engine = create_db_engine(settings)
    try:
        reset_e2e(engine)
    finally:
        engine.dispose()
    return 0


if __name__ == "__main__":
    sys.exit(main())
