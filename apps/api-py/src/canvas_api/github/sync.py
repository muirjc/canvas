"""Keeps Canvas's view of each open pull request current (apps/api/src/github/status-sync.service.ts):
merged (approved), closed (rejected), or still open with its review and check state.

Canvas polls (webhooks can't reach it behind the IP allow-list): on demand from the editor (throttled) and
from a scheduled job (`python -m canvas_api.github.sync_run`).
"""

from __future__ import annotations

import json
import re
from datetime import timedelta
from typing import Any

from sqlalchemy import Engine, text

from canvas_api.github.client import (
    SUBMIT_PERMISSIONS,
    Check,
    GitHubAccessError,
    GitHubApiError,
    GitHubClient,
    GitHubRateLimitError,
    RepoRef,
    Review,
)
from canvas_api.github.jstext import js_slice
from canvas_api.github.submissions import record_pull_state
from canvas_api.timestamps import now_utc, parse_instant, to_db


class SubmissionNotOpenError(Exception):
    pass


#: A refresh within this long of the last one reuses it instead of asking GitHub again.
REFRESH_THROTTLE = timedelta(seconds=30)

_OPEN_FOR_DIAGRAM = text("SELECT * FROM diagram_submissions WHERE diagram_id = :diagram AND state = 'open'")
_SET_SYNC_ERROR = text("UPDATE diagram_submissions SET last_synced_at = :now, last_sync_error = :error WHERE id = :id")


def summarize_reviews(reviews: list[Review], requested_reviewers: list[str]) -> tuple[str, list[dict[str, str]]]:
    """Each reviewer's latest decision (a comment doesn't replace an approval or a change request)."""
    latest: dict[str, str] = {}
    for review in reviews:
        if review.state in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED"):
            latest[review.login] = review.state
    decisions = [{"login": login, "state": state} for login, state in latest.items() if state != "DISMISSED"]
    state = "none"
    if any(d["state"] == "CHANGES_REQUESTED" for d in decisions):
        state = "changes_requested"
    elif requested_reviewers:
        state = "pending"
    elif any(d["state"] == "APPROVED" for d in decisions):
        state = "approved"
    return state, decisions


def summarize_checks(checks: list[Check]) -> str:
    if not checks:
        return "none"
    if any(c["state"] == "failure" for c in checks):
        return "failure"
    if any(c["state"] == "pending" for c in checks):
        return "pending"
    return "success"


def sync_submission(client: GitHubClient, db: Engine, submission_id: str) -> str:
    """Syncs one submission with GitHub. Errors are recorded on the row (and the link), not raised.
    Returns open | merged | closed | error | skipped | rateLimited."""
    with db.connect() as conn:
        row = conn.execute(text("SELECT * FROM diagram_submissions WHERE id = :id"), {"id": submission_id}).first()
    if row is None or row.state != "open" or row.pr_number is None:
        return "skipped"
    repo = RepoRef(row.repo_owner, row.repo_name)
    try:
        # Not narrowed to permissions: Checks / Commit statuses may not have been granted, and the pull request
        # is still worth syncing without them.
        token = client.installation_token(int(row.installation_id), [int(row.repo_id)])
        pull = client.get_pull_request(token, repo, row.pr_number)
        with db.begin() as conn:
            state = record_pull_state(conn, str(row.id), pull, row.last_pushed_commit_sha)
        if state != "open":
            return state

        review_state, decisions = summarize_reviews(
            client.list_reviews(token, repo, pull.number), pull.requested_reviewers
        )
        checks: list[Check] = []
        try:
            checks = client.list_checks(token, repo, pull.head_sha)
            checks_state = summarize_checks(checks)
        except GitHubApiError as error:
            if error.status not in (403, 404):
                raise
            checks_state = "unavailable"
        detail = {"checks": checks, "reviews": decisions, "requestedReviewers": pull.requested_reviewers}
        with db.begin() as conn:
            conn.execute(
                text(
                    "UPDATE diagram_submissions SET review_state = :review, checks_state = :checks,"
                    " status_detail = :detail, last_synced_at = :now, last_sync_error = NULL WHERE id = :id"
                ),
                {
                    "review": review_state,
                    "checks": checks_state,
                    "detail": json.dumps(detail, separators=(",", ":"), ensure_ascii=False),
                    "now": to_db(now_utc(), conn.dialect.name),
                    "id": str(row.id),
                },
            )
        return "open"
    except Exception as error:
        return _record_sync_error(db, row, error)


