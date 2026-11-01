"""GitHub approval (phase 7, canvas-1bty.11; apps/api/src/github/github.routes.ts).

Admins link projects to repositories; anyone with edit access to a diagram in a linked project can submit
it as a pull request. Merged = approved, closed = rejected; the editor refreshes the state on demand and the
canvas-github-sync job polls the rest.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field, StrictInt, StrictStr
from sqlalchemy import Connection, Engine

from canvas_api.access import (
    access_at_least,
    project_exists,
    require_diagram_access,
    require_project_access,
    resolve_diagram_access,
)
from canvas_api.audit import client_ip, record_audit
from canvas_api.auth.roles import AdminUser, CurrentUser
from canvas_api.config import Settings
from canvas_api.db import get_engine
from canvas_api.diagram_core import DiagramBridge
from canvas_api.errors import ApiError
from canvas_api.github.client import (
    GitHubAccessError,
    GitHubApiError,
    GitHubClient,
    GitHubRateLimitError,
    GitHubUnavailableError,
)
from canvas_api.github.files import submission_fingerprint
from canvas_api.github.links import (
    GitHubDisabledError,
    GitHubLinkConflictError,
    GitHubLinkInvalidError,
    GitHubLinkNotFoundError,
    get_link_for_project,
    list_installed_repositories,
    list_links,
    remove_link,
    set_link,
    test_link,
)
from canvas_api.github.paths import InvalidRepoPathError
from canvas_api.github.submissions import (
    SubmissionBlockedError,
    SubmissionConflictError,
    SubmissionInProgressError,
    SubmissionLinkChangedError,
    SubmissionNotLinkedError,
    Submitter,
    check_submittable,
    get_approved_submission,
    get_latest_submission,
    list_submission_history,
    project_submission_badges,
    submit_diagram,
)
from canvas_api.github.sync import SubmissionNotOpenError, refresh_diagram_submission, withdraw_submission
from canvas_api.github.validator_bundle import example_workflow, validator_bundle
from canvas_api.routes.diagrams import get_diagram
from canvas_api.routes.export import render_svg

router = APIRouter(tags=["GitHub"])
Db = Annotated[Engine, Depends(get_engine)]
log = logging.getLogger(__name__)


class LinkBody(BaseModel):
    repoId: StrictInt = Field(ge=1)
    folder: StrictStr = Field(min_length=1, max_length=300)
    baseBranch: StrictStr | None = Field(default=None, max_length=250)


def _client(request: Request) -> GitHubClient | None:
    client: GitHubClient | None = request.app.state.github_client
    return client


def _require_client(request: Request) -> GitHubClient:
    client = _client(request)
    if client is None:
        raise GitHubDisabledError()
    return client


def _bridge(request: Request) -> DiagramBridge:
    bridge: DiagramBridge | None = request.app.state.diagram_bridge
    if bridge is None:
        raise ApiError(503, "The diagram-core bridge is not configured (DIAGRAM_BRIDGE_URL).")
    return bridge


def _settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


@contextmanager
def _github_errors() -> Iterator[None]:
    """The TypeScript routes' handleError: each failure as its status and code."""
    try:
        yield
    except GitHubDisabledError as error:
        raise ApiError(409, str(error), "github_disabled") from error
    except GitHubLinkNotFoundError as error:
        raise ApiError(404, str(error)) from error
    except (GitHubLinkInvalidError, InvalidRepoPathError) as error:
        raise ApiError(400, str(error)) from error
    except GitHubLinkConflictError as error:
        raise ApiError(409, str(error)) from error
    except SubmissionNotLinkedError as error:
        raise ApiError(409, str(error), "not_linked") from error
    except SubmissionBlockedError as error:
        raise ApiError(422, str(error), "must_fix", violations=error.violations) from error
    except SubmissionInProgressError as error:
        raise ApiError(409, str(error), "in_progress") from error
    except SubmissionLinkChangedError as error:
        raise ApiError(409, str(error), "link_changed") from error
    except SubmissionNotOpenError as error:
        raise ApiError(409, str(error), "not_open") from error
    except SubmissionConflictError as error:
        raise ApiError(409, str(error), "conflict") from error
    except GitHubRateLimitError as error:
        raise ApiError(503, error.message, "github_rate_limited") from error
    except GitHubAccessError as error:
        raise ApiError(502, error.message, "github_access") from error
    except GitHubUnavailableError as error:
        raise ApiError(502, str(error), "github_unavailable") from error
    except GitHubApiError as error:
        log.warning(
            "GitHub API error", extra={"status": error.status, "path": error.path, "github_message": error.message}
        )
        raise ApiError(502, f"GitHub refused the request: {error.message}", "github_error") from error


