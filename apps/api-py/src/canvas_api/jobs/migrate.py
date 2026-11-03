"""Applies the pending database migrations (apps/api/src/db/migrate.ts, `npm run migrate`). Run on every
deploy before the app starts (Azure: the canvas-migrate Container Apps Job).

Usage: python -m canvas_api.jobs.migrate
Env: DB_CLIENT (postgres | sqlite), DATABASE_URL, SESSION_SECRET (unused, but Settings requires it).
"""

from __future__ import annotations

import sys

from canvas_api.config import Settings
from canvas_api.db import create_db_engine
from canvas_api.migrations import MigrationError, run_migrations


def main() -> int:
    settings = Settings()  # type: ignore[call-arg]  # read from the environment
    engine = create_db_engine(settings)
    try:
        applied = run_migrations(engine)
    except MigrationError as error:
        print(error, file=sys.stderr)
        return 1
    finally:
        engine.dispose()
    if applied:
        print(f"Applied {len(applied)} migration(s): {', '.join(applied)}")
    else:
        print("No pending migrations.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
