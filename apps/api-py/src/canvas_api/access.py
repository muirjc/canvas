"""Who may do what to a project (apps/api/src/sharing/access-levels.ts, projects/project.access.ts).

Everyone signed in can read every project (View); owning the project or an ancestor, or being an admin,
is Manage; a project grant on it or any ancestor counts too. The HIGHEST of these wins, then the viewer
role caps it at Comment. Access inherits downward only. A soft-deleted project (at any level of the
chain) stops the walk, as in the TypeScript service.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import Connection, bindparam, text

from canvas_api.errors import ApiError

AccessLevel = Literal["view", "comment", "edit", "manage"]
Membership = Literal["owner", "member"] | None

_RANK: dict[str, int] = {"view": 1, "comment": 2, "edit": 3, "manage": 4}
#: Decided 2026-10-29: the global viewer role never gets more than Comment, whatever it is granted.
VIEWER_ROLE_CAP: AccessLevel = "comment"


def access_at_least(level: AccessLevel | None, required: AccessLevel) -> bool:
    return level is not None and _RANK[level] >= _RANK[required]


def highest_access(*levels: str | None) -> AccessLevel | None:
    best: str | None = None
    for level in levels:
        if level and (best is None or _RANK[level] > _RANK[best]):
            best = level
    return best  # type: ignore[return-value]  # only ever one of the four levels


def cap_for_role(level: AccessLevel | None, role: str | None) -> AccessLevel | None:
    if level is None or role != "viewer":
        return level
    return VIEWER_ROLE_CAP if _RANK[level] > _RANK[VIEWER_ROLE_CAP] else level


_ANCESTOR_CHAIN = text(
    "WITH RECURSIVE chain (id, parent_project_id, owner_id, depth) AS ("
    " SELECT id, parent_project_id, owner_id, 0 FROM projects WHERE id = :id AND deleted_at IS NULL"
    " UNION ALL"
    " SELECT p.id, p.parent_project_id, p.owner_id, c.depth + 1"
    " FROM projects p JOIN chain c ON c.parent_project_id = p.id WHERE p.deleted_at IS NULL"
    ") SELECT id, owner_id FROM chain ORDER BY depth"
)


def project_exists(conn: Connection, project_id: str) -> bool:
    row = conn.execute(
        text("SELECT id FROM projects WHERE id = :id AND deleted_at IS NULL"), {"id": project_id}
    ).first()
    return row is not None


def _user_role(conn: Connection, user_id: str) -> str | None:
    row = conn.execute(text("SELECT role FROM users WHERE id = :id"), {"id": user_id}).first()
    return None if row is None else str(row.role)


def resolve_project_access(conn: Connection, user_id: str, project_id: str) -> AccessLevel | None:
    """The user's access to a project; None only when it doesn't exist (or is deleted)."""
    chain = conn.execute(_ANCESTOR_CHAIN, {"id": project_id}).all()
    if not chain:
        return None
    ids = [str(row.id) for row in chain]
    grants = conn.execute(
        text(
            "SELECT access_level FROM share_grants WHERE subject_type = 'project'"
            " AND grantee_user_id = :uid AND subject_id IN :ids"
        ).bindparams(bindparam("ids", expanding=True)),
        {"uid": user_id, "ids": ids},
    ).all()
    role = _user_role(conn, user_id)
    owns = any(str(row.owner_id) == user_id for row in chain)
    return cap_for_role(
        highest_access("view", "manage" if owns or role == "admin" else None, *(g.access_level for g in grants)),
        role,
    )


@dataclass(frozen=True)
class ProjectAccess:
    level: AccessLevel
    #: 'owner' (of it or an ancestor), 'member' (a grant on it or an ancestor), or None (read only).
    membership: Membership


def project_access_for_user(conn: Connection, user_id: str) -> dict[str, ProjectAccess]:
    """Every live project's access for one user, for the project list -- the same rule as
    resolve_project_access, for all projects at once (tens of projects, so in memory)."""
    projects = conn.execute(text("SELECT id, parent_project_id, owner_id FROM projects WHERE deleted_at IS NULL")).all()
    role = _user_role(conn, user_id)
    grants = conn.execute(
        text(
            "SELECT subject_id, access_level FROM share_grants"
            " WHERE subject_type = 'project' AND grantee_user_id = :uid"
        ),
        {"uid": user_id},
    ).all()
    by_id = {str(p.id): p for p in projects}
    grant_for = {str(g.subject_id): str(g.access_level) for g in grants}
    result: dict[str, ProjectAccess] = {}
    for project in projects:
        owns = False
        levels: list[str] = []
        seen: set[str] = set()  # guards against a (never expected) cycle
        current: Any = project
        while current is not None and str(current.id) not in seen:
            seen.add(str(current.id))
            if str(current.owner_id) == user_id:
                owns = True
            granted = grant_for.get(str(current.id))
            if granted:
                levels.append(granted)
            parent = current.parent_project_id
            current = by_id.get(str(parent)) if parent is not None else None
        level = cap_for_role(highest_access("view", "manage" if owns or role == "admin" else None, *levels), role)
        membership: Membership = "owner" if owns else ("member" if levels else None)
        result[str(project.id)] = ProjectAccess(level or "view", membership)
    return result


def require_project_access(conn: Connection, user_id: str, project_id: str, required: AccessLevel) -> None:
    """access-control.middleware.ts requireProjectAccess: a missing project falls through to the
    route's own 404 (a 403 would say it exists)."""
    if not project_exists(conn, project_id):
        return
    level = resolve_project_access(conn, user_id, project_id)
    if not access_at_least(level, required):
        raise ApiError(
            403,
            f'This action requires "{required}" access, but you only have "{level}" access to this project.'
            if level
            else "You do not have access to this project.",
        )


def resolve_diagram_access(conn: Connection, user_id: str, diagram_id: str) -> AccessLevel | None:
    """sharing.service.ts resolveDiagramAccess: the highest of open read (View), the user's access to
    the diagram's project, a diagram share and owning it (Manage); then the viewer cap. None only when
    the diagram doesn't exist."""
    diagram = conn.execute(text("SELECT owner_id, project_id FROM diagrams WHERE id = :id"), {"id": diagram_id}).first()
    if diagram is None:
        return None
    role = _user_role(conn, user_id)
    grant = conn.execute(
        text(
            "SELECT access_level FROM share_grants WHERE subject_type = 'diagram'"
            " AND subject_id = :id AND grantee_user_id = :uid"
        ),
        {"id": diagram_id, "uid": user_id},
    ).first()
    project_level = resolve_project_access(conn, user_id, str(diagram.project_id))
    return cap_for_role(
        highest_access(
            "view",
            project_level,
            grant.access_level if grant else None,
            "manage" if str(diagram.owner_id) == user_id else None,
        ),
        role,
    )


def require_diagram_access(conn: Connection, user_id: str, diagram_id: str, required: AccessLevel) -> None:
    """access-control.middleware.ts requireDiagramAccess. A missing diagram falls through to the route's
    own 404; someone else's unsaved draft doesn't exist for anyone else, admins included."""
    row = conn.execute(text("SELECT owner_id, draft FROM diagrams WHERE id = :id"), {"id": diagram_id}).first()
    if row is None:
        return
    if bool(row.draft) and str(row.owner_id) != user_id:
        raise ApiError(404, "Diagram not found")
    level = resolve_diagram_access(conn, user_id, diagram_id)
    if not access_at_least(level, required):
        raise ApiError(
            403,
            f'This action requires "{required}" access, but you only have "{level}" access to this diagram.'
            if level
            else "You do not have access to this diagram.",
        )
