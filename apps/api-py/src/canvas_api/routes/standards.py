"""Standards: the active one and every version of a diagram type, drafts, clone, publish and retire
(phase 5, canvas-1bty.9; apps/api/src/standards/*.ts).

Published and retired standards are never edited; a change is a clone into a new draft that is then
published (retiring the one in force). Publishing or retiring re-checks every diagram of the type
afterwards, in the background, refreshing only their cached violations, never their DSL.
"""

from __future__ import annotations

import json
import logging
from typing import Annotated, Any
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Body, Depends, Request
from sqlalchemy import Connection, Engine, text

from canvas_api.auth.roles import AdminUser, CurrentUser
from canvas_api.catalog import DSL_FAMILIES
from canvas_api.db import get_engine
from canvas_api.diagram_core import DiagramBridge
from canvas_api.errors import ApiError
from canvas_api.standards import (
    active_standard_record,
    get_active_standard,
    get_standard_row,
    standard_record,
    standards_for_type,
)
from canvas_api.standards_schema import parse_standard_body

router = APIRouter(tags=["Standards"])
Db = Annotated[Engine, Depends(get_engine)]
log = logging.getLogger(__name__)

#: The v2 rule fields, stored together in standards.kind_rules (standard.service.ts V2_RULE_KEYS).
V2_RULE_KEYS = (
    "elementKinds",
    "kindGroups",
    "connectorRules",
    "connectorPolicy",
    "containers",
    "requireKnownKinds",
    "severityOverrides",
    "guidance",
    "authoring",
)


def _compact(value: Any) -> str:
    """JSON.stringify's output, so both services store the same text."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _bridge(request: Request) -> DiagramBridge:
    bridge: DiagramBridge | None = request.app.state.diagram_bridge
    if bridge is None:
        raise ApiError(503, "The diagram-core bridge is not configured (DIAGRAM_BRIDGE_URL).")
    return bridge


def _family_of(conn: Connection, diagram_type_id: str) -> str:
    row = conn.execute(text("SELECT dsl_family FROM diagram_types WHERE id = :id"), {"id": diagram_type_id}).first()
    if row is None:
        raise ApiError(404, f"Unknown diagram type: {diagram_type_id}")
    return str(row.dsl_family)


def _checked_rules(bridge: DiagramBridge, body: Any, family: str) -> tuple[dict[str, Any], set[str], Any]:
    """(rules, fields the body gave, the parsed body), or 400 with the issues: structural first, then
    diagram-core's definition check for the family."""
    parsed, rules, issues = parse_standard_body(body)
    if not issues:
        issues = bridge.check_standard(rules, family)
    if issues or parsed is None:
        raise ApiError(400, "Invalid standard definition", issues=issues)
    return rules, parsed.model_fields_set, parsed


def _set_shapes(conn: Connection, standard_id: str, allowed: list[str], mandatory: list[str]) -> None:
    conn.execute(text("DELETE FROM standard_allowed_shapes WHERE standard_id = :id"), {"id": standard_id})
    conn.execute(text("DELETE FROM standard_mandatory_shapes WHERE standard_id = :id"), {"id": standard_id})
    if allowed:
        conn.execute(
            text("INSERT INTO standard_allowed_shapes (standard_id, shape_id, position) VALUES (:id, :shape, :i)"),
            [{"id": standard_id, "shape": shape, "i": i} for i, shape in enumerate(allowed)],
        )
    if mandatory:
        conn.execute(
            text("INSERT INTO standard_mandatory_shapes (standard_id, shape_id, position) VALUES (:id, :shape, :i)"),
            [{"id": standard_id, "shape": shape, "i": i} for i, shape in enumerate(mandatory)],
        )


def _json_columns(rules: dict[str, Any]) -> dict[str, Any]:
    return {
        "refs": _compact(rules.get("allowedIconLibraryRefs", [])),
        "palette": _compact(rules.get("colorPalette", [])),
        "font": _compact(rules["fontConstraints"]) if rules.get("fontConstraints") else None,
        "kinds": _compact({key: rules[key] for key in V2_RULE_KEYS if key in rules}),
    }


def _create_draft(
    conn: Connection, diagram_type_id: str, rules: dict[str, Any], name: str | None, description: str | None
) -> dict[str, Any]:
    version = int(
        conn.execute(
            text("SELECT COALESCE(MAX(version), 0) + 1 FROM standards WHERE diagram_type_id = :type"),
            {"type": diagram_type_id},
        ).scalar_one()
    )
    standard_id = str(uuid4())
    conn.execute(
        text(
            "INSERT INTO standards (id, diagram_type_id, version, status, allowed_icon_library_refs, color_palette,"
            " font_constraints, name, description, kind_rules)"
            " VALUES (:id, :type, :version, 'draft', :refs, :palette, :font, :name, :description, :kinds)"
        ),
        {
            "id": standard_id,
            "type": diagram_type_id,
            "version": version,
            # Never nameless: the same fallback the migration used.
            "name": name if name is not None else f"{diagram_type_id} v{version}",
            "description": description,
            **_json_columns(rules),
        },
    )
    _set_shapes(conn, standard_id, rules.get("allowedShapeIds", []), rules.get("mandatoryShapeIds", []))
    return standard_record(conn, get_standard_row(conn, standard_id))


