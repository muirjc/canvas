"""Diagrams: create, read, save, rename, describe, move, versions, presence, delete and restore, import
and template import (phase 4, canvas-1bty.8; apps/api/src/diagrams/*.ts).

Parsing, validation, a new diagram's starting DSL and template compiling go through the diagram-core
bridge. Saves are compare-and-set: a save names the version it started from and loses (409, nothing
written) if another save replaced it first.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from typing import Annotated, Any
from uuid import uuid4

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, Field, StrictBool, StrictStr
from sqlalchemy import Connection, Engine, text

from canvas_api.access import (
    access_at_least,
    project_exists,
    require_diagram_access,
    require_project_access,
    resolve_diagram_access,
    resolve_project_access,
)
from canvas_api.auth.roles import AdminUser, CurrentUser
from canvas_api.auth.session import SessionUser
from canvas_api.catalog import DSL_FAMILIES
from canvas_api.db import get_engine
from canvas_api.diagram_core import DiagramBridge
from canvas_api.errors import ApiError
from canvas_api.standards import get_active_standard
from canvas_api.timestamps import now_utc, parse_instant, to_api, to_api_ms, to_db

router = APIRouter(tags=["Diagrams"])
Db = Annotated[Engine, Depends(get_engine)]

DIAGRAM_RETENTION_DAYS = 30
DEFAULT_VERSION_LIMIT = 5
DEFAULT_DELETED_DIAGRAMS_LIMIT = 20
HEARTBEAT_SECONDS = 30
EXPIRY_SECONDS = 90
#: Each family's generic type, for an import whose header names no registered type (import.service.ts).
FAMILY_DEFAULT_TYPE = {
    "flowchart": "flowchart",
    "c4": "c4-context",
    "sequence": "sequence",
    "erd": "erd",
    "uml": "uml",
    "architecture": "cloud-infrastructure",
}
_VERSION_NUMBER = re.compile(r"^(?:v|#)?\s*(\d+)$", re.IGNORECASE)
_DATE_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$")
_PARSE_INT = re.compile(r"^\s*([+-]?\d+)")


# --- request bodies -----------------------------------------------------------------------------------


class NewDiagram(BaseModel):
    name: StrictStr = Field(min_length=1)
    diagramTypeId: StrictStr = Field(min_length=1)
    initialDslContent: StrictStr | None = None
    #: Create with AI: unsaved and hidden until the creator saves it.
    draft: StrictBool | None = None


class SaveBody(BaseModel):
    dslContent: StrictStr
    #: The version the editor started from; 409 if another save has replaced it since.
    baseVersionId: StrictStr = Field(min_length=1)


class NameBody(BaseModel):
    name: StrictStr = Field(min_length=1, pattern=r"\S")


class DescriptionBody(BaseModel):
    #: An empty string clears it.
    description: StrictStr


class MoveBody(BaseModel):
    projectId: StrictStr = Field(min_length=1)


class RestoreVersionBody(BaseModel):
    baseVersionId: StrictStr = Field(min_length=1)


class PresenceBody(BaseModel):
    sessionId: StrictStr = Field(min_length=1, max_length=100)


class ImportBody(BaseModel):
    name: StrictStr = Field(min_length=1)
    dslContent: StrictStr = Field(min_length=1)
    diagramTypeHint: StrictStr | None = None
    draft: StrictBool | None = None


class ImportTemplateBody(BaseModel):
    name: StrictStr = Field(min_length=1)
    diagramTypeId: StrictStr = Field(min_length=1)
    templateContent: StrictStr = Field(min_length=1)
    draft: StrictBool | None = None


# --- diagram-core -------------------------------------------------------------------------------------


def _bridge(request: Request) -> DiagramBridge:
    bridge: DiagramBridge | None = request.app.state.diagram_bridge
    if bridge is None:
        raise ApiError(503, "The diagram-core bridge is not configured (DIAGRAM_BRIDGE_URL).")
    return bridge


def _family_of(conn: Connection, diagram_type_id: str) -> str:
    row = conn.execute(text("SELECT dsl_family FROM diagram_types WHERE id = :id"), {"id": diagram_type_id}).first()
    if row is None:
        raise ApiError(400, f"Unknown diagram type: {diagram_type_id}")
    if row.dsl_family not in DSL_FAMILIES:
        raise ApiError(400, f"No DSL family registered for: {row.dsl_family}")
    return str(row.dsl_family)


def _parse_or_fail(bridge: DiagramBridge, family: str, dsl: str) -> dict[str, Any]:
    result = bridge.parse(family, dsl)
    if "model" not in result:
        raise ApiError(422, "DSL could not be parsed", details=result.get("errors", []))
    model: dict[str, Any] = result["model"]
    return model


def _validation(
    conn: Connection, bridge: DiagramBridge, diagram_type_id: str, model: dict[str, Any]
) -> tuple[list[Any], int | None]:
    """Soft-flag only: a save is never blocked on the result."""
    standard = get_active_standard(conn, diagram_type_id)
    if standard is None:
        return [], None
    return bridge.validate(model, standard.rules), standard.version


# --- records ------------------------------------------------------------------------------------------

_GET_DIAGRAM = text(
    "SELECT d.id, d.name, d.description, d.diagram_type_id, dt.dsl_family, d.project_id, d.owner_id,"
    " u.name AS owner_name, d.last_validation_result, d.standard_version_at_last_check, d.current_version_id,"
    " d.created_at, d.updated_at, d.draft, v.dsl_content"
    " FROM diagrams d JOIN diagram_versions v ON v.id = d.current_version_id"
    " JOIN diagram_types dt ON dt.id = d.diagram_type_id LEFT JOIN users u ON u.id = d.owner_id"
    " WHERE d.id = :id AND d.deleted_at IS NULL"
)


def _json_column(value: Any) -> Any:
    return json.loads(value) if isinstance(value, str) else value


def get_diagram(conn: Connection, diagram_id: str) -> dict[str, Any]:
    row = conn.execute(_GET_DIAGRAM, {"id": diagram_id}).first()
    if row is None:
        raise ApiError(404, f"No diagram with id {diagram_id}")
    return {
        "id": str(row.id),
        "name": row.name,
        "description": row.description,
        "diagramTypeId": row.diagram_type_id,
        "dslFamily": row.dsl_family,
        "projectId": str(row.project_id),
        "ownerId": str(row.owner_id),
        "ownerName": row.owner_name if row.owner_name is not None else "(unknown)",
        "dslContent": row.dsl_content,
        "lastValidationResult": _json_column(row.last_validation_result),
        "standardVersionAtLastCheck": row.standard_version_at_last_check,
        "currentVersionId": str(row.current_version_id),
        "createdAt": to_api(row.created_at),
        "updatedAt": to_api(row.updated_at),
        "draft": bool(row.draft),
    }


def _record_version(
    conn: Connection, diagram_id: str, dsl: str, author_id: str, restored_from: str | None = None
) -> str:
    """Appends an immutable version (history is never rewritten; restoring adds a new one)."""
    next_seq = (
        int(
            conn.execute(
                text("SELECT COALESCE(MAX(sequence_number), 0) FROM diagram_versions WHERE diagram_id = :id"),
                {"id": diagram_id},
            ).scalar_one()
        )
        + 1
    )
    version_id = str(uuid4())
    conn.execute(
        text(
            "INSERT INTO diagram_versions (id, diagram_id, sequence_number, dsl_content, author_id,"
            " restored_from_version_id) VALUES (:vid, :id, :seq, :dsl, :author, :restored)"
        ),
        {
            "vid": version_id,
            "id": diagram_id,
            "seq": next_seq,
            "dsl": dsl,
            "author": author_id,
            "restored": restored_from,
        },
    )
    return version_id


def create_diagram(
    conn: Connection,
    bridge: DiagramBridge,
    *,
    name: str,
    diagram_type_id: str,
    project_id: str,
    owner_id: str,
    initial_dsl: str | None,
    draft: bool | None,
) -> dict[str, Any]:
    """A new diagram with its first version. Without initial DSL it starts as the family's empty diagram
    (never a hard-coded flowchart, which wouldn't parse for the other families)."""
    family = _family_of(conn, diagram_type_id)
    dsl = initial_dsl if initial_dsl is not None else bridge.empty_dsl(family, diagram_type_id)
    model = _parse_or_fail(bridge, family, dsl)
    violations, standard_version = _validation(conn, bridge, diagram_type_id, model)
    diagram_id = str(uuid4())
    conn.execute(
        text(
            "INSERT INTO diagrams (id, name, diagram_type_id, project_id, owner_id, last_validation_result,"
            " standard_version_at_last_check, draft) VALUES (:id, :name, :type, :project, :owner, :violations,"
            " :standard, :draft)"
        ),
        {
            "id": diagram_id,
            "name": name,
            "type": diagram_type_id,
            "project": project_id,
            "owner": owner_id,
            "violations": json.dumps(violations, separators=(",", ":"), ensure_ascii=False),
            "standard": standard_version,
            "draft": bool(draft),
        },
    )
    version_id = _record_version(conn, diagram_id, dsl, owner_id)
    conn.execute(
        text("UPDATE diagrams SET current_version_id = :v WHERE id = :id"), {"v": version_id, "id": diagram_id}
    )
    return get_diagram(conn, diagram_id)


def _save(
    conn: Connection,
    bridge: DiagramBridge,
    diagram_id: str,
    *,
    dsl: str,
    author_id: str,
    base_version_id: str,
    restored_from: str | None = None,
) -> dict[str, Any]:
    """Saves a new version, compare-and-set on the base version. Never blocked by standards."""
    existing = get_diagram(conn, diagram_id)
    family = _family_of(conn, existing["diagramTypeId"])
    model = _parse_or_fail(bridge, family, dsl)
    violations, standard_version = _validation(conn, bridge, existing["diagramTypeId"], model)
    version_id = _record_version(conn, diagram_id, dsl, author_id, restored_from)
    updated = conn.execute(
        text(
            "UPDATE diagrams SET current_version_id = :v, updated_at = :at, last_validation_result = :violations,"
            " standard_version_at_last_check = :standard, draft = :no WHERE id = :id AND current_version_id = :base"
        ),
        {
            "v": version_id,
            "at": to_db(now_utc(), conn.dialect.name),
            "violations": json.dumps(violations, separators=(",", ":"), ensure_ascii=False),
            "standard": standard_version,
            "no": False,
            "id": diagram_id,
            "base": base_version_id,
        },
    )
    if updated.rowcount == 0:
        # Someone else's save got there first; raising rolls back the version inserted above.
        current = conn.execute(
            text(
                "SELECT v.id, v.author_id, v.created_at, u.name, u.email FROM diagrams d"
                " JOIN diagram_versions v ON v.id = d.current_version_id LEFT JOIN users u ON u.id = v.author_id"
                " WHERE d.id = :id"
            ),
            {"id": diagram_id},
        ).one()
        saved_by = current.name or current.email or "Someone"
        raise ApiError(
            409,
            f"{saved_by} saved a newer version of this diagram while you were editing.",
            code="version_conflict",
            details={
                "currentVersionId": str(current.id),
                "savedBy": {"id": None if current.author_id is None else str(current.author_id), "name": saved_by},
                "savedAt": to_api_ms(current.created_at),
            },
        )
    return get_diagram(conn, diagram_id)


def _live_diagram_or_404(conn: Connection, diagram_id: str) -> None:
    if (
        conn.execute(text("SELECT id FROM diagrams WHERE id = :id AND deleted_at IS NULL"), {"id": diagram_id}).first()
        is None
    ):
        raise ApiError(404, f"No diagram with id {diagram_id}")


# --- routes: create, search, read, save -----------------------------------------------------------------


@router.post("/projects/{projectId}/diagrams", status_code=201)
def create(projectId: str, request: Request, user: CurrentUser, db: Db, body: NewDiagram) -> dict[str, Any]:
    bridge = _bridge(request)
    with db.begin() as conn:
        require_project_access(conn, user.id, projectId, "edit")
        diagram = create_diagram(
            conn,
            bridge,
            name=body.name,
            diagram_type_id=body.diagramTypeId,
            project_id=projectId,
            owner_id=user.id,
            initial_dsl=body.initialDslContent,
            draft=body.draft,
        )
    return {"diagram": diagram}


_SEARCH = {
    "postgresql": text(
        "SELECT id, name, diagram_type_id, project_id, updated_at FROM diagrams"
        " WHERE project_id = :project AND deleted_at IS NULL AND draft = :no"
        " AND (CAST(:pattern AS TEXT) IS NULL OR name ILIKE CAST(:pattern AS TEXT))"
        " AND (CAST(:type AS TEXT) IS NULL OR diagram_type_id = CAST(:type AS TEXT))"
        " ORDER BY updated_at DESC"
    ),
    "sqlite": text(
        "SELECT id, name, diagram_type_id, project_id, updated_at FROM diagrams"
        " WHERE project_id = :project AND deleted_at IS NULL AND draft = :no"
        " AND (:pattern IS NULL OR name LIKE :pattern) AND (:type IS NULL OR diagram_type_id = :type)"
        " ORDER BY updated_at DESC"
    ),
}


@router.get("/projects/{projectId}/diagrams")
def search(
    projectId: str,
    user: CurrentUser,
    db: Db,
    query: str | None = None,
    type: str | None = None,
) -> dict[str, Any]:
    """The project's own diagrams by name and type, most recently changed first."""
    with db.connect() as conn:
        require_project_access(conn, user.id, projectId, "view")
        rows = conn.execute(
            _SEARCH[conn.dialect.name],
            {"project": projectId, "no": False, "pattern": f"%{query}%" if query else None, "type": type or None},
        ).all()
    return {
        "diagrams": [
            {
                "id": str(r.id),
                "name": r.name,
                "diagramTypeId": r.diagram_type_id,
                "projectId": str(r.project_id),
                "updatedAt": to_api(r.updated_at),
            }
            for r in rows
        ]
    }


@router.get("/diagrams/{id}")
def read(id: str, user: CurrentUser, db: Db) -> dict[str, Any]:
    """With the caller's own access level, so the editor knows whether they may comment or edit."""
    with db.connect() as conn:
        require_diagram_access(conn, user.id, id, "view")
        diagram = get_diagram(conn, id)
        return {"diagram": {**diagram, "accessLevel": resolve_diagram_access(conn, user.id, id)}}


@router.patch("/diagrams/{id}")
def save(id: str, request: Request, user: CurrentUser, db: Db, body: SaveBody) -> dict[str, Any]:
    bridge = _bridge(request)
    with db.begin() as conn:
        require_diagram_access(conn, user.id, id, "edit")
        return {
            "diagram": _save(
                conn, bridge, id, dsl=body.dslContent, author_id=user.id, base_version_id=body.baseVersionId
            )
        }


@router.patch("/diagrams/{id}/name")
def rename(id: str, user: CurrentUser, db: Db, body: NameBody) -> dict[str, Any]:
    """Edit access is enough: the name is just another editable field (no new version)."""
    with db.begin() as conn:
        require_diagram_access(conn, user.id, id, "edit")
        _live_diagram_or_404(conn, id)
        conn.execute(text("UPDATE diagrams SET name = :name WHERE id = :id"), {"name": body.name, "id": id})
        return {"diagram": get_diagram(conn, id)}


@router.patch("/diagrams/{id}/description")
def describe(id: str, user: CurrentUser, db: Db, body: DescriptionBody) -> dict[str, Any]:
    with db.begin() as conn:
        require_diagram_access(conn, user.id, id, "edit")
        _live_diagram_or_404(conn, id)
        conn.execute(
            text("UPDATE diagrams SET description = :d WHERE id = :id"), {"d": body.description or None, "id": id}
        )
        return {"diagram": get_diagram(conn, id)}


@router.patch("/diagrams/{id}/project")
def move(id: str, user: CurrentUser, db: Db, body: MoveBody) -> dict[str, Any]:
    """Edit access to the diagram (the route's guard) and to the destination project."""
    destination = body.projectId
    with db.begin() as conn:
        require_diagram_access(conn, user.id, id, "edit")
        if not project_exists(conn, destination):
            raise ApiError(404, f"No project with id {destination}")
        level = resolve_project_access(conn, user.id, destination)
        if not access_at_least(level, "edit"):
            raise ApiError(
                403,
                f'This action requires "edit" access, but you only have "{level}" access to the destination project.'
                if level
                else "You do not have access to the destination project.",
            )
        _live_diagram_or_404(conn, id)
        conn.execute(text("UPDATE diagrams SET project_id = :p WHERE id = :id"), {"p": destination, "id": id})
        return {"diagram": get_diagram(conn, id)}


# --- versions -----------------------------------------------------------------------------------------

_LIST_VERSIONS = {
    "postgresql": text(
        "SELECT v.id, v.sequence_number, v.author_id, v.created_at, u.name AS author_name, u.email AS author_email,"
        " src.sequence_number AS restored_from_sequence"
        " FROM diagram_versions v JOIN users u ON u.id = v.author_id"
        " LEFT JOIN diagram_versions src ON src.id = v.restored_from_version_id"
        " WHERE v.diagram_id = :id"
        " AND (CAST(:seq AS INTEGER) IS NULL OR v.sequence_number = CAST(:seq AS INTEGER))"
        " AND (CAST(:pattern AS TEXT) IS NULL OR u.name ILIKE CAST(:pattern AS TEXT)"
        " OR u.email ILIKE CAST(:pattern AS TEXT))"
        " AND (CAST(:from AS TIMESTAMPTZ) IS NULL OR v.created_at >= CAST(:from AS TIMESTAMPTZ))"
        " AND (CAST(:to AS TIMESTAMPTZ) IS NULL OR v.created_at < CAST(:to AS TIMESTAMPTZ))"
        " ORDER BY v.sequence_number DESC LIMIT :limit"
    ),
    "sqlite": text(
        "SELECT v.id, v.sequence_number, v.author_id, v.created_at, u.name AS author_name, u.email AS author_email,"
        " src.sequence_number AS restored_from_sequence"
        " FROM diagram_versions v JOIN users u ON u.id = v.author_id"
        " LEFT JOIN diagram_versions src ON src.id = v.restored_from_version_id"
        " WHERE v.diagram_id = :id"
        " AND (:seq IS NULL OR v.sequence_number = :seq)"
        " AND (:pattern IS NULL OR u.name LIKE :pattern OR u.email LIKE :pattern)"
        " AND (:from IS NULL OR datetime(v.created_at) >= datetime(:from))"
        " AND (:to IS NULL OR datetime(v.created_at) < datetime(:to))"
        " ORDER BY v.sequence_number DESC LIMIT :limit"
    ),
}
_GET_VERSION = text(
    "SELECT v.id, v.sequence_number, v.author_id, v.created_at, u.name AS author_name, u.email AS author_email,"
    " src.sequence_number AS restored_from_sequence, v.dsl_content"
    " FROM diagram_versions v JOIN users u ON u.id = v.author_id"
    " LEFT JOIN diagram_versions src ON src.id = v.restored_from_version_id"
    " WHERE v.diagram_id = :id AND v.id = :vid"
)


def _version_summary(r: Any) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "sequenceNumber": int(r.sequence_number),
        "authorId": str(r.author_id),
        "authorName": r.author_name or r.author_email,
        "createdAt": to_api(r.created_at),
        "restoredFromSequence": None if r.restored_from_sequence is None else int(r.restored_from_sequence),
    }


