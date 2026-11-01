"""Submitting a diagram to its project's linked GitHub repository as a pull request
(apps/api/src/github/submission.service.ts).

One open pull request per diagram; submitting again while it is open pushes a new commit to it (never a
force-push). Merged = approved, closed unmerged = rejected.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import timedelta
from typing import Any
from uuid import uuid4

from sqlalchemy import Connection, Engine, bindparam, text
from sqlalchemy.exc import IntegrityError

from canvas_api.audit import record_audit
from canvas_api.catalog import DSL_FAMILIES
from canvas_api.diagram_core import DiagramBridge
from canvas_api.github.client import (
    SUBMIT_PERMISSIONS,
    GitHubApiError,
    GitHubClient,
    OpenPullRequest,
    PullRequest,
    RepoRef,
)
from canvas_api.github.embeds import DiagramFiles, document_embed_updates
from canvas_api.github.files import (
    SubmissionInput,
    SubmissionStandard,
    build_commit_message,
    build_pr_body,
    build_pr_title,
    build_submission_files,
    encode_uri_component,
    submission_fingerprint,
)
from canvas_api.github.links import get_link_for_project
from canvas_api.github.paths import slugify
from canvas_api.github.validator_bundle import validator_bundle
from canvas_api.standards import get_active_standard
from canvas_api.timestamps import now_utc, parse_instant, to_api, to_db


class SubmissionNotLinkedError(Exception):
    pass


class SubmissionBlockedError(Exception):
    def __init__(self, violations: list[dict[str, Any]]) -> None:
        count = len(violations)
        super().__init__(f"Fix the {count} Must fix issue{'' if count == 1 else 's'} before submitting.")
        self.violations = violations


class SubmissionInProgressError(Exception):
    def __init__(self) -> None:
        super().__init__("This diagram is already being submitted; try again in a moment.")


class SubmissionLinkChangedError(Exception):
    """The open pull request is in a different repository or folder than the project's link now."""


class SubmissionConflictError(Exception):
    """The open pull request's branch moved in a way Canvas can't build on (e.g. force-pushed)."""


#: A lock older than this is from a request that died; it no longer blocks.
LOCK_TIMEOUT = timedelta(minutes=2)


@dataclass(frozen=True)
class Submitter:
    id: str
    name: str
    email: str