def _row_or_404(conn: Connection, standard_id: str) -> Any:
    row = get_standard_row(conn, standard_id)
    if row is None:
        raise ApiError(404, f"No standard with id {standard_id}")
    return row


def revalidate_diagrams_for_type(engine: Engine, bridge: DiagramBridge, diagram_type_id: str) -> int:
    """Re-checks every diagram of a type against its standard in force (none = no violations). Refreshes
    only the cached result, never the DSL. Runs after the response; a failure is logged, and each
    diagram's next save refreshes its result anyway."""
    try:
        with engine.begin() as conn:
            standard = get_active_standard(conn, diagram_type_id)
            family = _family_of(conn, diagram_type_id)
            if family not in DSL_FAMILIES:
                return 0
            rows = conn.execute(
                text(
                    "SELECT d.id, v.dsl_content FROM diagrams d JOIN diagram_versions v ON v.id = d.current_version_id"
                    " WHERE d.diagram_type_id = :type"
                ),
                {"type": diagram_type_id},
            ).all()
            for row in rows:
                parsed = bridge.parse(family, row.dsl_content)
                violations = bridge.validate(parsed["model"], standard.rules) if "model" in parsed and standard else []
                conn.execute(
                    text(
                        "UPDATE diagrams SET last_validation_result = :violations,"
                        " standard_version_at_last_check = :version WHERE id = :id"
                    ),
                    {
                        "violations": _compact(violations),
                        "version": standard.version if standard else None,
                        "id": row.id,
                    },
                )
            return len(rows)
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
    bridge = _bridge(request)
    with db.begin() as conn:
        family = _family_of(conn, id)
        rules, _given, parsed = _checked_rules(bridge, body, family)
        return {"standard": _create_draft(conn, id, rules, parsed.name, parsed.description)}


@router.put("/standards/{id}")
def update(id: str, request: Request, _admin: AdminUser, db: Db, body: Annotated[Any, Body()] = None) -> dict[str, Any]:
    """Edits a draft in place; published and retired standards are immutable (clone instead)."""
    bridge = _bridge(request)
    with db.begin() as conn:
        existing = _row_or_404(conn, id)
        family = _family_of(conn, existing.diagram_type_id)
        rules, given, parsed = _checked_rules(bridge, body, family)
        if existing.status != "draft":
            raise ApiError(409, f'Standard {id} is "{existing.status}", only "draft" standards can be edited')
        conn.execute(
            text(
                "UPDATE standards SET allowed_icon_library_refs = :refs, color_palette = :palette,"
                " font_constraints = :font, kind_rules = :kinds WHERE id = :id"
            ),
            {"id": id, **_json_columns(rules)},
        )
        if parsed.name is not None:
            conn.execute(text("UPDATE standards SET name = :name WHERE id = :id"), {"name": parsed.name, "id": id})
        if "description" in given:
            conn.execute(
                text("UPDATE standards SET description = :d WHERE id = :id"), {"d": parsed.description, "id": id}
            )
        _set_shapes(conn, id, rules.get("allowedShapeIds", []), rules.get("mandatoryShapeIds", []))
        return {"standard": standard_record(conn, get_standard_row(conn, id))}


@router.post("/standards/{id}/clone", status_code=201)
def clone(id: str, _admin: AdminUser, db: Db) -> dict[str, Any]:
    """Copies any version into a new draft: the safe way to change a published standard."""
    with db.begin() as conn:
        source = standard_record(conn, _row_or_404(conn, id))
        return {
            "standard": _create_draft(
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
    bridge = _bridge(request)
    with db.begin() as conn:
        row = _row_or_404(conn, id)
        if row.status != "draft":
            raise ApiError(409, f'Standard {id} is "{row.status}", only "draft" standards can be published')
        conn.execute(
            text(
                "UPDATE standards SET status = 'retired', retired_at = COALESCE(retired_at, CURRENT_TIMESTAMP)"
                " WHERE diagram_type_id = :type AND status = 'published'"
            ),
            {"type": row.diagram_type_id},
        )
        conn.execute(
            text("UPDATE standards SET status = 'published', published_at = CURRENT_TIMESTAMP WHERE id = :id"),
            {"id": id},
        )
        standard = standard_record(conn, get_standard_row(conn, id))
    # Existing diagrams are re-evaluated against it, never silently modified.
    background.add_task(revalidate_diagrams_for_type, db, bridge, standard["diagramTypeId"])
    return {"standard": standard}


@router.post("/standards/{id}/retire")
def retire(id: str, request: Request, background: BackgroundTasks, _admin: AdminUser, db: Db) -> dict[str, Any]:
    """Retiring removes the rules in force, so cached violations are refreshed too."""
    bridge = _bridge(request)
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
    background.add_task(revalidate_diagrams_for_type, db, bridge, standard["diagramTypeId"])
    return {"standard": standard}
