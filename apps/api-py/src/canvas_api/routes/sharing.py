"""Sharing and project members (phase 3, canvas-1bty.7; apps/api/src/sharing/sharing.routes.ts and
sharing.service.ts, and project.routes.ts's members/owner routes).

Who may do what: giving, changing or removing access needs Manage for a project's members and Edit for
a single diagram's shares; seeing the list needs View. Manage is a project level only, and only someone
with Manage can hand out, change or remove Manage. Changes to project members are audited.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field, StrictStr
from sqlalchemy import Connection, Engine, text

from canvas_api.access import (
    AccessLevel,
    access_at_least,
    project_access_for_user,
    project_exists,
    require_diagram_access,
    require_project_access,
    resolve_diagram_access,
    resolve_project_access,
)
from canvas_api.audit import client_ip, record_audit
from canvas_api.auth.roles import CurrentUser
from canvas_api.auth.session import SessionUser
from canvas_api.db import get_engine
from canvas_api.errors import ApiError
from canvas_api.timestamps import to_api

router = APIRouter(tags=["Sharing"])
Db = Annotated[Engine, Depends(get_engine)]

SubjectType = Literal["diagram", "project"]
#: What it takes to add, change or remove access.
MANAGE_LEVEL: dict[str, AccessLevel] = {"project": "manage", "diagram": "edit"}


class DiagramShareBody(BaseModel):
    granteeUserId: StrictStr = Field(min_length=1)
    #: A diagram share stops at Edit.
    accessLevel: Literal["view", "comment", "edit"]


class ProjectShareBody(BaseModel):
    granteeUserId: StrictStr = Field(min_length=1)
    accessLevel: Literal["view", "comment", "edit", "manage"]


class NewOwnerBody(BaseModel):
    newOwnerId: StrictStr = Field(min_length=1)


def _access_to(conn: Connection, subject_type: str, user_id: str, subject_id: str) -> AccessLevel | None:
    if subject_type == "project":
        return resolve_project_access(conn, user_id, subject_id)
    return resolve_diagram_access(conn, user_id, subject_id)


def _guard(
    conn: Connection, subject_type: SubjectType, user: SessionUser, subject_id: str, required: AccessLevel
) -> None:
    """The subject's access check, then 404 for a missing project or a missing/deleted diagram."""
    if subject_type == "project":
        require_project_access(conn, user.id, subject_id, required)
        exists = project_exists(conn, subject_id)
    else:
        require_diagram_access(conn, user.id, subject_id, required)
        exists = (
            conn.execute(
                text("SELECT id FROM diagrams WHERE id = :id AND deleted_at IS NULL"), {"id": subject_id}
            ).first()
            is not None
        )
    if not exists:
        raise ApiError(404, f"No {subject_type} with id {subject_id}")


def _grant(row: Any) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "subjectType": row.subject_type,
        "subjectId": str(row.subject_id),
        "granteeUserId": str(row.grantee_user_id),
        "accessLevel": row.access_level,
        "grantedByUserId": str(row.granted_by_user_id),
        "createdAt": to_api(row.created_at),
    }


def _share(
    request: Request,
    db: Engine,
    user: SessionUser,
    subject_type: SubjectType,
    subject_id: str,
    grantee: str,
    level: str,
) -> dict[str, Any]:
    with db.begin() as conn:
        _guard(conn, subject_type, user, subject_id, MANAGE_LEVEL[subject_type])
        existing = conn.execute(
            text(
                "SELECT access_level FROM share_grants"
                " WHERE subject_type = :type AND subject_id = :id AND grantee_user_id = :grantee"
            ),
            {"type": subject_type, "id": subject_id, "grantee": grantee},
        ).first()
        previous = existing.access_level if existing else None
        # Only someone with Manage hands out Manage or changes someone's Manage (an editor can't promote
        # themselves, or demote a manager by re-sharing lower).
        if (level == "manage" or previous == "manage") and not access_at_least(
            _access_to(conn, subject_type, user.id, subject_id), "manage"
        ):
            raise ApiError(403, "Only the owner or someone with Manage access can give or change Manage access.")
        # Org-internal only: the grantee must be an active user of this deployment.
        active = conn.execute(
            text("SELECT id FROM users WHERE id = :id AND active = :yes"), {"id": grantee, "yes": True}
        ).first()
        if active is None:
            raise ApiError(400, f"No active user with id {grantee}")
        row = conn.execute(
            text(
                "INSERT INTO share_grants"
                " (id, subject_type, subject_id, grantee_user_id, access_level, granted_by_user_id)"
                " VALUES (:gid, :type, :id, :grantee, :level, :by)"
                " ON CONFLICT (subject_type, subject_id, grantee_user_id)"
                " DO UPDATE SET access_level = excluded.access_level"
                " RETURNING id, subject_type, subject_id, grantee_user_id, access_level, granted_by_user_id, created_at"
            ),
            {
                "gid": str(uuid4()),
                "type": subject_type,
                "id": subject_id,
                "grantee": grantee,
                "level": level,
                "by": user.id,
            },
        ).one()
        if subject_type == "project" and previous != level:
            record_audit(
                conn,
                "project_member_changed" if previous else "project_member_added",
                actor_user_id=user.id,
                target_user_id=grantee,
                ip=client_ip(request),
                detail={"projectId": subject_id, "level": level, **({"from": previous} if previous else {})},
            )
        return {"grant": _grant(row)}