_BY_ID = text(
    "SELECT s.*, u.name AS submitted_by_name, w.name AS withdrawn_by_name FROM diagram_submissions s "
    "LEFT JOIN users u ON u.id = s.submitted_by_user_id LEFT JOIN users w ON w.id = "
    "s.withdrawn_by_user_id WHERE s.id = :id"
)
_APPROVED = text(
    "SELECT s.*, u.name AS submitted_by_name, w.name AS withdrawn_by_name FROM diagram_submissions s "
    "LEFT JOIN users u ON u.id = s.submitted_by_user_id LEFT JOIN users w ON w.id = "
    "s.withdrawn_by_user_id WHERE s.diagram_id = :diagram AND s.state = 'merged' ORDER BY s.merged_at "
    "DESC"
)
_LATEST = text(
    "SELECT s.*, u.name AS submitted_by_name, w.name AS withdrawn_by_name FROM diagram_submissions s "
    "LEFT JOIN users u ON u.id = s.submitted_by_user_id LEFT JOIN users w ON w.id = "
    "s.withdrawn_by_user_id WHERE s.diagram_id = :diagram AND s.pr_number IS NOT NULL ORDER BY "
    "s.last_submitted_at DESC"
)
_HISTORY = text(
    "SELECT s.*, u.name AS submitted_by_name, w.name AS withdrawn_by_name FROM diagram_submissions s "
    "LEFT JOIN users u ON u.id = s.submitted_by_user_id LEFT JOIN users w ON w.id = "
    "s.withdrawn_by_user_id WHERE s.diagram_id = :diagram AND s.pr_number IS NOT NULL ORDER BY "
    "s.first_submitted_at DESC"
)
_PUSHES = text(
    "SELECT p.submission_id, p.version_sequence, p.commit_sha, p.pushed_at, p.warning_count, u.name AS pushed_by"
    " FROM diagram_submission_pushes p LEFT JOIN users u ON u.id = p.pushed_by_user_id"
    " WHERE p.submission_id IN :ids ORDER BY p.pushed_at DESC"
).bindparams(bindparam("ids", expanding=True))
_BADGES = text(
    "SELECT s.diagram_id, s.state, s.pr_number, s.pr_url, s.review_state, s.checks_state,"
    " s.submitted_version_sequence, s.submitted_fingerprint, s.withdrawn_at, s.last_submitted_at, d.name,"
    " d.description, v.dsl_content FROM diagram_submissions s JOIN diagrams d ON d.id = s.diagram_id"
    " JOIN diagram_versions v ON v.id = d.current_version_id"
    " WHERE d.project_id = :project AND d.deleted_at IS NULL AND s.pr_number IS NOT NULL"
    " ORDER BY s.last_submitted_at ASC"
)
_OPEN_ROW = text("SELECT * FROM diagram_submissions WHERE diagram_id = :diagram AND state = 'open'")
_ROW = text("SELECT * FROM diagram_submissions WHERE id = :id")
_CLOSE = text(
    "UPDATE diagram_submissions SET state = :state, head_sha = :head, merged_at = :merged_at, "
    "merged_by_login = :merged_by, merge_commit_sha = :merge_sha, merged_head_matches = :matches, "
    "closed_at = :closed_at, submitting_since = NULL, last_synced_at = :now, last_sync_error = NULL "
    "WHERE id = :id AND state = 'open'"
)
_CLOSE_WITHDRAWN = text(
    "UPDATE diagram_submissions SET state = :state, head_sha = :head, merged_at = :merged_at, "
    "merged_by_login = :merged_by, merge_commit_sha = :merge_sha, merged_head_matches = :matches, "
    "closed_at = :closed_at, submitting_since = NULL, last_synced_at = :now, last_sync_error = NULL, "
    "withdrawn_at = :now, withdrawn_by_user_id = :withdrawn_by WHERE id = :id AND state = 'open'"
)
_PUSHED_UPDATE = text(
    "UPDATE diagram_submissions SET branch = :branch, pr_number = :n, pr_url = :url, "
    "submitted_version_sequence = :version, submitted_fingerprint = :fingerprint, last_pushed_commit_sha "
    "= :commit, head_sha = :commit, submitted_by_user_id = :user, last_submitted_at = :now, "
    "submitting_since = NULL WHERE id = :id"
)
_PUSHED_NEW = text(
    "UPDATE diagram_submissions SET branch = :branch, pr_number = :n, pr_url = :url, "
    "submitted_version_sequence = :version, submitted_fingerprint = :fingerprint, last_pushed_commit_sha "
    "= :commit, head_sha = :commit, submitted_by_user_id = :user, last_submitted_at = :now, "
    "submitting_since = NULL, first_submitted_at = :now WHERE id = :id"
)


def _status_detail(value: str | None) -> Any:
    if not value:
        return None
    try:
        return json.loads(value)
    except ValueError:
        return None


def to_view(row: Any) -> dict[str, Any]:
    """A submission as the API returns it (SubmissionView)."""
    return {
        "id": str(row.id),
        "state": row.state,
        "prNumber": row.pr_number,
        "prUrl": row.pr_url,
        "repoFullName": f"{row.repo_owner}/{row.repo_name}",
        "baseBranch": row.base_branch,
        "branch": row.branch,
        "path": row.path,
        "submittedVersionSequence": row.submitted_version_sequence,
        "submittedBy": row.submitted_by_name,
        "firstSubmittedAt": to_api(row.first_submitted_at),
        "lastSubmittedAt": to_api(row.last_submitted_at),
        "reviewState": row.review_state,
        "checksState": row.checks_state,
        "mergedAt": to_api(row.merged_at),
        "mergedBy": row.merged_by_login,
        "closedAt": to_api(row.closed_at),
        "mergedHeadMatches": None if row.merged_head_matches is None else bool(row.merged_head_matches),
        "withdrawnAt": to_api(row.withdrawn_at),
        "withdrawnBy": row.withdrawn_by_name,
        "statusDetail": _status_detail(row.status_detail),
        "lastSyncedAt": to_api(row.last_synced_at),
        "lastSyncError": row.last_sync_error,
    }


