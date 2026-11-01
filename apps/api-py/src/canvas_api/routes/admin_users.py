"""Admin users, the audit log and the admin overview, plus the user lookup every signed-in user has
(phase 3, canvas-1bty.7; apps/api/src/admin/admin.routes.ts, admin.service.ts, user-deletion.service.ts,
user-lookup.routes.ts).

Local accounts (create with a one-time password, reset password or two-step verification, unlock) stay
in TypeScript until sign-in moves (phase 9).
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Body, Depends, Query, Request
from pydantic import BaseModel, Field, StrictBool, StrictStr
from sqlalchemy import Connection, Engine, bindparam, text

from canvas_api.audit import client_ip, record_audit
from canvas_api.auth.roles import AdminUser, CurrentUser
from canvas_api.auth.session import revoke_sessions
from canvas_api.db import get_engine
from canvas_api.errors import ApiError
from canvas_api.timestamps import now_utc, to_api_ms, to_db

router = APIRouter(tags=["Admin"])
Db = Annotated[Engine, Depends(get_engine)]

Role = Literal["admin", "architect", "viewer"]
Persona = Literal["Business", "Enterprise", "Solution", "Technical"]
#: Role and/or active; a NULL leaves that column as it is. (A fixed statement: SQLAlchemy Core binds a
#: string as VARCHAR, which Postgres won't compare with the UUID id.)
_UPDATE_USER = text("UPDATE users SET role = COALESCE(:role, role), active = COALESCE(:active, active) WHERE id = :id")


class UpdateUserBody(BaseModel):
    role: Role | None = None
    #: A user's personas decide which diagram types they're offered first -- only the four, once each.
    personas: list[Persona] | None = Field(default=None, max_length=4)
    active: StrictBool | None = None


class DeleteUserBody(BaseModel):
    transferToUserId: StrictStr | None = Field(default=None, min_length=1)


def _personas(conn: Connection, user_ids: list[str]) -> dict[str, list[str]]:
    if not user_ids:
        return {}
    rows = conn.execute(
        text("SELECT user_id, persona FROM users_personas WHERE user_id IN :ids ORDER BY user_id, position").bindparams(
            bindparam("ids", expanding=True)
        ),
        {"ids": user_ids},
    ).all()
    result: dict[str, list[str]] = {}
    for row in rows:
        result.setdefault(str(row.user_id), []).append(row.persona)
    return result


@router.get("/admin/users")
def list_users(_admin: AdminUser, db: Db) -> dict[str, Any]:
    with db.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT u.id, u.name, u.email, u.role, u.active, c.user_id AS credential_user_id, c.locked_at,"
                " m.enabled_at AS mfa_enabled_at FROM users u"
                " LEFT JOIN local_credentials c ON c.user_id = u.id LEFT JOIN user_mfa m ON m.user_id = u.id"
                " WHERE u.deleted_at IS NULL ORDER BY u.name"
            )
        ).all()
        personas = _personas(conn, [str(r.id) for r in rows])
    return {
        "users": [
            {
                "id": str(r.id),
                "name": r.name,
                "email": r.email,
                "role": r.role,
                "personas": personas.get(str(r.id), []),
                "active": bool(r.active),
                "hasPassword": r.credential_user_id is not None,
                "locked": r.locked_at is not None,
                "mfaEnabled": r.mfa_enabled_at is not None,
            }
            for r in rows
        ]
    }


def _other_active_admins(conn: Connection, user_id: str) -> int:
    return int(
        conn.execute(
            text(
                "SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = :yes AND deleted_at IS NULL AND id != :id"
            ),
            {"yes": True, "id": user_id},
        ).scalar_one()
    )


@router.patch("/admin/users/{id}")
def update_user(id: str, request: Request, admin: AdminUser, db: Db, body: UpdateUserBody) -> dict[str, Any]:
    """Role, personas or active status. Never leaves the platform without an active admin; a deactivated
    user, or one whose role changes, is signed out now (sessions hold the role from sign-in)."""
    if body.personas is not None and len(set(body.personas)) != len(body.personas):
        raise ApiError(400, "body/personas must NOT have duplicate items")
    given = body.model_fields_set
    with db.begin() as conn:
        before = conn.execute(
            text("SELECT role, active FROM users WHERE id = :id AND deleted_at IS NULL"), {"id": id}
        ).first()
        if before is None:
            raise ApiError(404, f"No user with id {id}")
        was_active_admin = before.role == "admin" and bool(before.active)
        stays_active_admin = (body.role or before.role) == "admin" and (
            body.active if body.active is not None else bool(before.active)
        )
        if was_active_admin and not stays_active_admin and _other_active_admins(conn, id) == 0:
            raise ApiError(409, "This is the only active admin -- make someone else an admin first.")
        if body.role is not None or body.active is not None:
            conn.execute(_UPDATE_USER, {"role": body.role, "active": body.active, "id": id})
        if body.personas is not None:
            conn.execute(text("DELETE FROM users_personas WHERE user_id = :id"), {"id": id})
            if body.personas:
                conn.execute(
                    text("INSERT INTO users_personas (user_id, persona, position) VALUES (:id, :persona, :position)"),
                    [{"id": id, "persona": p, "position": i} for i, p in enumerate(body.personas)],
                )
        if body.active is False or (body.role is not None and body.role != before.role):
            revoke_sessions(conn, id)
        row = conn.execute(text("SELECT id, name, email, role, active FROM users WHERE id = :id"), {"id": id}).one()
        user = {
            "id": str(row.id),
            "name": row.name,
            "email": row.email,
            "role": row.role,
            "active": bool(row.active),
            "personas": _personas(conn, [id]).get(id, []),
        }
        # The fields the admin sent, as the TypeScript route records them.
        record_audit(
            conn,
            "user_updated",
            actor_user_id=admin.id,
            target_user_id=id,
            ip=client_ip(request),
            detail=body.model_dump(include=given),
        )
        return {"user": user}


def _active_user(conn: Connection, user_id: str) -> Any:
    return conn.execute(
        text("SELECT id, email, name, role, active FROM users WHERE id = :id AND deleted_at IS NULL"),
        {"id": user_id},
    ).first()


_ACTIVE_ADMINS = text("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = :yes AND deleted_at IS NULL")
_OWNED_PROJECTS = text("SELECT COUNT(*) FROM projects WHERE owner_id = :id")
_OWNED_DIAGRAMS = text("SELECT COUNT(*) FROM diagrams WHERE owner_id = :id")
_SHARES_RECEIVED = text("SELECT COUNT(*) FROM share_grants WHERE grantee_user_id = :id")


def _deletion_impact(conn: Connection, user_id: str) -> dict[str, Any]:
    user = _active_user(conn, user_id)
    if user is None:
        raise ApiError(404, f"No user with id {user_id}")

    def count(statement: Any) -> int:
        return int(conn.execute(statement, {"id": user_id, "yes": True}).scalar_one())

    admins = count(_ACTIVE_ADMINS)
    return {
        "ownedProjects": count(_OWNED_PROJECTS),
        "ownedDiagrams": count(_OWNED_DIAGRAMS),
        "sharesReceived": count(_SHARES_RECEIVED),
        "isLastActiveAdmin": user.role == "admin" and bool(user.active) and admins <= 1,
    }


@router.get("/admin/users/{id}/deletion-impact")
def deletion_impact(id: str, _admin: AdminUser, db: Db) -> dict[str, Any]:
    """What deleting a user would transfer or remove, for the confirmation dialog."""
    with db.connect() as conn:
        return _deletion_impact(conn, id)


#: What goes with a deleted user (their placeholder row stays).
_REMOVED_WITH_USER = (
    text("DELETE FROM share_grants WHERE grantee_user_id = :id"),
    text("DELETE FROM mfa_recovery_codes WHERE user_id = :id"),
    text("DELETE FROM user_mfa WHERE user_id = :id"),
    text("DELETE FROM local_credentials WHERE user_id = :id"),
    text("DELETE FROM users_personas WHERE user_id = :id"),
)


@router.delete("/admin/users/{id}")
def delete_user(
    id: str,
    request: Request,
    admin: AdminUser,
    db: Db,
    body: Annotated[DeleteUserBody | None, Body()] = None,
) -> dict[str, Any]:
    """The row stays (strict foreign keys point at it) as an anonymised, inactive placeholder. Their
    projects and diagrams go to another user; credentials, two-step verification, personas, sessions and
    the shares they received go; history stays."""
    transfer_to = body.transferToUserId if body else None
    if id == admin.id:
        raise ApiError(409, "You can't delete your own account.")
    with db.begin() as conn:
        user = _active_user(conn, id)
        if user is None:
            raise ApiError(404, f"No user with id {id}")
        impact = _deletion_impact(conn, id)
        if impact["isLastActiveAdmin"]:
            raise ApiError(409, "This is the only active admin -- make someone else an admin first.")
        if impact["ownedProjects"] + impact["ownedDiagrams"] > 0 and not transfer_to:
            raise ApiError(409, "Choose who receives their projects and diagrams.")
        transfer_email = None
        if transfer_to:
            if transfer_to == id:
                raise ApiError(409, "Their content can't be transferred to them.")
            target = _active_user(conn, transfer_to)
            if target is None or not bool(target.active):
                raise ApiError(409, "Transfer to an active user.")
            transfer_email = target.email
            conn.execute(text("UPDATE projects SET owner_id = :to WHERE owner_id = :id"), {"to": transfer_to, "id": id})
            conn.execute(text("UPDATE diagrams SET owner_id = :to WHERE owner_id = :id"), {"to": transfer_to, "id": id})
        for statement in _REMOVED_WITH_USER:
            conn.execute(statement, {"id": id})
        revoke_sessions(conn, id)
        conn.execute(
            text(
                "UPDATE users SET name = 'Deleted user', email = :email, active = :no, deleted_at = :at WHERE id = :id"
            ),
            {
                "email": f"deleted-{id}@deleted.invalid",
                "no": False,
                "at": to_db(now_utc(), conn.dialect.name),
                "id": id,
            },
        )
        # The placeholder keeps no name or email, so the audit entry records them.
        record_audit(
            conn,
            "user_deleted",
            actor_user_id=admin.id,
            target_user_id=id,
            ip=client_ip(request),
            detail={
                "email": user.email,
                "name": user.name,
                "transferredTo": transfer_to,
                "transferredToEmail": transfer_email,
                "projects": impact["ownedProjects"],
                "diagrams": impact["ownedDiagrams"],
                "sharesRemoved": impact["sharesReceived"],
            },
        )
    return {
        "deleted": True,
        "transferredProjects": impact["ownedProjects"] if transfer_to else 0,
        "transferredDiagrams": impact["ownedDiagrams"] if transfer_to else 0,
    }


#: RFC 3339 date-time, the `format: date-time` the TypeScript route's querystring schema checks.
_DATE_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$")
#: (paging back, for one user) -> the whole statement for those filters.
_AUDIT = {
    (False, False): text(
        "SELECT e.id, e.occurred_at, e.event, e.ip, e.detail, a.email AS actor_email, t.email AS target_email"
        " FROM audit_events e LEFT JOIN users a ON a.id = e.actor_user_id LEFT JOIN users t ON t.id = e.target_user_id"
        " ORDER BY e.occurred_at DESC, e.id DESC LIMIT :limit"
    ),
    (True, False): text(
        "SELECT e.id, e.occurred_at, e.event, e.ip, e.detail, a.email AS actor_email, t.email AS target_email"
        " FROM audit_events e LEFT JOIN users a ON a.id = e.actor_user_id LEFT JOIN users t ON t.id = e.target_user_id"
        " WHERE e.occurred_at < :before"
        " ORDER BY e.occurred_at DESC, e.id DESC LIMIT :limit"
    ),
    (False, True): text(
        "SELECT e.id, e.occurred_at, e.event, e.ip, e.detail, a.email AS actor_email, t.email AS target_email"
        " FROM audit_events e LEFT JOIN users a ON a.id = e.actor_user_id LEFT JOIN users t ON t.id = e.target_user_id"
        " WHERE (e.actor_user_id = :uid OR e.target_user_id = :uid)"
        " ORDER BY e.occurred_at DESC, e.id DESC LIMIT :limit"
    ),
    (True, True): text(
        "SELECT e.id, e.occurred_at, e.event, e.ip, e.detail, a.email AS actor_email, t.email AS target_email"
        " FROM audit_events e LEFT JOIN users a ON a.id = e.actor_user_id LEFT JOIN users t ON t.id = e.target_user_id"
        " WHERE e.occurred_at < :before AND (e.actor_user_id = :uid OR e.target_user_id = :uid)"
        " ORDER BY e.occurred_at DESC, e.id DESC LIMIT :limit"
    ),
}


@router.get("/admin/audit")
def audit_log(
    _admin: AdminUser,
    db: Db,
    limit: Annotated[str | None, Query(pattern=r"^([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$")] = None,
    before: str | None = None,
    userId: str | None = None,
) -> dict[str, Any]:
    """Newest first; `before` (an occurredAt from the previous page) pages backwards, `userId` filters."""
    if before is not None and not _DATE_TIME.match(before):
        raise ApiError(400, 'querystring/before must match format "date-time"')
    with db.connect() as conn:
        instant = (
            None if before is None else to_db(datetime.fromisoformat(before.replace("Z", "+00:00")), conn.dialect.name)
        )
        statement = _AUDIT[(instant is not None, bool(userId))]
        params = {"before": instant, "uid": userId, "limit": int(limit) if limit else 50}
        rows = conn.execute(statement, params).all()
    return {
        "events": [
            {
                "id": str(r.id),
                "occurredAt": to_api_ms(r.occurred_at),
                "event": r.event,
                "actorEmail": r.actor_email,
                "targetEmail": r.target_email,
                "ip": r.ip,
                "detail": json.loads(r.detail) if r.detail else None,
            }
            for r in rows
        ]
    }


@router.get("/admin/overview")
def overview(_admin: AdminUser, db: Db) -> dict[str, Any]:
    """The admin console's landing page."""
    with db.connect() as conn:
        users = conn.execute(text("SELECT COUNT(*) FROM users WHERE deleted_at IS NULL")).scalar_one()
        standards = conn.execute(
            text(
                "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published"
                " FROM standards"
            )
        ).one()
        libraries = conn.execute(text("SELECT COUNT(*) FROM icon_libraries")).scalar_one()
    return {
        "overview": {
            "userCount": int(users),
            "standardsCount": int(standards.total),
            "publishedStandardsCount": int(standards.published or 0),
            "libraryCount": int(libraries),
        }
    }


