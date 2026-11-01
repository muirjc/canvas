"""Projects: create, list, read, tree, rename, soft-delete and admin restore (phase 2, canvas-1bty.6).

Ported from apps/api/src/projects/project.routes.ts and project.service.ts; responses are held to
apps/api/contract/openapi.json. Members and ownership (/projects/:id/members, /owner) move with
sharing in phase 3.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Annotated, Any
from uuid import uuid4

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field, StrictStr
from sqlalchemy import Connection, Engine, bindparam, text

from canvas_api.access import project_access_for_user, require_project_access
from canvas_api.auth.roles import AdminUser, ArchitectOrAdmin, CurrentUser
from canvas_api.auth.session import SessionUser
from canvas_api.db import get_engine
from canvas_api.errors import ApiError
from canvas_api.timestamps import now_utc, to_api, to_db

router = APIRouter(tags=["Projects"])
Db = Annotated[Engine, Depends(get_engine)]

#: Soft-deleted projects older than this can't be restored (project.service.ts PROJECT_RETENTION_DAYS).
PROJECT_RETENTION_DAYS = 30


class CreateProjectBody(BaseModel):
    name: StrictStr = Field(min_length=1)
    parentProjectId: StrictStr | None = None


class RenameProjectBody(BaseModel):
    name: StrictStr = Field(min_length=1)


def _not_found(project_id: str) -> ApiError:
    return ApiError(404, f"No project with id {project_id}")


def _require_owner_or_admin(conn: Connection, user: SessionUser, project_id: str) -> None:
    """access-control.middleware.ts requireProjectOwnerOrAdmin: ownership, never a share grant. Looks at
    deleted projects too, as the TypeScript guard does."""
    row = conn.execute(text("SELECT owner_id FROM projects WHERE id = :id"), {"id": project_id}).first()
    if row is None:
        return
    if str(row.owner_id) != user.id and user.role != "admin":
        raise ApiError(403, "Only this project's owner or an admin can do that.")


def _project(row: Any) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "name": row.name,
        "parentProjectId": None if row.parent_project_id is None else str(row.parent_project_id),
        "createdAt": to_api(row.created_at),
    }


def _get_project(conn: Connection, project_id: str) -> dict[str, Any]:
    row = conn.execute(
        text("SELECT id, name, parent_project_id, created_at FROM projects WHERE id = :id AND deleted_at IS NULL"),
        {"id": project_id},
    ).first()
    if row is None:
        raise _not_found(project_id)
    return _project(row)


@router.post("/projects", status_code=201)
def create_project(user: ArchitectOrAdmin, db: Db, body: CreateProjectBody) -> dict[str, Any]:
    """Viewers are capped at Comment everywhere, so creating projects is for architects and admins."""
    with db.begin() as conn:
        if body.parentProjectId:
            parent = conn.execute(text("SELECT id FROM projects WHERE id = :id"), {"id": body.parentProjectId}).first()
            if parent is None:
                raise ApiError(400, f"Parent project {body.parentProjectId} does not exist")
        row = conn.execute(
            text(
                "INSERT INTO projects (id, name, parent_project_id, owner_id) VALUES (:id, :name, :parent, :owner)"
                " RETURNING id, name, parent_project_id, created_at"
            ),
            {"id": str(uuid4()), "name": body.name, "parent": body.parentProjectId or None, "owner": user.id},
        ).one()
    # A brand-new project has no diagrams, and its creator owns it.
    project = {**_project(row), "diagramCount": 0, "ownerId": user.id, "accessLevel": "manage", "membership": "owner"}
    return {"project": project}


@router.get("/projects")
def list_projects(user: CurrentUser, db: Db) -> dict[str, Any]:
    """Every live project with the caller's access to each, by name. An empty list is the first-run
    path, not an error."""
    with db.connect() as conn:
        access = project_access_for_user(conn, user.id)
        rows = conn.execute(
            text(
                "SELECT p.id, p.name, p.parent_project_id, p.created_at, p.owner_id, COUNT(d.id) AS diagram_count"
                " FROM projects p"
                " LEFT JOIN diagrams d ON d.project_id = p.id AND d.deleted_at IS NULL AND d.draft = :no"
                " WHERE p.deleted_at IS NULL"
                " GROUP BY p.id ORDER BY p.name, p.id"
            ),
            {"no": False},
        ).all()
    projects = []
    for row in rows:
        entry = access.get(str(row.id))
        projects.append(
            {
                **_project(row),
                "ownerId": str(row.owner_id),
                "diagramCount": int(row.diagram_count),
                "accessLevel": entry.level if entry else "view",
                "membership": entry.membership if entry else None,
            }
        )
    return {"projects": projects}


@router.get("/projects/{id}")
def get_project(id: str, user: CurrentUser, db: Db) -> dict[str, Any]:
    with db.connect() as conn:
        require_project_access(conn, user.id, id, "view")
        return {"project": _get_project(conn, id)}


@router.get("/projects/{id}/tree")
def get_project_tree(id: str, user: CurrentUser, db: Db) -> dict[str, Any]:
    """The project's subtree with each level's diagrams (newest first), for the project browser."""
    with db.connect() as conn:
        require_project_access(conn, user.id, id, "view")
        projects = conn.execute(
            text(
                "WITH RECURSIVE subtree (id, name, parent_project_id) AS ("
                " SELECT id, name, parent_project_id FROM projects WHERE id = :id AND deleted_at IS NULL"
                " UNION ALL"
                " SELECT p.id, p.name, p.parent_project_id FROM projects p"
                " JOIN subtree s ON s.id = p.parent_project_id WHERE p.deleted_at IS NULL"
                ") SELECT id, name, parent_project_id FROM subtree"
            ),
            {"id": id},
        ).all()
        root = next((p for p in projects if str(p.id) == id), None)
        if root is None:
            raise _not_found(id)
        diagrams = conn.execute(
            text(
                "SELECT id, name, diagram_type_id, project_id FROM diagrams"
                " WHERE deleted_at IS NULL AND draft = :no AND project_id IN :ids"
                " ORDER BY created_at DESC, id DESC"
            ).bindparams(bindparam("ids", expanding=True)),
            {"no": False, "ids": [str(p.id) for p in projects]},
        ).all()

    children: dict[str, list[Any]] = {}
    for project in projects:
        children.setdefault(str(project.parent_project_id or ""), []).append(project)
    by_project: dict[str, list[dict[str, str]]] = {}
    for d in diagrams:
        by_project.setdefault(str(d.project_id), []).append(
            {"id": str(d.id), "name": d.name, "diagramTypeId": d.diagram_type_id}
        )

    def build(project: Any) -> dict[str, Any]:
        return {
            "id": str(project.id),
            "name": project.name,
            "diagrams": by_project.get(str(project.id), []),
            "children": [build(child) for child in children.get(str(project.id), [])],
        }

    return {"tree": build(root)}


@router.patch("/projects/{id}")
def rename_project(id: str, user: CurrentUser, db: Db, body: RenameProjectBody) -> dict[str, Any]:
    with db.begin() as conn:
        _require_owner_or_admin(conn, user, id)
        row = conn.execute(
            text(
                "UPDATE projects SET name = :name WHERE id = :id AND deleted_at IS NULL"
                " RETURNING id, name, parent_project_id, created_at"
            ),
            {"name": body.name, "id": id},
        ).first()
        if row is None:
            raise _not_found(id)
        return {"project": _project(row)}


@router.delete("/projects/{id}", status_code=204)
def delete_project(id: str, user: CurrentUser, db: Db) -> Response:
    """Soft-deletes a project with nothing in it: no live diagrams, no live sub-projects. Deleting an
    already-deleted project succeeds (idempotent)."""
    with db.begin() as conn:
        _require_owner_or_admin(conn, user, id)
        row = conn.execute(text("SELECT deleted_at FROM projects WHERE id = :id"), {"id": id}).first()
        if row is None:
            raise _not_found(id)
        if row.deleted_at is not None:
            return Response(status_code=204)
        diagram_count = conn.execute(
            text("SELECT COUNT(*) FROM diagrams WHERE project_id = :id AND deleted_at IS NULL AND draft = :no"),
            {"id": id, "no": False},
        ).scalar_one()
        child_count = conn.execute(
            text("SELECT COUNT(*) FROM projects WHERE parent_project_id = :id AND deleted_at IS NULL"), {"id": id}
        ).scalar_one()
        if int(diagram_count) > 0 or int(child_count) > 0:
            raise ApiError(409, "Only a project with no diagrams and no sub-projects can be deleted.")
        conn.execute(
            text("UPDATE projects SET deleted_at = :at, deleted_by_user_id = :by WHERE id = :id"),
            {"at": to_db(now_utc(), conn.dialect.name), "by": user.id, "id": id},
        )
    return Response(status_code=204)


def _retention_boundary(dialect: str) -> Any:
    return to_db(now_utc() - timedelta(days=PROJECT_RETENTION_DAYS), dialect)


@router.get("/admin/deleted-projects")
def list_deleted_projects(_admin: AdminUser, db: Db) -> dict[str, Any]:
    """Soft-deleted projects still inside their retention window, newest first."""
    with db.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT id, name, owner_id, deleted_at FROM projects"
                " WHERE deleted_at IS NOT NULL AND deleted_at > :boundary ORDER BY deleted_at DESC"
            ),
            {"boundary": _retention_boundary(conn.dialect.name)},
        ).all()
    return {
        "projects": [
            {"id": str(r.id), "name": r.name, "ownerId": str(r.owner_id), "deletedAt": to_api(r.deleted_at)}
            for r in rows
        ]
    }


@router.post("/projects/{id}/restore")
def restore_project(id: str, admin: AdminUser, db: Db) -> dict[str, Any]:
    with db.begin() as conn:
        row = conn.execute(text("SELECT deleted_at FROM projects WHERE id = :id"), {"id": id}).first()
        if row is None or row.deleted_at is None:
            raise ApiError(404, f"No soft-deleted project with id {id}")
        dialect = conn.dialect.name
        if not _deleted_within_retention(row.deleted_at, dialect):
            raise ApiError(409, "This project is no longer available to restore.")
        conn.execute(
            text(
                "UPDATE projects SET deleted_at = NULL, deleted_by_user_id = NULL,"
                " restored_at = :at, restored_by_user_id = :by WHERE id = :id"
            ),
            {"at": to_db(now_utc(), dialect), "by": admin.id, "id": id},
        )
        return {"project": _get_project(conn, id)}


def _deleted_within_retention(deleted_at: Any, dialect: str) -> bool:
    boundary = now_utc() - timedelta(days=PROJECT_RETENTION_DAYS)
    if isinstance(deleted_at, str):
        # SQLite text: compare as instants (the TypeScript service parses it into a Date, toDate()).
        iso = to_api(deleted_at) or ""
        return datetime.fromisoformat(iso.replace("Z", "+00:00")) > boundary
    return bool(deleted_at > boundary)