def _list(db: Engine, user: SessionUser, subject_type: SubjectType, subject_id: str) -> dict[str, Any]:
    """With each grantee's name and email, so the share dialog shows who, not an id."""
    with db.connect() as conn:
        _guard(conn, subject_type, user, subject_id, "view")
        rows = conn.execute(
            text(
                "SELECT g.id, g.subject_type, g.subject_id, g.grantee_user_id, g.access_level,"
                " g.granted_by_user_id, g.created_at, u.name AS grantee_name, u.email AS grantee_email"
                " FROM share_grants g LEFT JOIN users u ON u.id = g.grantee_user_id"
                " WHERE g.subject_type = :type AND g.subject_id = :id ORDER BY g.created_at"
            ),
            {"type": subject_type, "id": subject_id},
        ).all()
    return {"grants": [{**_grant(r), "granteeName": r.grantee_name, "granteeEmail": r.grantee_email} for r in rows]}


@router.post("/diagrams/{id}/shares", status_code=201)
def share_diagram(id: str, request: Request, user: CurrentUser, db: Db, body: DiagramShareBody) -> dict[str, Any]:
    return _share(request, db, user, "diagram", id, body.granteeUserId, body.accessLevel)


@router.get("/diagrams/{id}/shares")
def list_diagram_shares(id: str, user: CurrentUser, db: Db) -> dict[str, Any]:
    return _list(db, user, "diagram", id)


@router.post("/projects/{id}/shares", status_code=201)
def share_project(id: str, request: Request, user: CurrentUser, db: Db, body: ProjectShareBody) -> dict[str, Any]:
    return _share(request, db, user, "project", id, body.granteeUserId, body.accessLevel)


@router.get("/projects/{id}/shares")
def list_project_shares(id: str, user: CurrentUser, db: Db) -> dict[str, Any]:
    return _list(db, user, "project", id)


@router.get("/shared-diagrams")
def shared_diagrams(user: CurrentUser, db: Db) -> dict[str, Any]:
    """Diagrams shared directly with the caller. A diagram in a project they're already a member of (at
    the shared level or higher) is reached through their projects, so it isn't listed again."""
    with db.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT d.id AS diagram_id, d.name AS diagram_name, d.diagram_type_id, d.project_id,"
                " p.name AS project_name, sg.access_level, u.name AS shared_by_name, u.email AS shared_by_email,"
                " sg.created_at AS shared_at"
                " FROM share_grants sg JOIN diagrams d ON d.id = sg.subject_id"
                " JOIN projects p ON p.id = d.project_id JOIN users u ON u.id = sg.granted_by_user_id"
                " WHERE sg.subject_type = 'diagram' AND sg.grantee_user_id = :uid"
                " AND d.deleted_at IS NULL AND d.draft = :no ORDER BY d.name, d.id"
            ),
            {"uid": user.id, "no": False},
        ).all()
        projects = project_access_for_user(conn, user.id)

    def covered(project_id: str, level: AccessLevel) -> bool:
        entry = projects.get(project_id)
        return entry is not None and entry.membership is not None and access_at_least(entry.level, level)

    return {
        "diagrams": [
            {
                "diagramId": str(r.diagram_id),
                "diagramName": r.diagram_name,
                "diagramTypeId": r.diagram_type_id,
                "projectName": r.project_name,
                "accessLevel": r.access_level,
                "sharedByName": r.shared_by_name,
                "sharedByEmail": r.shared_by_email,
                "sharedAt": to_api(r.shared_at),
            }
            for r in rows
            if not covered(str(r.project_id), r.access_level)
        ]
    }