# --- any signed-in user ---------------------------------------------------------------------------------


@router.get("/users/lookup", tags=["Users"])
def lookup_user(_user: CurrentUser, db: Db, email: Annotated[str, Query(min_length=1)]) -> dict[str, Any]:
    """Only what a share dialog needs: id, name, email of an active user."""
    with db.connect() as conn:
        row = conn.execute(
            text("SELECT id, name, email FROM users WHERE email = :email AND active = :yes"),
            {"email": email, "yes": True},
        ).first()
    return {"user": None if row is None else {"id": str(row.id), "name": row.name, "email": row.email}}


_SEARCH = text(
    "SELECT id, name, email FROM users WHERE active = :yes"
    " AND (lower(name) LIKE :pattern ESCAPE '\\' OR lower(email) LIKE :pattern ESCAPE '\\')"
    " ORDER BY name, email LIMIT 20"
)


@router.get("/users/search", tags=["Users"])
def search_users(_user: CurrentUser, db: Db, q: Annotated[str, Query(min_length=1, max_length=100)]) -> dict[str, Any]:
    """The share dialog's picker: active users whose name or email contains `q` (any case), at most 20."""
    needle = q.strip().lower()
    if not needle:
        return {"users": []}
    # LIKE wildcards in the input match literally.
    pattern = "%" + re.sub(r"([\\%_])", r"\\\1", needle) + "%"
    with db.connect() as conn:
        rows = conn.execute(_SEARCH, {"yes": True, "pattern": pattern}).all()
    return {"users": [{"id": str(r.id), "name": r.name, "email": r.email} for r in rows]}