def _parse_int(value: str | None) -> int | None:
    """JavaScript's Number.parseInt: leading digits, else nothing."""
    match = _PARSE_INT.match(value or "")
    return int(match.group(1)) if match else None


def _instant(value: str | None, name: str) -> datetime | None:
    if value is None:
        return None
    if not _DATE_TIME.match(value):
        raise ApiError(400, f'querystring/{name} must match format "date-time"')
    return parse_instant(value)


@router.get("/diagrams/{id}/versions")
def list_versions(
    id: str,
    user: CurrentUser,
    db: Db,
    limit: str | None = None,
    q: str | None = None,
    from_: Annotated[str | None, Query(alias="from")] = None,
    to: str | None = None,
) -> dict[str, Any]:
    """Newest first, DEFAULT_VERSION_LIMIT by default. A version number ("3", "v3", "#3") finds exactly
    that version; other text matches the author's name or email; from/to are instants."""
    start, end = _instant(from_, "from"), _instant(to, "to")
    parsed = _parse_int(limit)
    size = max(1, parsed if parsed is not None else DEFAULT_VERSION_LIMIT)
    search_text = (q or "").strip()
    number = _VERSION_NUMBER.match(search_text) if search_text else None
    with db.connect() as conn:
        require_diagram_access(conn, user.id, id, "view")
        dialect = conn.dialect.name
        rows = conn.execute(
            _LIST_VERSIONS[dialect],
            {
                "id": id,
                "seq": int(number.group(1)) if number else None,
                "pattern": f"%{search_text}%" if search_text and not number else None,
                "from": None if start is None else to_db(start, dialect),
                "to": None if end is None else to_db(end, dialect),
                "limit": size + 1,
            },
        ).all()
    return {"versions": [_version_summary(r) for r in rows[:size]], "hasMore": len(rows) > size}