def _link_summary(link: dict[str, Any] | None) -> dict[str, str] | None:
    if link is None:
        return None
    return {"repoFullName": link["repoFullName"], "folder": link["folder"], "baseBranch": link["baseBranch"]}


# --- admin --------------------------------------------------------------------------------------------


@router.get("/admin/github/status")
def github_status(request: Request, _admin: AdminUser) -> dict[str, Any]:
    client = _client(request)
    if client is None:
        return {"enabled": False, "installations": []}
    available = validator_bundle(_settings(request).canvas_validator_dir) is not None
    base = {"enabled": True, "appId": client.app_id, "apiUrl": client.api_url}
    try:
        installations = client.list_installations()
    except Exception as error:
        message = error.message if isinstance(error, GitHubApiError) else str(error)
        log.warning("GitHub status check failed", extra={"github_message": message})
        return {**base, "installations": [], "error": message, "validatorAvailable": available}
    return {**base, "installations": installations, "validatorAvailable": available}


@router.get("/admin/github/repositories")
def github_repositories(request: Request, _admin: AdminUser) -> dict[str, Any]:
    with _github_errors():
        return {"repositories": list_installed_repositories(_require_client(request))}


@router.get("/admin/github/workflow-example")
def github_workflow_example(request: Request, _admin: AdminUser) -> Response:
    """canvas-3s5.3: the example workflow that runs the committed validator in the repository's CI."""
    workflow = example_workflow(_settings(request).canvas_validator_dir)
    if workflow is None:
        raise ApiError(404, "The example workflow is not available (packages/validator-cli has not been built).")
    return Response(
        content=workflow,
        headers={
            "Content-Type": "text/yaml; charset=utf-8",
            "Content-Disposition": 'attachment; filename="canvas-diagrams.yml"',
        },
    )


@router.get("/admin/github/links")
def github_links(_admin: AdminUser, db: Db) -> dict[str, Any]:
    with db.connect() as conn:
        return {"links": list_links(conn)}


@router.post("/admin/github/links/{id}/test")
def github_link_test(id: str, request: Request, _admin: AdminUser, db: Db) -> dict[str, Any]:
    """Checks the link of the project with this id."""
    with _github_errors():
        return test_link(_require_client(request), db, id)


@router.put("/projects/{id}/github-link")
def put_github_link(id: str, body: LinkBody, request: Request, admin: AdminUser, db: Db) -> dict[str, Any]:
    with db.connect() as conn:
        if not project_exists(conn, id):
            raise ApiError(404, "Project not found")
    with _github_errors():
        link = set_link(
            _require_client(request),
            db,
            project_id=id,
            repo_id=body.repoId,
            folder=body.folder,
            base_branch=body.baseBranch,
            user_id=admin.id,
        )
    with db.begin() as conn:
        record_audit(
            conn,
            "github_link_set",
            actor_user_id=admin.id,
            ip=client_ip(request),
            detail={
                "projectId": link["projectId"],
                "repo": link["repoFullName"],
                "folder": link["folder"],
                "baseBranch": link["baseBranch"],
            },
        )
    return {"link": link}


@router.delete("/projects/{id}/github-link", status_code=204)
def delete_github_link(id: str, request: Request, admin: AdminUser, db: Db) -> Response:
    with _github_errors(), db.begin() as conn:
        link = remove_link(conn, id)
        record_audit(
            conn,
            "github_link_removed",
            actor_user_id=admin.id,
            ip=client_ip(request),
            detail={"projectId": link["projectId"], "repo": link["repoFullName"], "folder": link["folder"]},
        )
    return Response(status_code=204)


# --- project members --------------------------------------------------------------------------------


@router.get("/projects/{id}/github-link")
def get_github_link(id: str, request: Request, user: CurrentUser, db: Db) -> dict[str, Any]:
    """What a project member needs to know: whether submitting is possible, and where it goes."""
    client = _client(request)
    with db.connect() as conn:
        require_project_access(conn, user.id, id, "view")
        if not project_exists(conn, id):
            raise ApiError(404, "Project not found")
        link = get_link_for_project(conn, id) if client else None
    return {"enabled": client is not None, "link": _link_summary(link)}