def get_submission_view(conn: Connection, submission_id: str) -> dict[str, Any]:
    return to_view(conn.execute(_BY_ID, {"id": submission_id}).one())


def get_approved_submission(conn: Connection, diagram_id: str) -> dict[str, Any] | None:
    """The most recent approved (merged) submission, if any."""
    row = conn.execute(_APPROVED, {"diagram": diagram_id}).first()
    return to_view(row) if row else None


def get_latest_submission(conn: Connection, diagram_id: str) -> tuple[dict[str, Any], str | None] | None:
    """The diagram's latest submission (open, else most recent), and the fingerprint it was submitted with."""
    row = conn.execute(_LATEST, {"diagram": diagram_id}).first()
    return (to_view(row), row.submitted_fingerprint) if row else None


def list_submission_history(conn: Connection, diagram_id: str) -> list[dict[str, Any]]:
    """Every pull request opened for the diagram, newest first, each with its pushes (newest first)."""
    rows = conn.execute(_HISTORY, {"diagram": diagram_id}).all()
    if not rows:
        return []
    pushes = conn.execute(_PUSHES, {"ids": [str(r.id) for r in rows]}).all()
    return [
        {
            **to_view(row),
            "pushes": [
                {
                    "versionSequence": p.version_sequence,
                    "commitSha": p.commit_sha,
                    "pushedBy": p.pushed_by,
                    "pushedAt": to_api(p.pushed_at),
                    "warningCount": p.warning_count,
                }
                for p in pushes
                if str(p.submission_id) == str(row.id)
            ],
        }
        for row in rows
    ]


def project_submission_badges(conn: Connection, project_id: str) -> dict[str, dict[str, Any]]:
    """Each submitted diagram's latest submission in a project, for the project page's badges."""
    badges: dict[str, dict[str, Any]] = {}
    # Ascending, so the latest submission per diagram wins -- except an open one always does.
    for r in conn.execute(_BADGES, {"project": project_id}):
        diagram_id = str(r.diagram_id)
        if badges.get(diagram_id, {}).get("state") == "open":
            continue
        badges[diagram_id] = {
            "state": r.state,
            "prNumber": r.pr_number,
            "prUrl": r.pr_url,
            "reviewState": r.review_state,
            "checksState": r.checks_state,
            "submittedVersionSequence": r.submitted_version_sequence,
            "changesSinceSubmitting": r.submitted_fingerprint
            != submission_fingerprint(r.dsl_content, r.name, r.description),
            "withdrawn": r.withdrawn_at is not None,
        }
    return badges