@router.get("/diagrams/{id}/versions/{versionId}")
def read_version(id: str, versionId: str, user: CurrentUser, db: Db) -> dict[str, Any]:
    """One version with its content, for History's read-only preview."""
    with db.connect() as conn:
        require_diagram_access(conn, user.id, id, "view")
        row = conn.execute(_GET_VERSION, {"id": id, "vid": versionId}).first()
    if row is None:
        raise ApiError(404, f"No version {versionId} for diagram {id}")
    return {"version": {**_version_summary(row), "dslContent": row.dsl_content}}


@router.post("/diagrams/{id}/versions/{versionId}/restore")
def restore_version(
    id: str,
    versionId: str,
    request: Request,
    user: CurrentUser,
    db: Db,
    body: RestoreVersionBody,
) -> dict[str, Any]:
    """Restoring saves the old content as a new version (a conflict like any other save)."""
    bridge = _bridge(request)
    with db.begin() as conn:
        require_diagram_access(conn, user.id, id, "edit")
        row = conn.execute(
            text("SELECT dsl_content FROM diagram_versions WHERE id = :vid AND diagram_id = :id"),
            {"vid": versionId, "id": id},
        ).first()
        if row is None:
            raise ApiError(404, f"No version {versionId} for diagram {id}")
        diagram = _save(
            conn,
            bridge,
            id,
            dsl=row.dsl_content,
            author_id=user.id,
            base_version_id=body.baseVersionId,
            restored_from=versionId,
        )
    return {"diagram": diagram}


