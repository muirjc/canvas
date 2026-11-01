"""Project links to GitHub repositories (apps/api/src/github/github-link.service.ts).

An admin links a project to a repository + folder; diagrams in that project can then be submitted there as
pull requests. Explicit per project (no inheritance). Only repositories the Canvas GitHub App is installed
on can be linked.
"""

from __future__ import annotations

from typing import Any, TypedDict
from uuid import uuid4

from sqlalchemy import Connection, Engine, text

from canvas_api.github.client import GitHubAccessError, GitHubApiError, GitHubClient, RepoRef, Repository
from canvas_api.github.paths import normalize_folder
from canvas_api.timestamps import now_utc, to_api, to_db


class GitHubDisabledError(Exception):
    def __init__(self) -> None:
        super().__init__("GitHub is not set up for this Canvas (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY).")


class GitHubLinkInvalidError(Exception):
    pass


class GitHubLinkConflictError(Exception):
    pass


class GitHubLinkNotFoundError(Exception):
    pass


class InstalledRepository(Repository):
    installationId: int


_LINK_FOR_PROJECT = text(
    "SELECT l.id, l.project_id, p.name AS project_name, l.repo_id, l.repo_owner, l.repo_name, "
    "l.installation_id, l.base_branch, l.folder, l.created_at, l.updated_at, l.last_checked_at, "
    "l.last_check_error FROM github_links l LEFT JOIN projects p ON p.id = l.project_id WHERE "
    "l.project_id = :project"
)
_LINKS = text(
    "SELECT l.id, l.project_id, p.name AS project_name, l.repo_id, l.repo_owner, l.repo_name, "
    "l.installation_id, l.base_branch, l.folder, l.created_at, l.updated_at, l.last_checked_at, "
    "l.last_check_error FROM github_links l LEFT JOIN projects p ON p.id = l.project_id WHERE "
    "p.deleted_at IS NULL ORDER BY p.name"
)
_OPEN_COUNTS = text(
    "SELECT github_link_id, COUNT(*) AS n FROM diagram_submissions"
    " WHERE state = 'open' AND pr_number IS NOT NULL GROUP BY github_link_id"
)


def _to_link(row: Any) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "projectId": str(row.project_id),
        "projectName": row.project_name,
        "repoId": int(row.repo_id),
        "repoOwner": row.repo_owner,
        "repoName": row.repo_name,
        "repoFullName": f"{row.repo_owner}/{row.repo_name}",
        "installationId": int(row.installation_id),
        "baseBranch": row.base_branch,
        "folder": row.folder,
        "createdAt": to_api(row.created_at),
        "updatedAt": to_api(row.updated_at),
        "lastCheckedAt": to_api(row.last_checked_at),
        "lastCheckError": row.last_check_error,
    }


def get_link_for_project(conn: Connection, project_id: str) -> dict[str, Any] | None:
    row = conn.execute(_LINK_FOR_PROJECT, {"project": project_id}).first()
    return _to_link(row) if row else None


def list_links(conn: Connection) -> list[dict[str, Any]]:
    """Every link, with how many of its pull requests are still open (canvas-3s5.2: removing a link leaves
    them open; Canvas keeps syncing them from the details copied onto each submission)."""
    counts = {str(r.github_link_id): int(r.n) for r in conn.execute(_OPEN_COUNTS)}
    return [{**_to_link(row), "openSubmissionCount": counts.get(str(row.id), 0)} for row in conn.execute(_LINKS)]


def list_installed_repositories(client: GitHubClient) -> list[InstalledRepository]:
    """Every repository the App can reach, across its installations."""
    repos: list[InstalledRepository] = []
    for installation in client.list_installations():
        for repo in client.list_installation_repositories(installation["id"]):
            repos.append(InstalledRepository(**repo, installationId=installation["id"]))
    # localeCompare order, near enough: case-insensitive first.
    return sorted(repos, key=lambda r: (r["fullName"].casefold(), r["fullName"]))