def check_submittable(
    conn: Connection, bridge: DiagramBridge, diagram_type_id: str, dsl_family: str, dsl_content: str
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Validates the saved diagram against the current standard: (Must fix issues, the rest)."""
    parsed = bridge.parse(dsl_family, dsl_content) if dsl_family in DSL_FAMILIES else {}
    if "model" not in parsed:
        blocking = {
            "elementId": "diagram",
            "rule": "parse",
            "message": "The diagram has syntax errors.",
            "severity": "error",
            "elementType": "diagram",
        }
        return [blocking], []
    standard = get_active_standard(conn, diagram_type_id)
    violations = bridge.validate(parsed["model"], standard.rules) if standard else []
    return [v for v in violations if v.get("severity") == "error"], [
        v for v in violations if v.get("severity") != "error"
    ]


def _choose_path(conn: Connection, diagram_id: str, diagram_name: str, link: dict[str, Any]) -> tuple[str, str]:
    """The folder a diagram's files go in: the one it was first submitted to under this link's repository +
    folder, else a new one named after it (made unique if another diagram has it)."""
    folder = link["folder"]
    previous = conn.execute(
        text(
            "SELECT path FROM diagram_submissions WHERE diagram_id = :diagram AND repo_id = :repo AND path LIKE :prefix"
            " ORDER BY first_submitted_at DESC"
        ),
        {"diagram": diagram_id, "repo": link["repoId"], "prefix": f"{folder}/%"},
    ).first()
    if previous and "/" not in previous.path[len(folder) + 1 :]:
        return previous.path, previous.path[len(folder) + 1 :]
    slug = slugify(diagram_name)
    taken = conn.execute(
        text(
            "SELECT diagram_id FROM diagram_submissions"
            " WHERE repo_id = :repo AND path = :path AND diagram_id <> :diagram"
        ),
        {"repo": link["repoId"], "path": f"{folder}/{slug}", "diagram": diagram_id},
    ).first()
    if taken:
        slug = f"{slug[:51]}-{diagram_id.replace('-', '')[:8]}"
    return f"{folder}/{slug}", slug


def _lock_submission(db: Engine, diagram_id: str, create: dict[str, Any]) -> tuple[str, bool]:
    """Takes the per-diagram lock: the open submission row itself. A new submission inserts a provisional
    open row (the partial unique index allows one per diagram); an existing one is claimed by setting
    `submitting_since`, unless another request holds it. Returns (id, provisional)."""
    now = now_utc()
    with db.begin() as conn:
        dialect = conn.dialect.name
        open_row = conn.execute(
            text("SELECT id FROM diagram_submissions WHERE diagram_id = :diagram AND state = 'open'"),
            {"diagram": diagram_id},
        ).first()
        if open_row:
            claimed = conn.execute(
                text(
                    "UPDATE diagram_submissions SET submitting_since = :now WHERE id = :id"
                    " AND (submitting_since IS NULL OR submitting_since < :stale)"
                ),
                {"now": to_db(now, dialect), "id": open_row.id, "stale": to_db(now - LOCK_TIMEOUT, dialect)},
            )
            if claimed.rowcount == 0:
                raise SubmissionInProgressError()
            return str(open_row.id), False
    submission_id = str(uuid4())
    try:
        with db.begin() as conn:
            at = to_db(now, conn.dialect.name)
            conn.execute(
                text(
                    "INSERT INTO diagram_submissions (id, diagram_id, state, first_submitted_at, last_submitted_at,"
                    " submitting_since, github_link_id, repo_id, repo_owner, repo_name, installation_id, base_branch,"
                    " path, branch, submitted_by_user_id)"
                    " VALUES (:id, :diagram, 'open', :now, :now, :now, :link, :repo_id,"
                    " :owner, :name, :installation, :base, :path, :branch, :user)"
                ),
                {"id": submission_id, "diagram": diagram_id, "now": at, **create},
            )
    except IntegrityError as error:
        raise SubmissionInProgressError() from error
    return submission_id, True


def _release_lock(db: Engine, submission_id: str, provisional: bool) -> None:
    with db.begin() as conn:
        if provisional:
            conn.execute(
                text("DELETE FROM diagram_submissions WHERE id = :id AND pr_number IS NULL"), {"id": submission_id}
            )
        conn.execute(
            text("UPDATE diagram_submissions SET submitting_since = NULL WHERE id = :id"), {"id": submission_id}
        )


def record_pull_state(
    conn: Connection,
    submission_id: str,
    pull: PullRequest,
    submitted_sha: str | None,
    withdrawn_by: str | None = None,
) -> str:
    """Records what GitHub says about a pull request Canvas thought was open. Merged = approved (and whether
    GitHub merged exactly what Canvas last pushed); closed unmerged = rejected. Both are audited; returns the
    new state."""
    dialect = conn.dialect.name
    now = now_utc()
    if pull.state == "open":
        conn.execute(
            text(
                "UPDATE diagram_submissions SET head_sha = :head, last_synced_at = :now, last_sync_error = NULL"
                " WHERE id = :id"
            ),
            {"head": pull.head_sha, "now": to_db(now, dialect), "id": submission_id},
        )
        return "open"
    state = "merged" if pull.merged else "closed"
    head_matches = pull.head_sha == submitted_sha
    params = {
        "state": state,
        "head": pull.head_sha,
        "merged_at": to_db(parse_instant(pull.merged_at), dialect) if pull.merged_at else None,
        "merged_by": pull.merged_by,
        "merge_sha": pull.merge_commit_sha if pull.merged else None,
        "matches": head_matches if pull.merged else None,
        "closed_at": to_db(parse_instant(pull.closed_at) if pull.closed_at else now, dialect),
        "now": to_db(now, dialect),
        "id": submission_id,
    }
    if withdrawn_by:
        params["withdrawn_by"] = withdrawn_by
    changed = conn.execute(_CLOSE_WITHDRAWN if withdrawn_by else _CLOSE, params)
    if changed.rowcount > 0:
        row = conn.execute(
            text(
                "SELECT diagram_id, repo_owner, repo_name, submitted_version_sequence FROM diagram_submissions"
                " WHERE id = :id"
            ),
            {"id": submission_id},
        ).one()
        detail: dict[str, Any] = {
            "diagramId": str(row.diagram_id),
            "repo": f"{row.repo_owner}/{row.repo_name}",
            "pullRequest": pull.number,
            "versionSequence": row.submitted_version_sequence,
        }
        if pull.merged:
            detail |= {"mergedBy": pull.merged_by, "headMatches": head_matches}
        event = (
            "diagram_submission_withdrawn"
            if withdrawn_by
            else "diagram_submission_merged"
            if pull.merged
            else "diagram_submission_closed"
        )
        record_audit(conn, event, actor_user_id=withdrawn_by, detail=detail)
    return state


def _find_unrecorded_pull(
    client: GitHubClient, db: Engine, token: str, submission: Any, diagram_id: str
) -> OpenPullRequest | None:
    """An open pull request this Canvas opened for the diagram that no submission row records: opened by a bot
    (the App), from a canvas/<id8>- branch in the same repository, carrying the diagram's marker in its
    description, and not a pull request Canvas already knows about."""
    repo = RepoRef(submission.repo_owner, submission.repo_name)
    prefix = f"canvas/{diagram_id.replace('-', '')[:8]}-"
    marker = f"<!-- canvas:diagram={diagram_id} -->"
    with db.connect() as conn:
        known = {
            r.pr_number
            for r in conn.execute(
                text("SELECT pr_number FROM diagram_submissions WHERE repo_id = :repo AND pr_number IS NOT NULL"),
                {"repo": int(submission.repo_id)},
            )
        }
    full_name = f"{repo.owner}/{repo.name}".lower()
    candidates = [
        p
        for p in client.list_open_pull_requests(token, repo, submission.base_branch)
        if p.author.endswith("[bot]")
        and p.head_ref.startswith(prefix)
        and (p.head_repo or "").lower() == full_name
        and p.head_repo is not None
        and marker in p.body
        and p.number not in known
    ]
    # Newest first from GitHub; if somehow there are several, adopt the newest.
    return candidates[0] if candidates else None


def submit_diagram(
    client: GitHubClient,
    bridge: DiagramBridge,
    db: Engine,
    diagram: dict[str, Any],
    submitter: Submitter,
    canvas_public_url: str,
    *,
    validator_dir: str | None,
    render_svg: Any,
) -> dict[str, Any]:
    """Submits the saved diagram. `render_svg(conn, family, dsl, type_id, background)` draws it (export)."""
    diagram_id = diagram["id"]
    with db.connect() as conn:
        link = get_link_for_project(conn, diagram["projectId"])
        if link is None:
            raise SubmissionNotLinkedError(
                "This diagram's project is not linked to a GitHub repository. Ask an admin to link it."
            )
        blocking, warnings = check_submittable(
            conn, bridge, diagram["diagramTypeId"], diagram["dslFamily"], diagram["dslContent"]
        )
    if blocking:
        raise SubmissionBlockedError(blocking)

    # A pull request Canvas thinks is open may have been merged or closed on GitHub since; find out before
    # deciding whether to push to it or open a new one.
    token = client.installation_token(link["installationId"], [link["repoId"]], SUBMIT_PERMISSIONS)
    with db.connect() as conn:
        existing = conn.execute(_OPEN_ROW, {"diagram": diagram_id}).first()
    # A lock older than LOCK_TIMEOUT is from a request that died, so the pull request is synced too.
    lock_is_live = (
        existing is not None
        and existing.submitting_since is not None
        and parse_instant(existing.submitting_since) > now_utc() - LOCK_TIMEOUT
    )
    if existing is not None and existing.pr_number is not None and not lock_is_live:
        if int(existing.repo_id) != link["repoId"] or not existing.path.startswith(f"{link['folder']}/"):
            raise SubmissionLinkChangedError(
                f"Pull request #{existing.pr_number} is open in {existing.repo_owner}/{existing.repo_name}, but this"
                " project is now linked elsewhere. Close or merge that pull request first."
            )
        pull = client.get_pull_request(token, RepoRef(existing.repo_owner, existing.repo_name), existing.pr_number)
        with db.begin() as conn:
            record_pull_state(conn, str(existing.id), pull, existing.last_pushed_commit_sha)

    repo = client.get_repository(token, link["repoId"])
    with db.begin() as conn:
        if repo["owner"] != link["repoOwner"] or repo["name"] != link["repoName"]:
            conn.execute(
                text("UPDATE github_links SET repo_owner = :owner, repo_name = :name WHERE id = :id"),
                {"owner": repo["owner"], "name": repo["name"], "id": link["id"]},
            )
        path, slug = _choose_path(conn, diagram_id, diagram["name"], link)
        previous_count = int(
            conn.execute(
                text("SELECT COUNT(*) FROM diagram_submissions WHERE diagram_id = :diagram"), {"diagram": diagram_id}
            ).scalar_one()
        )
    branch = f"canvas/{diagram_id.replace('-', '')[:8]}-{slug[:40].rstrip('-')}-r{previous_count + 1}"

    lock_id, provisional = _lock_submission(
        db,
        diagram_id,
        {
            "link": link["id"],
            "repo_id": link["repoId"],
            "owner": repo["owner"],
            "name": repo["name"],
            "installation": link["installationId"],
            "base": link["baseBranch"],
            "path": path,
            "branch": branch,
            "user": submitter.id,
        },
    )
    try:
        with db.connect() as conn:
            submission = conn.execute(_ROW, {"id": lock_id}).one()
        # canvas-3s5.5: a pull request Canvas opened but failed to record (the request died after GitHub created
        # it) is adopted rather than duplicated.
        if submission.pr_number is None:
            orphan = _find_unrecorded_pull(client, db, token, submission, diagram_id)
            if orphan:
                with db.begin() as conn:
                    conn.execute(
                        text(
                            "UPDATE diagram_submissions SET pr_number = :n, pr_url = :url, branch = :branch"
                            " WHERE id = :id"
                        ),
                        {"n": orphan.number, "url": orphan.url, "branch": orphan.head_ref, "id": lock_id},
                    )
                    submission = conn.execute(_ROW, {"id": lock_id}).one()

        with db.connect() as conn:
            version_sequence = int(
                conn.execute(
                    text(
                        "SELECT v.sequence_number FROM diagrams d"
                        " JOIN diagram_versions v ON v.id = d.current_version_id"
                        " WHERE d.id = :id"
                    ),
                    {"id": diagram_id},
                ).scalar_one()
            )
            standard = get_active_standard(conn, diagram["diagramTypeId"])
            type_name = conn.execute(
                text("SELECT name FROM diagram_types WHERE id = :id"), {"id": diagram["diagramTypeId"]}
            ).scalar()
            # canvas-n85n: white behind the drawing, so it stays readable in GitHub's dark mode.
            svg = render_svg(conn, diagram["dslFamily"], diagram["dslContent"], diagram["diagramTypeId"], "#ffffff")
        sub_path = str(submission.path)
        submission_input = SubmissionInput(
            diagram_id=diagram_id,
            name=diagram["name"],
            description=diagram["description"],
            diagram_type_id=diagram["diagramTypeId"],
            diagram_type_name=type_name or diagram["diagramTypeId"],
            dsl_family=diagram["dslFamily"],
            dsl_content=diagram["dslContent"],
            portable_mermaid=bridge.portable(diagram["dslContent"], strip_front_matter=True),
            svg=svg,
            version_sequence=version_sequence,
            standard=(
                SubmissionStandard(standard.id, standard.version, standard.name, standard.description, standard.rules)
                if standard
                else None
            ),
            path=sub_path,
            slug=sub_path[sub_path.rfind("/") + 1 :],
            canvas_url=f"{canvas_public_url}/?diagramId={encode_uri_component(diagram_id)}",
            validator=validator_bundle(validator_dir),
        )
        files = build_submission_files(submission_input)
        target = RepoRef(submission.repo_owner, submission.repo_name)
        is_update = submission.pr_number is not None

        parent_sha = client.get_branch_sha(token, target, submission.branch if is_update else submission.base_branch)
        if not parent_sha:
            if is_update:
                raise SubmissionConflictError(
                    f"The branch for pull request #{submission.pr_number} was deleted on GitHub. Close the pull"
                    " request so Canvas can open a new one."
                )
            raise SubmissionNotLinkedError(
                f'The linked branch "{submission.base_branch}" no longer exists in {target.owner}/{target.name}.'
            )
        parent_tree = client.get_commit_tree_sha(token, target, parent_sha)
        # canvas-finl: documents that embed this diagram are updated in the same commit.
        embeds = document_embed_updates(
            client,
            bridge,
            token,
            target,
            parent_tree,
            DiagramFiles(
                mmd_path=f"{submission_input.path}/{submission_input.slug}.mmd",
                mmd_text=submission_input.portable_mermaid,
                svg_path=f"{submission_input.path}/{submission_input.slug}.svg",
            ),
        )
        tree = client.create_tree(token, target, parent_tree, [*files, *embeds.files])
        fingerprint = submission_fingerprint(diagram["dslContent"], diagram["name"], diagram["description"])

        if tree == parent_tree:
            # Nothing to commit: the repository already has exactly these files.
            _release_lock(db, lock_id, provisional)
            view = None
            if is_update:
                with db.connect() as conn:
                    view = get_submission_view(conn, lock_id)
            return {"outcome": "upToDate", "submission": view, "warnings": warnings}

        commit = client.create_commit(
            token,
            target,
            build_commit_message(
                submission_input.name,
                version_sequence,
                submission_input.canvas_url,
                submitter.name,
                submitter.email,
                is_update,
            ),
            tree,
            parent_sha,
        )
        title = build_pr_title(submission_input.name, version_sequence)
        body = build_pr_body(submission_input, warnings, submitter.name, embeds.documents)
        branch_name = str(submission.branch)
        if is_update:
            try:
                client.fast_forward_branch(token, target, branch_name, commit)
            except GitHubApiError as error:
                if error.status == 422:
                    raise SubmissionConflictError(
                        f"Pull request #{submission.pr_number} changed on GitHub while submitting; try again."
                    ) from error
                raise
            pull = client.update_pull_request(token, target, submission.pr_number, {"title": title, "body": body})
        else:
            # A branch left over from an attempt that failed before its pull request was opened.
            if not client.create_branch(token, target, branch_name, commit):
                branch_name = f"{branch_name}-{str(uuid4())[:4]}"
                if not client.create_branch(token, target, branch_name, commit):
                    raise SubmissionConflictError("Could not create a branch for this submission; try again.")
            pull = client.create_pull_request(
                token, target, title=title, head=branch_name, base=submission.base_branch, body=body
            )

        with db.begin() as conn:
            now = to_db(now_utc(), conn.dialect.name)
            conn.execute(
                _PUSHED_UPDATE if is_update else _PUSHED_NEW,
                {
                    "branch": branch_name,
                    "n": pull.number,
                    "url": pull.url,
                    "version": version_sequence,
                    "fingerprint": fingerprint,
                    "commit": commit,
                    "user": submitter.id,
                    "now": now,
                    "id": lock_id,
                },
            )
            conn.execute(
                text(
                    "INSERT INTO diagram_submission_pushes (id, submission_id, version_sequence, commit_sha,"
                    " pushed_by_user_id, pushed_at, warning_count) VALUES (:id, :submission, :version, :commit, :user,"
                    " :now, :warnings)"
                ),
                {
                    "id": str(uuid4()),
                    "submission": lock_id,
                    "version": version_sequence,
                    "commit": commit,
                    "user": submitter.id,
                    "now": now,
                    "warnings": len(warnings),
                },
            )
            record_audit(
                conn,
                "diagram_submitted",
                actor_user_id=submitter.id,
                detail={
                    "diagramId": diagram_id,
                    "repo": f"{target.owner}/{target.name}",
                    "pullRequest": pull.number,
                    "versionSequence": version_sequence,
                    "update": is_update,
                },
            )
            view = get_submission_view(conn, lock_id)
        return {"outcome": "updated" if is_update else "created", "submission": view, "warnings": warnings}
    except BaseException:
        _release_lock(db, lock_id, provisional)
        raise