# --- presence -----------------------------------------------------------------------------------------


@router.put("/diagrams/{id}/presence")
def heartbeat(id: str, user: CurrentUser, db: Db, body: PresenceBody) -> dict[str, Any]:
    """This tab's heartbeat, answered with everyone else who has the diagram open: other people first,
    then the caller's own other tabs. Advisory only; stale saves are stopped by the base version."""
    now = now_utc()
    with db.begin() as conn:
        require_diagram_access(conn, user.id, id, "edit")
        dialect = conn.dialect.name
        conn.execute(
            text("DELETE FROM diagram_edit_sessions WHERE diagram_id = :id AND last_seen_at < :cutoff"),
            {"id": id, "cutoff": to_db(now - timedelta(seconds=EXPIRY_SECONDS), dialect)},
        )
        conn.execute(
            text(
                "INSERT INTO diagram_edit_sessions (diagram_id, user_id, session_id, started_at, last_seen_at)"
                " VALUES (:id, :uid, :sid, :now, :now)"
                " ON CONFLICT (diagram_id, user_id, session_id) DO UPDATE SET last_seen_at = :now"
            ),
            {"id": id, "uid": user.id, "sid": body.sessionId, "now": to_db(now, dialect)},
        )
        rows = conn.execute(
            text(
                "SELECT s.user_id, s.session_id, s.started_at, u.name, u.email FROM diagram_edit_sessions s"
                " JOIN users u ON u.id = s.user_id WHERE s.diagram_id = :id"
            ),
            {"id": id},
        ).all()
    # One entry per person (earliest open tab). A session id is "<tab>.<mount>": the caller's own tab,
    # in any mount, isn't someone else.
    my_tab = body.sessionId.split(".")[0]
    others: dict[str, dict[str, Any]] = {}
    for r in rows:
        user_id = str(r.user_id)
        if user_id == user.id and str(r.session_id).split(".")[0] == my_tab:
            continue
        is_you = user_id == user.id
        since = to_api_ms(r.started_at)
        existing = others.get(user_id)
        if existing is None or since < existing["since"]:
            others[user_id] = {
                "userId": user_id,
                "name": "You" if is_you else (r.name if r.name is not None else r.email),
                "since": since,
                "isYou": is_you,
            }
    ordered = sorted(others.values(), key=lambda o: (o["isYou"], o["since"]))
    return {"others": ordered, "heartbeatSeconds": HEARTBEAT_SECONDS}


