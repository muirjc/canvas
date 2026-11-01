"""Syncs every open pull request Canvas opened with GitHub (apps/api/src/github/sync-run.ts): merged =
approved, closed = rejected, open = its review and check state. Run on a schedule (Azure: the
canvas-github-sync Container Apps Job, every 15 minutes); the editor also refreshes on demand.

Usage: python -m canvas_api.github.sync_run
"""

from __future__ import annotations

import sys

from canvas_api.config import Settings
from canvas_api.db import create_db_engine
from canvas_api.github.client import GitHubClient
from canvas_api.github.sync import sync_open_submissions


def main() -> int:
    settings = Settings()  # type: ignore[call-arg]  # read from the environment
    config = settings.github
    if config is None:
        print("GitHub is not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY) -- nothing to sync.")
        return 0
    engine = create_db_engine(settings)
    client = GitHubClient(config)
    try:
        counts = sync_open_submissions(client, engine)
    finally:
        client.close()
        engine.dispose()
    # Counts only.
    summary = (
        f"Synced pull requests: {counts['open']} still open, {counts['merged']} merged (approved),"
        f" {counts['closed']} closed (rejected), {counts['error']} failed"
    )
    if counts["rateLimited"]:
        summary += f"; GitHub rate limit reached, {counts['skipped']} left for the next run."
    else:
        summary += "."
    print(summary)
    return 1 if counts["error"] > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