def _record_sync_error(db: Engine, row: Any, error: Exception) -> str:
    # canvas-3s5.4: GitHub asked us to wait. Recorded on the submission, but it's not lost access.
    with db.begin() as conn:
        now = to_db(now_utc(), conn.dialect.name)
        if isinstance(error, GitHubRateLimitError):
            conn.execute(_SET_SYNC_ERROR, {"now": now, "error": error.message, "id": str(row.id)})
            return "rateLimited"
        # A cached installation token outlives the repository being removed from the installation (or
        # deleted/transferred): GitHub then answers 404 for the pull request rather than failing the token
        # request, so a 404 here is lost access too.
        status = error.status if isinstance(error, GitHubApiError) else None
        lost_access = isinstance(error, GitHubAccessError) or status == 404
        if status == 404 and not isinstance(error, GitHubAccessError):
            message = (
                "GitHub cannot find this repository or pull request (is the Canvas GitHub App still installed on it?)."
            )
        elif isinstance(error, GitHubApiError):
            message = error.message
        else:
            message = str(error)
        conn.execute(_SET_SYNC_ERROR, {"now": now, "error": message, "id": str(row.id)})
        # Lost access is the admin's to fix: flag the link on the GitHub admin page.
        if lost_access and row.github_link_id:
            conn.execute(
                text("UPDATE github_links SET last_checked_at = :now, last_check_error = :error WHERE id = :id"),
                {"now": now, "error": f"Needs attention: {message}", "id": str(row.github_link_id)},
            )
    return "error"


def refresh_diagram_submission(client: GitHubClient, db: Engine, diagram_id: str) -> bool:
    """The editor's refresh: syncs the diagram's open submission unless it was synced moments ago."""
    with db.connect() as conn:
        row = conn.execute(_OPEN_FOR_DIAGRAM, {"diagram": diagram_id}).first()
    if row is None or row.pr_number is None:
        return False
    if row.last_synced_at is not None and now_utc() - parse_instant(row.last_synced_at) < REFRESH_THROTTLE:
        return False
    sync_submission(client, db, str(row.id))
    return True


def sync_open_submissions(
    client: GitHubClient, db: Engine, min_age: timedelta = timedelta(minutes=1)
) -> dict[str, int]:
    """The scheduled job: every open submission not synced within `min_age`, oldest first. The cutoff is
    inclusive, so zero means every open submission, even one synced this millisecond."""
    with db.connect() as conn:
        cutoff = to_db(now_utc() - min_age, conn.dialect.name)
        ids = [
            str(r.id)
            for r in conn.execute(
                text(
                    "SELECT id FROM diagram_submissions WHERE state = 'open' AND pr_number IS NOT NULL"
                    " AND (last_synced_at IS NULL OR last_synced_at <= :cutoff) ORDER BY last_synced_at"
                ),
                {"cutoff": cutoff},
            )
        ]
    counts = {"open": 0, "merged": 0, "closed": 0, "error": 0, "skipped": 0, "rateLimited": 0}
    for index, submission_id in enumerate(ids):
        outcome = sync_submission(client, db, submission_id)
        counts[outcome] += 1
        # canvas-3s5.4: stop the batch rather than keep calling a GitHub that asked us to wait; the rest are
        # picked up on the next run (oldest-synced first).
        if outcome == "rateLimited":
            counts["skipped"] += len(ids) - index - 1
            break
    return counts


def withdraw_submission(client: GitHubClient, db: Engine, diagram_id: str, user_id: str, user_name: str) -> None:
    """Closes the diagram's open pull request from Canvas, with a comment saying who withdrew it."""
    with db.connect() as conn:
        row = conn.execute(_OPEN_FOR_DIAGRAM, {"diagram": diagram_id}).first()
    if row is None or row.pr_number is None:
        raise SubmissionNotOpenError("This diagram has no open pull request to withdraw.")
    repo = RepoRef(row.repo_owner, row.repo_name)
    token = client.installation_token(int(row.installation_id), [int(row.repo_id)], SUBMIT_PERMISSIONS)
    current = client.get_pull_request(token, repo, row.pr_number)
    if current.state != "open":
        # Merged or closed on GitHub in the meantime: record that instead.
        with db.begin() as conn:
            record_pull_state(conn, str(row.id), current, row.last_pushed_commit_sha)
        raise SubmissionNotOpenError(
            f"Pull request #{row.pr_number} was already {'merged' if current.merged else 'closed'} on GitHub."
        )
    name = re.sub(r"[\r\n]+", " ", user_name).replace("@", "@\u200b")
    client.add_pull_request_comment(token, repo, row.pr_number, f"Withdrawn in Canvas by {js_slice(name, 0, 100)}.")
    closed = client.update_pull_request(token, repo, row.pr_number, {"state": "closed"})
    with db.begin() as conn:
        record_pull_state(conn, str(row.id), closed, row.last_pushed_commit_sha, withdrawn_by=user_id)