@router.get("/projects/{id}/submission-statuses")
def submission_statuses(id: str, user: CurrentUser, db: Db) -> dict[str, Any]:
    """Badges on a project's diagram list."""
    with db.connect() as conn:
        require_project_access(conn, user.id, id, "view")
        if not project_exists(conn, id):
            raise ApiError(404, "Project not found")
        return {"statuses": project_submission_badges(conn, id)}


# --- diagrams -----------------------------------------------------------------------------------------


def _submission_status(request: Request, conn: Connection, diagram_id: str, user_id: str) -> dict[str, Any]:
    """What the editor shows: where submitting goes, the latest pull request, the approved version."""
    client = _client(request)
    diagram = get_diagram(conn, diagram_id)
    link = get_link_for_project(conn, diagram["projectId"]) if client else None
    latest = get_latest_submission(conn, diagram_id)
    approved = get_approved_submission(conn, diagram_id)
    level = resolve_diagram_access(conn, user_id, diagram_id)
    blocking, warnings = check_submittable(
        conn, _bridge(request), diagram["diagramTypeId"], diagram["dslFamily"], diagram["dslContent"]
    )
    fingerprint = submission_fingerprint(diagram["dslContent"], diagram["name"], diagram["description"])

    reason: str | None = None
    if client is None:
        reason = "github_disabled"
    elif link is None:
        reason = "not_linked"
    elif not access_at_least(level, "edit"):
        reason = "no_edit_access"
    elif blocking:
        reason = "must_fix"

    current, submitted_fingerprint = latest if latest else (None, None)
    return {
        "enabled": client is not None,
        "link": _link_summary(link),
        "current": current,
        "approved": approved,
        "changesSinceSubmitting": submitted_fingerprint != fingerprint if latest else False,
        "canSubmit": {
            "allowed": reason is None,
            "reason": reason,
            "mustFixCount": len(blocking),
            "warningCount": len(warnings),
        },
        "canWithdraw": client is not None
        and current is not None
        and current["state"] == "open"
        and access_at_least(level, "edit"),
    }


@router.post("/diagrams/{id}/submissions")
def submit(id: str, request: Request, response: Response, user: CurrentUser, db: Db) -> dict[str, Any]:
    """Submits the saved diagram to GitHub for approval."""
    with db.connect() as conn:
        require_diagram_access(conn, user.id, id, "edit")
    with _github_errors():
        client = _require_client(request)
        bridge = _bridge(request)
        with db.connect() as conn:
            diagram = get_diagram(conn, id)
        settings = _settings(request)

        def draw(conn: Connection, family: str, dsl: str, type_id: str, background: str) -> str:
            return render_svg(conn, bridge, family, dsl, type_id, background)

        result = submit_diagram(
            client,
            bridge,
            db,
            diagram,
            Submitter(user.id, user.name, user.email),
            settings.canvas_public_url,
            validator_dir=settings.canvas_validator_dir,
            render_svg=draw,
        )
    response.status_code = 201 if result["outcome"] == "created" else 200
    return result


@router.get("/diagrams/{id}/submission")
def submission(id: str, request: Request, user: CurrentUser, db: Db) -> dict[str, Any]:
    with db.connect() as conn:
        require_diagram_access(conn, user.id, id, "view")
        return _submission_status(request, conn, id, user.id)


@router.post("/diagrams/{id}/submission/refresh")
def refresh_submission(id: str, request: Request, user: CurrentUser, db: Db) -> dict[str, Any]:
    """canvas-3s5.2: ask GitHub now (throttled per pull request), then answer like GET."""
    with db.connect() as conn:
        require_diagram_access(conn, user.id, id, "view")
        get_diagram(conn, id)
    client = _client(request)
    if client is not None:
        with _github_errors():
            refresh_diagram_submission(client, db, id)
    with db.connect() as conn:
        return _submission_status(request, conn, id, user.id)


@router.post("/diagrams/{id}/submission/withdraw")
def withdraw(id: str, request: Request, user: CurrentUser, db: Db) -> dict[str, Any]:
    """Closes the diagram's open pull request."""
    with db.connect() as conn:
        require_diagram_access(conn, user.id, id, "edit")
        get_diagram(conn, id)
    with _github_errors():
        withdraw_submission(_require_client(request), db, id, user.id, user.name)
    with db.connect() as conn:
        return _submission_status(request, conn, id, user.id)


@router.get("/diagrams/{id}/submissions")
def submissions(id: str, user: CurrentUser, db: Db) -> dict[str, Any]:
    with db.connect() as conn:
        require_diagram_access(conn, user.id, id, "view")
        get_diagram(conn, id)
        return {"submissions": list_submission_history(conn, id)}
