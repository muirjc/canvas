"""Housekeeping purge (apps/api/src/purge/run.ts, `npm run purge`): physically deletes diagrams whose
soft-delete retention window (DIAGRAM_RETENTION_DAYS) has elapsed and drafts nobody saved within
DRAFT_RETENTION_HOURS, then projects past PROJECT_RETENTION_DAYS that no longer hold any diagrams or
sub-projects. Applies pending migrations first. Azure runs it nightly (the canvas-purge Container Apps Job).

Usage:
  python -m canvas_api.jobs.purge             # deletes
  python -m canvas_api.jobs.purge --dry-run   # lists the candidate ids, deletes nothing
Env: DB_CLIENT (postgres | sqlite), DATABASE_URL, SESSION_SECRET (unused, but Settings requires it).
"""

from __future__ import annotations

import sys

from canvas_api.config import Settings
from canvas_api.db import create_db_engine
from canvas_api.migrations import run_migrations
from canvas_api.retention import (
    DIAGRAM_RETENTION_DAYS,
    DRAFT_RETENTION_HOURS,
    PROJECT_RETENTION_DAYS,
    find_abandoned_draft_ids,
    find_expired_diagram_ids,
    find_expired_project_ids,
    purge_expired_diagrams,
    purge_expired_projects,
)


def _list_ids(heading: str, noun: str, retention_days: int, ids: list[str]) -> None:
    if not ids:
        print(f"No {noun} past their {retention_days}-day retention window — nothing to purge.")
        return
    print(f"{heading} past their {retention_days}-day retention window: {len(ids)}")
    for item in ids:
        print(f"  {item}")


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    dry_run = "--dry-run" in args
    settings = Settings()  # type: ignore[call-arg]  # read from the environment
    engine = create_db_engine(settings)
    try:
        run_migrations(engine)
        if dry_run:
            with engine.connect() as conn:
                diagrams = find_expired_diagram_ids(conn)
                drafts = find_abandoned_draft_ids(conn)
                projects = find_expired_project_ids(conn)
            _list_ids("[dry run] diagram(s) would be purged", "diagrams", DIAGRAM_RETENTION_DAYS, diagrams)
            print(
                f"[dry run] unsaved AI drafts older than {DRAFT_RETENTION_HOURS} hours that would be purged:"
                f" {len(drafts)}"
            )
            # Which expired projects would still be blocked can't be known without deleting the diagrams
            # first, so this lists every candidate.
            _list_ids(
                "[dry run] project(s) are candidates (purged only once they hold no diagrams or sub-projects)",
                "projects",
                PROJECT_RETENTION_DAYS,
                projects,
            )
            return 0

        # Diagrams first: a project is only purged once no diagram rows point at it.
        _list_ids("Purged diagram(s)", "diagrams", DIAGRAM_RETENTION_DAYS, purge_expired_diagrams(engine))
        result = purge_expired_projects(engine)
        _list_ids("Purged project(s)", "projects", PROJECT_RETENTION_DAYS, result.purged_project_ids)
        if result.skipped:
            print(f"Skipped {len(result.skipped)} expired project(s) still in use:")
            for skipped in result.skipped:
                print(f"  {skipped.id} ({skipped.reason})")
        return 0
    finally:
        engine.dispose()


if __name__ == "__main__":
    sys.exit(main())