@router.post("/diagrams/{id}/presence/leave", status_code=204)
def leave(id: str, user: CurrentUser, db: Db, body: PresenceBody) -> Response:
    """This tab closed the editor. Best effort: a tab that never says goodbye expires."""
    with db.begin() as conn:
        require_diagram_access(conn, user.id, id, "edit")
        conn.execute(
            text("DELETE FROM diagram_edit_sessions WHERE diagram_id = :id AND user_id = :uid AND session_id = :sid"),
            {"id": id, "uid": user.id, "sid": body.sessionId},
        )
    return Response(status_code=204)


# --- delete and restore -------------------------------------------------------------------------------

#: A draft was never saved, so discarding it leaves nothing behind: its dependents first (versions
#: cascade with the diagram; share grants have no foreign key).
_PURGE_DIAGRAM = (
    text("DELETE FROM chat_messages WHERE diagram_chat_id IN (SELECT id FROM diagram_chats WHERE diagram_id = :id)"),
    text("DELETE FROM diagram_chats WHERE diagram_id = :id"),
    text("DELETE FROM share_grants WHERE subject_type = 'diagram' AND subject_id = :id"),
    text("DELETE FROM diagram_comment_reads WHERE diagram_id = :id"),
    text("DELETE FROM diagram_comments WHERE diagram_id = :id AND thread_root_id IS NOT NULL"),
    text("DELETE FROM diagram_comments WHERE diagram_id = :id"),
    text("DELETE FROM diagrams WHERE id = :id"),
)