def set_link(
    client: GitHubClient,
    db: Engine,
    *,
    project_id: str,
    repo_id: int,
    folder: str,
    base_branch: str | None,
    user_id: str,
) -> dict[str, Any]:
    folder = normalize_folder(folder)
    repo = next((r for r in list_installed_repositories(client) if r["id"] == repo_id), None)
    if repo is None:
        raise GitHubLinkInvalidError("The Canvas GitHub App is not installed on that repository.")
    branch = (base_branch or "").strip() or repo["defaultBranch"]
    token = client.installation_token(repo["installationId"], [repo["id"]])
    if not client.get_branch_sha(token, RepoRef(repo["owner"], repo["name"]), branch):
        raise GitHubLinkInvalidError(f'The repository has no branch "{branch}".')

    with db.begin() as conn:
        # Two projects writing into the same folder, or one inside the other, could overwrite each other's diagrams.
        others = conn.execute(
            text("SELECT folder FROM github_links WHERE repo_id = :repo AND project_id <> :project"),
            {"repo": repo["id"], "project": project_id},
        ).all()
        clash = next(
            (
                o.folder
                for o in others
                if o.folder == folder or o.folder.startswith(f"{folder}/") or folder.startswith(f"{o.folder}/")
            ),
            None,
        )
        if clash is not None:
            raise GitHubLinkConflictError(
                f'Another project already uses "{clash}" in {repo["fullName"]}; choose a separate folder.'
            )
        now = to_db(now_utc(), conn.dialect.name)
        values = {
            "repo_id": repo["id"],
            "owner": repo["owner"],
            "name": repo["name"],
            "installation": repo["installationId"],
            "branch": branch,
            "folder": folder,
            "now": now,
        }
        existing = conn.execute(
            text("SELECT id FROM github_links WHERE project_id = :project"), {"project": project_id}
        ).first()
        if existing:
            conn.execute(
                text(
                    "UPDATE github_links SET repo_id = :repo_id, repo_owner = :owner, repo_name = :name,"
                    " installation_id = :installation, base_branch = :branch, folder = :folder,"
                    " last_checked_at = :now, last_check_error = NULL, updated_at = :now WHERE id = :id"
                ),
                {**values, "id": existing.id},
            )
        else:
            conn.execute(
                text(
                    # created_at/updated_at: the column defaults, as the TypeScript service leaves them.
                    "INSERT INTO github_links (id, project_id, created_by_user_id, repo_id, repo_owner, repo_name,"
                    " installation_id, base_branch, folder, last_checked_at, last_check_error)"
                    " VALUES (:id, :project, :user, :repo_id, :owner, :name, :installation, :branch, :folder, :now,"
                    " NULL)"
                ),
                {**values, "id": str(uuid4()), "project": project_id, "user": user_id},
            )
        link = get_link_for_project(conn, project_id)
    if link is None:  # just written in the same transaction
        raise GitHubLinkNotFoundError("This project is not linked to GitHub.")
    return link


def remove_link(conn: Connection, project_id: str) -> dict[str, Any]:
    link = get_link_for_project(conn, project_id)
    if link is None:
        raise GitHubLinkNotFoundError("This project is not linked to GitHub.")
    conn.execute(text("DELETE FROM github_links WHERE id = :id"), {"id": link["id"]})
    return link


class LinkCheck(TypedDict, total=False):
    id: str
    label: str
    ok: bool
    detail: str


def _message(error: BaseException) -> str:
    return error.message if isinstance(error, GitHubApiError) else str(error)


def test_link(client: GitHubClient, db: Engine, project_id: str) -> dict[str, Any]:
    """Checks the link still works: App installed, repository reachable, branch present, permissions granted."""
    with db.connect() as conn:
        link = get_link_for_project(conn, project_id)
    if link is None:
        raise GitHubLinkNotFoundError("This project is not linked to GitHub.")
    # An admin testing has often just changed the App's permissions or repositories.
    client.forget_tokens()
    checks: list[LinkCheck] = []

    def fail(check_id: str, label: str, error: BaseException) -> None:
        checks.append({"id": check_id, "label": label, "ok": False, "detail": _message(error)})

    renamed: tuple[str, str] | None = None
    try:
        installation = client.get_installation(link["installationId"])
        checks.append({"id": "installation", "label": f"App installed on {installation['account']}", "ok": True})
        for check_id, label in (
            ("contents", "Permission: Contents (read and write)"),
            ("pull_requests", "Permission: Pull requests (read and write)"),
        ):
            granted = installation["permissions"].get(check_id) == "write"
            check: LinkCheck = {"id": check_id, "label": label, "ok": granted}
            if not granted:
                check["detail"] = f"Granted: {installation['permissions'].get(check_id) or 'none'}"
            checks.append(check)
        try:
            token = client.installation_token(link["installationId"], [link["repoId"]])
            repo = client.get_repository(token, link["repoId"])
            checks.append({"id": "repository", "label": f"Repository {repo['fullName']} reachable", "ok": True})
            if repo["owner"] != link["repoOwner"] or repo["name"] != link["repoName"]:
                renamed = (repo["owner"], repo["name"])
            branch = client.get_branch_sha(token, RepoRef(repo["owner"], repo["name"]), link["baseBranch"])
            checks.append({"id": "branch", "label": f"Branch {link['baseBranch']} exists", "ok": bool(branch)})
        except Exception as error:
            fail("repository", "Repository reachable", error)
    except Exception as error:
        if isinstance(error, GitHubApiError) and error.status == 404:
            error = GitHubAccessError(404, "The App is no longer installed.", error.path)
        fail("installation", "App installed", error)

    ok = all(c["ok"] for c in checks)
    problem = next((c for c in checks if not c["ok"]), None)
    last_error = None
    if problem:
        last_error = problem["label"] + (f": {problem['detail']}" if problem.get("detail") else "")
    with db.begin() as conn:
        if renamed:
            conn.execute(
                text("UPDATE github_links SET repo_owner = :owner, repo_name = :name WHERE id = :id"),
                {"owner": renamed[0], "name": renamed[1], "id": link["id"]},
            )
        conn.execute(
            text("UPDATE github_links SET last_checked_at = :now, last_check_error = :error WHERE id = :id"),
            {"now": to_db(now_utc(), conn.dialect.name), "error": last_error, "id": link["id"]},
        )
    return {"ok": ok, "checks": checks}
