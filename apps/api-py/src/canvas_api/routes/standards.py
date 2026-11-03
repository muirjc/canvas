"""Standards: the active one and every version of a diagram type, drafts, clone, publish and retire
(phase 5, canvas-1bty.9; apps/api/src/standards/*.ts).

Published and retired standards are never edited; a change is a clone into a new draft that is then
published (retiring the one in force). Publishing or retiring re-checks every diagram of the type
afterwards, in the background, refreshing only their cached violations, never their DSL.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, BackgroundTasks, Body, Depends, Request
from sqlalchemy import Connection, Engine, text

from canvas_api.auth.roles import AdminUser, CurrentUser
from canvas_api.db import get_engine
from canvas_api.diagram_core import DiagramCore
from canvas_api.errors import ApiError
from canvas_api.standards import (
    active_standard_record,
    create_draft_standard,
    get_standard_row,
    publish_standard,
    revalidate_type_diagrams,
    set_standard_shapes,
    standard_json_columns,
    standard_record,
    standards_for_type,
)
from canvas_api.standards_schema import parse_standard_body

router = APIRouter(tags=["Standards"])
Db = Annotated[Engine, Depends(get_engine)]
log = logging.getLogger(__name__)


def _diagram_core(request: Request) -> DiagramCore:
    diagram_core: DiagramCore = request.app.state.diagram_core
    return diagram_core


def _family_of(conn: Connection, diagram_type_id: str) -> str:
    row = conn.execute(text("SELECT dsl_family FROM diagram_types WHERE id = :id"), {"id": diagram_type_id}).first()
    if row is None:
        raise ApiError(404, f"Unknown diagram type: {diagram_type_id}")
    return str(row.dsl_family)


def _checked_rules(core: DiagramCore, body: Any, family: str) -> tuple[dict[str, Any], set[str], Any]:
    """(rules, fields the body gave, the parsed body), or 400 with the issues: structural first, then
    diagram-core's definition check for the family."""
    parsed, rules, issues = parse_standard_body(body)
    if not issues:
        issues = core.check_standard(rules, family)
    if issues or parsed is None:
        raise ApiError(400, "Invalid standard definition", issues=issues)
    return rules, parsed.model_fields_set, parsed


def _row_or_404(conn: Connection, standard_id: str) -> Any:
    row = get_standard_row(conn, standard_id)
    if row is None:
        raise ApiError(404, f"No standard with id {standard_id}")
    return row


def revalidate_diagrams_for_type(engine: Engine, core: DiagramCore, diagram_type_id: str) -> int:
    """Re-checks every diagram of a type against its standard in force (canvas_api/standards.py). Runs after the
    response; a failure is logged, and each diagram's next save refreshes its result anyway."""
    try:
        with engine.begin() as conn:
            return revalidate_type_diagrams(conn, core, diagram_type_id)
    except Exception as exc:
        # The error's type only: driver errors can carry query detail.
        log.warning("Background standards revalidation failed: %s (%s)", type(exc).__name__, diagram_type_id)
        return 0


# --- routes -------------------------------------------------------------------------------------------


@router.get("/diagram-types/{id}/standard")
def active(id: str, _user: CurrentUser, db: Db) -> dict[str, Any]:
    with db.connect() as conn:
        standard = active_standard_record(conn, id)
    if standard is None:
        raise ApiError(404, f"No published standard for diagram type {id}")
    return {"standard": standard}


@router.get("/diagram-types/{id}/standards")
def every_version(id: str, _user: CurrentUser, db: Db) -> dict[str, Any]:
    """Newest version first."""
    with db.connect() as conn:
        return {"standards": standards_for_type(conn, id)}


@router.post("/diagram-types/{id}/standards", status_code=201)
def create(id: str, request: Request, _admin: AdminUser, db: Db, body: Annotated[Any, Body()] = None) -> dict[str, Any]:
    core = _diagram_core(request)
    with db.begin() as conn:
        family = _family_of(conn, id)
        rules, _given, parsed = _checked_rules(core, body, family)
        return {"standard": create_draft_standard(conn, id, rules, parsed.name, parsed.description)}


@router.put("/standards/{id}")
def update(id: str, request: Request, _admin: AdminUser, db: Db, body: Annotated[Any, Body()] = None) -> dict[str, Any]:
    """Edits a draft in place; published and retired standards are immutable (clone instead)."""
    core = _diagram_core(request)
    with db.begin() as conn:
        existing = _row_or_404(conn, id)
        family = _family_of(conn, existing.diagram_type_id)
        rules, given, parsed = _checked_rules(core, body, family)
        if existing.status != "draft":
            raise ApiError(409, f'Standard {id} is "{existing.status}", only "draft" standards can be edited')
        conn.execute(
            text(
                "UPDATE standards SET allowed_icon_library_refs = :refs, color_palette = :palette,"
                " font_constraints = :font, kind_rules = :kinds WHERE id = :id"
            ),
            {"id": id, **standard_json_columns(rules)},
        )
        if parsed.name is not None:
            conn.execute(text("UPDATE standards SET name = :name WHERE id = :id"), {"name": parsed.name, "id": id})
        if "description" in given:
            conn.execute(
                text("UPDATE standards SET description = :d WHERE id = :id"), {"d": parsed.description, "id": id}
            )
        set_standard_shapes(conn, id, rules.get("allowedShapeIds", []), rules.get("mandatoryShapeIds", []))
        return {"standard": standard_record(conn, get_standard_row(conn, id))}


@router.post("/standards/{id}/clone", status_code=201)
def clone(id: str, _admin: AdminUser, db: Db) -> dict[str, Any]:
    """Copies any version into a new draft: the safe way to change a published standard."""
    with db.begin() as conn:
        source = standard_record(conn, _row_or_404(conn, id))
        return {
            "standard": create_draft_standard(
                conn,
                source["diagramTypeId"],
                source["rules"],
                f"{source['name'] if source['name'] is not None else source['diagramTypeId']} (copy)",
                source["description"],
            )
        }


@router.post("/standards/{id}/publish")
def publish(id: str, request: Request, background: BackgroundTasks, _admin: AdminUser, db: Db) -> dict[str, Any]:
    """Publishes a draft, retiring whatever was in force for its diagram type."""
    core = _diagram_core(request)
    with db.begin() as conn:
        row = _row_or_404(conn, id)
        if row.status != "draft":
            raise ApiError(409, f'Standard {id} is "{row.status}", only "draft" standards can be published')
        standard = publish_standard(conn, id, row.diagram_type_id)
    # Existing diagrams are re-evaluated against it, never silently modified.
    background.add_task(revalidate_diagrams_for_type, db, core, standard["diagramTypeId"])
    return {"standard": standard}


@router.post("/standards/{id}/retire")
def retire(id: str, request: Request, background: BackgroundTasks, _admin: AdminUser, db: Db) -> dict[str, Any]:
    """Retiring removes the rules in force, so cached violations are refreshed too."""
    core = _diagram_core(request)
    with db.begin() as conn:
        _row_or_404(conn, id)
        conn.execute(
            text(
                "UPDATE standards SET status = 'retired', retired_at = COALESCE(retired_at, CURRENT_TIMESTAMP)"
                " WHERE id = :id"
            ),
            {"id": id},
        )
        standard = standard_record(conn, get_standard_row(conn, id))
    background.add_task(revalidate_diagrams_for_type, db, core, standard["diagramTypeId"])
    return {"standard": standard}