def _require_owner_or_admin(conn: Connection, user: SessionUser, diagram_id: str) -> None:
    """Deleting is the owner's or an admin's, never an edit share's. Someone else's draft isn't there."""
    row = conn.execute(text("SELECT owner_id, draft FROM diagrams WHERE id = :id"), {"id": diagram_id}).first()
    if row is None:
        return
    if bool(row.draft) and str(row.owner_id) != user.id:
        raise ApiError(404, "Diagram not found")
    if str(row.owner_id) != user.id and user.role != "admin":
        raise ApiError(403, "Only this diagram's owner or an admin can delete it.")


@router.delete("/diagrams/{id}", status_code=204)
def delete(id: str, user: CurrentUser, db: Db) -> Response:
    """Soft delete (idempotent); a draft is removed outright."""
    with db.begin() as conn:
        _require_owner_or_admin(conn, user, id)
        row = conn.execute(text("SELECT draft FROM diagrams WHERE id = :id"), {"id": id}).first()
        if row is None:
            raise ApiError(404, f"No diagram with id {id}")
        if bool(row.draft):
            conn.execute(text("UPDATE diagrams SET current_version_id = NULL WHERE id = :id"), {"id": id})
            for statement in _PURGE_DIAGRAM:
                conn.execute(statement, {"id": id})
        else:
            conn.execute(
                text(
                    "UPDATE diagrams SET deleted_at = COALESCE(deleted_at, :at),"
                    " deleted_by_user_id = COALESCE(deleted_by_user_id, :by) WHERE id = :id"
                ),
                {"at": to_db(now_utc(), conn.dialect.name), "by": user.id, "id": id},
            )
    return Response(status_code=204)