@router.delete("/shares/{id}", status_code=204)
def revoke_share(id: str, request: Request, user: CurrentUser, db: Db) -> Response:
    """Removing a share needs the same access as giving it."""
    with db.begin() as conn:
        grant = conn.execute(
            text("SELECT subject_type, subject_id, access_level, grantee_user_id FROM share_grants WHERE id = :id"),
            {"id": id},
        ).first()
        if grant is None:
            raise ApiError(404, f"No share grant with id {id}")
        level = _access_to(conn, grant.subject_type, user.id, str(grant.subject_id))
        if not access_at_least(level, MANAGE_LEVEL[grant.subject_type]):
            raise ApiError(
                403,
                "Only the owner or someone with Manage access can remove a member."
                if grant.subject_type == "project"
                else "Only someone with edit access can remove a share.",
            )
        if grant.access_level == "manage" and not access_at_least(level, "manage"):
            raise ApiError(403, "Only the owner or someone with Manage access can remove Manage access.")
        conn.execute(text("DELETE FROM share_grants WHERE id = :id"), {"id": id})
        if grant.subject_type == "project":
            record_audit(
                conn,
                "project_member_removed",
                actor_user_id=user.id,
                target_user_id=str(grant.grantee_user_id),
                ip=client_ip(request),
                detail={"projectId": str(grant.subject_id), "from": grant.access_level},
            )
    return Response(status_code=204)


# --- project members and ownership --------------------------------------------------------------------


def list_project_members(conn: Connection, project_id: str) -> dict[str, Any]:
    """Who owns a project and who has been added to it (its project share grants)."""
    project = conn.execute(
        text(
            "SELECT p.owner_id, u.name, u.email FROM projects p LEFT JOIN users u ON u.id = p.owner_id"
            " WHERE p.id = :id AND p.deleted_at IS NULL"
        ),
        {"id": project_id},
    ).first()
    if project is None:
        raise ApiError(404, f"No project with id {project_id}")
    rows = conn.execute(
        text(
            "SELECT g.id, g.grantee_user_id, g.access_level, u.name, u.email"
            " FROM share_grants g LEFT JOIN users u ON u.id = g.grantee_user_id"
            " WHERE g.subject_type = 'project' AND g.subject_id = :id ORDER BY u.name, g.id"
        ),
        {"id": project_id},
    ).all()
    return {
        "owner": {"id": str(project.owner_id), "name": project.name, "email": project.email},
        "members": [
            {
                "grantId": str(r.id),
                "userId": str(r.grantee_user_id),
                "name": r.name,
                "email": r.email,
                "accessLevel": r.access_level,
            }
            for r in rows
        ],
    }


@router.get("/projects/{id}/members", tags=["Projects"])
def project_members(id: str, user: CurrentUser, db: Db) -> dict[str, Any]:
    """Anyone who can read the project sees who's in it; `yourAccess` says whether they may manage."""
    with db.connect() as conn:
        require_project_access(conn, user.id, id, "view")
        members = list_project_members(conn, id)
        return {**members, "yourAccess": resolve_project_access(conn, user.id, id)}


@router.post("/projects/{id}/owner", tags=["Projects"])
def transfer_ownership(id: str, request: Request, user: CurrentUser, db: Db, body: NewOwnerBody) -> dict[str, Any]:
    """Hands the project to someone else (its owner or an admin only). The new owner's member entry goes
    (owning gives Manage) and the previous owner stays on as a Manage member."""
    new_owner = body.newOwnerId
    with db.begin() as conn:
        owner_row = conn.execute(text("SELECT owner_id FROM projects WHERE id = :id"), {"id": id}).first()
        if owner_row is not None and str(owner_row.owner_id) != user.id and user.role != "admin":
            raise ApiError(403, "Only this project's owner or an admin can do that.")
        project = conn.execute(
            text("SELECT owner_id FROM projects WHERE id = :id AND deleted_at IS NULL"), {"id": id}
        ).first()
        if project is None:
            raise ApiError(404, f"No project with id {id}")
        target = conn.execute(
            text("SELECT id, role FROM users WHERE id = :id AND active = :yes"), {"id": new_owner, "yes": True}
        ).first()
        if target is None:
            raise ApiError(400, f"No active user with id {new_owner}")
        if target.role == "viewer":
            raise ApiError(400, "A viewer can only read and comment, so they cannot own a project.")
        previous = str(project.owner_id)
        if previous != new_owner:
            conn.execute(text("UPDATE projects SET owner_id = :owner WHERE id = :id"), {"owner": new_owner, "id": id})
            conn.execute(
                text(
                    "DELETE FROM share_grants WHERE subject_type = 'project' AND subject_id = :id"
                    " AND grantee_user_id = :owner"
                ),
                {"id": id, "owner": new_owner},
            )
            conn.execute(
                text(
                    "INSERT INTO share_grants"
                    " (id, subject_type, subject_id, grantee_user_id, access_level, granted_by_user_id)"
                    " VALUES (:gid, 'project', :id, :previous, 'manage', :by)"
                    " ON CONFLICT (subject_type, subject_id, grantee_user_id) DO UPDATE SET access_level = 'manage'"
                ),
                {"gid": str(uuid4()), "id": id, "previous": previous, "by": user.id},
            )
            record_audit(
                conn,
                "project_owner_transferred",
                actor_user_id=user.id,
                target_user_id=new_owner,
                ip=client_ip(request),
                detail={"projectId": id, "from": previous},
            )
        return list_project_members(conn, id)