_LIST_DELETED = {
    "postgresql": text(
        "SELECT d.id, d.name, d.owner_id, u.name AS owner_name, d.project_id, p.name AS project_name, d.deleted_at"
        " FROM diagrams d LEFT JOIN users u ON u.id = d.owner_id LEFT JOIN projects p ON p.id = d.project_id"
        " WHERE d.deleted_at IS NOT NULL AND d.deleted_at > :boundary"
        " AND (CAST(:pattern AS TEXT) IS NULL OR d.name ILIKE CAST(:pattern AS TEXT)"
        " OR u.name ILIKE CAST(:pattern AS TEXT) OR p.name ILIKE CAST(:pattern AS TEXT))"
        " ORDER BY d.deleted_at DESC LIMIT :limit"
    ),
    "sqlite": text(
        "SELECT d.id, d.name, d.owner_id, u.name AS owner_name, d.project_id, p.name AS project_name, d.deleted_at"
        " FROM diagrams d LEFT JOIN users u ON u.id = d.owner_id LEFT JOIN projects p ON p.id = d.project_id"
        " WHERE d.deleted_at IS NOT NULL AND d.deleted_at > :boundary"
        " AND (:pattern IS NULL OR d.name LIKE :pattern OR u.name LIKE :pattern OR p.name LIKE :pattern)"
        " ORDER BY d.deleted_at DESC LIMIT :limit"
    ),
}


@router.get("/admin/deleted-diagrams")
def list_deleted(_admin: AdminUser, db: Db, limit: str | None = None, q: str | None = None) -> dict[str, Any]:
    """Soft-deleted diagrams still restorable, newest first; `q` matches diagram, owner or project name."""
    parsed = _parse_int(limit)
    size = max(1, parsed if parsed is not None else DEFAULT_DELETED_DIAGRAMS_LIMIT)
    search_text = (q or "").strip()
    with db.connect() as conn:
        dialect = conn.dialect.name
        rows = conn.execute(
            _LIST_DELETED[dialect],
            {
                "boundary": to_db(now_utc() - timedelta(days=DIAGRAM_RETENTION_DAYS), dialect),
                "pattern": f"%{search_text}%" if search_text else None,
                "limit": size + 1,
            },
        ).all()
    return {
        "diagrams": [
            {
                "id": str(r.id),
                "name": r.name,
                "ownerId": str(r.owner_id),
                "ownerName": r.owner_name if r.owner_name is not None else "(unknown)",
                "projectId": str(r.project_id),
                "projectName": r.project_name if r.project_name is not None else "(unknown)",
                "deletedAt": to_api(r.deleted_at),
            }
            for r in rows[:size]
        ],
        "hasMore": len(rows) > size,
    }


@router.post("/diagrams/{id}/restore")
def restore(id: str, admin: AdminUser, db: Db) -> dict[str, Any]:
    with db.begin() as conn:
        row = conn.execute(text("SELECT deleted_at FROM diagrams WHERE id = :id"), {"id": id}).first()
        if row is None or row.deleted_at is None:
            raise ApiError(404, f"No soft-deleted diagram with id {id}")
        if not parse_instant(row.deleted_at) > now_utc() - timedelta(days=DIAGRAM_RETENTION_DAYS):
            raise ApiError(409, "This diagram's recovery window has passed and it is no longer available.")
        conn.execute(
            text(
                "UPDATE diagrams SET deleted_at = NULL, deleted_by_user_id = NULL, restored_at = :at,"
                " restored_by_user_id = :by WHERE id = :id"
            ),
            {"at": to_db(now_utc(), conn.dialect.name), "by": admin.id, "id": id},
        )
        return {"diagram": get_diagram(conn, id)}


# --- import -------------------------------------------------------------------------------------------


@router.post("/projects/{projectId}/diagrams/import", status_code=201)
def import_dsl(projectId: str, request: Request, user: CurrentUser, db: Db, body: ImportBody) -> dict[str, Any]:
    """Raw Mermaid as a new diagram. The type comes from the hint, else the type the header names, else
    the family's generic type, else any type of the family."""
    bridge = _bridge(request)
    with db.begin() as conn:
        require_project_access(conn, user.id, projectId, "edit")
        family = bridge.detect(body.dslContent)
        if family is None:
            raise ApiError(
                422,
                "Could not recognize this text as any supported Mermaid diagram type (expected a header line"
                ' such as "flowchart TD", "C4Context", "sequenceDiagram", "erDiagram", "classDiagram",'
                ' or "architecture-beta").',
            )
        if body.diagramTypeHint:
            hinted = conn.execute(
                text("SELECT dsl_family FROM diagram_types WHERE id = :id"), {"id": body.diagramTypeHint}
            ).first()
            if hinted is None:
                raise ApiError(422, f"Unknown diagram type hint: {body.diagramTypeHint}")
            if hinted.dsl_family != family:
                raise ApiError(
                    422,
                    f'The provided diagram type "{body.diagramTypeHint}" uses the "{hinted.dsl_family}" DSL family,'
                    f' but this content looks like "{family}".',
                )
            type_id = body.diagramTypeHint
        else:
            type_id = _type_without_hint(conn, bridge, body.dslContent, family)
        diagram = create_diagram(
            conn,
            bridge,
            name=body.name,
            diagram_type_id=type_id,
            project_id=projectId,
            owner_id=user.id,
            initial_dsl=body.dslContent,
            draft=body.draft,
        )
    return {"diagram": diagram}


def _type_without_hint(conn: Connection, bridge: DiagramBridge, dsl: str, family: str) -> str:
    registered = [
        r.id
        for r in conn.execute(
            text("SELECT id FROM diagram_types WHERE dsl_family = :family ORDER BY id"), {"family": family}
        )
    ]
    if not registered:
        raise ApiError(422, f'No diagram type is registered for the "{family}" DSL family.')
    parsed = bridge.parse(family, dsl)
    # A parse failure is reported properly when the diagram is created; it just can't name a type here.
    from_header = (parsed.get("model") or {}).get("diagramTypeId")
    if from_header in registered:
        return str(from_header)
    default = FAMILY_DEFAULT_TYPE.get(family)
    if default in registered:
        return str(default)
    return str(registered[0])


@router.post("/projects/{projectId}/diagrams/import-template", status_code=201)
def import_template(
    projectId: str,
    request: Request,
    user: CurrentUser,
    db: Db,
    body: ImportTemplateBody,
) -> dict[str, Any]:
    """A filled-in Markdown intake template, compiled to DSL, as a new diagram of the given type."""
    bridge = _bridge(request)
    with db.begin() as conn:
        require_project_access(conn, user.id, projectId, "edit")
        compiled = bridge.compile_template(body.diagramTypeId, body.templateContent)
        if compiled.get("unsupported"):
            raise ApiError(422, f'No template importer is available for diagram type "{body.diagramTypeId}".')
        if "errors" in compiled:
            raise ApiError(422, "Template could not be compiled", details=compiled["errors"])
        diagram = create_diagram(
            conn,
            bridge,
            name=body.name,
            diagram_type_id=body.diagramTypeId,
            project_id=projectId,
            owner_id=user.id,
            initial_dsl=str(compiled["dsl"]),
            draft=body.draft,
        )
    return {"diagram": diagram}
