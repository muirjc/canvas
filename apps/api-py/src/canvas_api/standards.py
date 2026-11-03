"""Standards (standard.service.ts, revalidate.service.ts): reading a diagram type's active one for validation
and full records for the standards routes (routes/standards.py); writing a draft, publishing it and re-checking
the type's diagrams, shared by those routes and the catalog seed (canvas_api/seed/).

Rules are assembled as the TypeScript service does: the allowed/mandatory shape join tables, the JSON
columns, and the v2 kind rules spread on top.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from sqlalchemy import Connection, text

from canvas_api.catalog import DSL_FAMILIES
from canvas_api.diagram_core import DiagramCore
from canvas_api.timestamps import to_api

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


@dataclass(frozen=True)
class ActiveStandard:
    version: int
    rules: dict[str, Any]
    id: str = ""
    name: str | None = None
    description: str | None = None


def _json(value: Any) -> Any:
    """A JSON column: Postgres (JSONB) hands back the value, SQLite (TEXT) the text."""
    return json.loads(value) if isinstance(value, str) else value


_ACTIVE = text(
    "SELECT id, diagram_type_id, version, status, allowed_icon_library_refs, color_palette, font_constraints,"
    " kind_rules, name, description, published_at, created_at, retired_at FROM standards"
    " WHERE diagram_type_id = :type AND status = 'published'"
)
_BY_ID = text(
    "SELECT id, diagram_type_id, version, status, allowed_icon_library_refs, color_palette, font_constraints,"
    " kind_rules, name, description, published_at, created_at, retired_at FROM standards WHERE id = :id"
)
_FOR_TYPE = text(
    "SELECT id, diagram_type_id, version, status, allowed_icon_library_refs, color_palette, font_constraints,"
    " kind_rules, name, description, published_at, created_at, retired_at FROM standards"
    " WHERE diagram_type_id = :type ORDER BY version DESC"
)


def get_active_standard(conn: Connection, diagram_type_id: str) -> ActiveStandard | None:
    row = conn.execute(_ACTIVE, {"type": diagram_type_id}).first()
    if row is None:
        return None
    return ActiveStandard(int(row.version), rules_of(conn, row), str(row.id), row.name, row.description)


def rules_of(conn: Connection, row: Any) -> dict[str, Any]:
    """A standards row's StandardRules (standard.service.ts toRecord)."""
    allowed = [
        r.shape_id
        for r in conn.execute(
            text("SELECT shape_id FROM standard_allowed_shapes WHERE standard_id = :id ORDER BY position"),
            {"id": row.id},
        )
    ]
    mandatory = [
        r.shape_id
        for r in conn.execute(
            text("SELECT shape_id FROM standard_mandatory_shapes WHERE standard_id = :id ORDER BY position"),
            {"id": row.id},
        )
    ]
    rules: dict[str, Any] = {
        "allowedShapeIds": allowed,
        "mandatoryShapeIds": mandatory,
        "allowedIconLibraryRefs": _json(row.allowed_icon_library_refs) or [],
        "colorPalette": _json(row.color_palette) or [],
    }
    font = _json(row.font_constraints)
    if font is not None:
        rules["fontConstraints"] = font
    rules.update(_json(row.kind_rules) or {})
    return rules


def standard_record(conn: Connection, row: Any) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "diagramTypeId": row.diagram_type_id,
        "version": int(row.version),
        "status": row.status,
        "rules": rules_of(conn, row),
        "name": row.name,
        "description": row.description,
        "publishedAt": to_api(row.published_at),
        "createdAt": to_api(row.created_at),
        "retiredAt": to_api(row.retired_at),
    }


def get_standard_row(conn: Connection, standard_id: str) -> Any:
    return conn.execute(_BY_ID, {"id": standard_id}).first()


def active_standard_record(conn: Connection, diagram_type_id: str) -> dict[str, Any] | None:
    row = conn.execute(_ACTIVE, {"type": diagram_type_id}).first()
    return None if row is None else standard_record(conn, row)


def standards_for_type(conn: Connection, diagram_type_id: str) -> list[dict[str, Any]]:
    return [standard_record(conn, row) for row in conn.execute(_FOR_TYPE, {"type": diagram_type_id}).all()]


# --- writing ------------------------------------------------------------------------------------------


def compact_json(value: Any) -> str:
    """JSON.stringify's output, so both services store the same text."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def set_standard_shapes(conn: Connection, standard_id: str, allowed: list[str], mandatory: list[str]) -> None:
    """array-columns.ts setStandardAllowedShapes / setStandardMandatoryShapes."""
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


def standard_json_columns(rules: dict[str, Any]) -> dict[str, Any]:
    """The JSON columns' bind values (:refs, :palette, :font, :kinds), as standard.service.ts writes them."""
    return {
        "refs": compact_json(rules.get("allowedIconLibraryRefs", [])),
        "palette": compact_json(rules.get("colorPalette", [])),
        "font": compact_json(rules["fontConstraints"]) if rules.get("fontConstraints") else None,
        "kinds": compact_json({key: rules[key] for key in V2_RULE_KEYS if key in rules}),
    }


def create_draft_standard(
    conn: Connection, diagram_type_id: str, rules: dict[str, Any], name: str | None, description: str | None
) -> dict[str, Any]:
    """standard.service.ts createDraftStandard: the type's next version, as a draft. The rules aren't checked
    here (the routes check them first; the seed's are known good)."""
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
            **standard_json_columns(rules),
        },
    )
    set_standard_shapes(conn, standard_id, rules.get("allowedShapeIds", []), rules.get("mandatoryShapeIds", []))
    return standard_record(conn, get_standard_row(conn, standard_id))


def publish_standard(conn: Connection, standard_id: str, diagram_type_id: str) -> dict[str, Any]:
    """standard.service.ts publishStandard, after its draft check (the caller's): retires whatever was in force
    for the type and publishes this one."""
    conn.execute(
        text(
            "UPDATE standards SET status = 'retired', retired_at = COALESCE(retired_at, CURRENT_TIMESTAMP)"
            " WHERE diagram_type_id = :type AND status = 'published'"
        ),
        {"type": diagram_type_id},
    )
    conn.execute(
        text("UPDATE standards SET status = 'published', published_at = CURRENT_TIMESTAMP WHERE id = :id"),
        {"id": standard_id},
    )
    return standard_record(conn, get_standard_row(conn, standard_id))


def revalidate_type_diagrams(conn: Connection, core: DiagramCore, diagram_type_id: str) -> int:
    """revalidate.service.ts revalidateDiagramsForType: re-checks every diagram of a type against its standard
    in force (none = no violations), refreshing only the cached result, never the DSL. Returns how many."""
    standard = get_active_standard(conn, diagram_type_id)
    row = conn.execute(text("SELECT dsl_family FROM diagram_types WHERE id = :id"), {"id": diagram_type_id}).first()
    family = None if row is None else str(row.dsl_family)
    if family not in DSL_FAMILIES:
        return 0
    rows = conn.execute(
        text(
            "SELECT d.id, v.dsl_content FROM diagrams d JOIN diagram_versions v ON v.id = d.current_version_id"
            " WHERE d.diagram_type_id = :type"
        ),
        {"type": diagram_type_id},
    ).all()
    for diagram in rows:
        parsed = core.parse(family, diagram.dsl_content)
        violations = core.validate(parsed["model"], standard.rules) if "model" in parsed and standard else []
        conn.execute(
            text(
                "UPDATE diagrams SET last_validation_result = :violations,"
                " standard_version_at_last_check = :version WHERE id = :id"
            ),
            {
                "violations": compact_json(violations),
                "version": standard.version if standard else None,
                "id": diagram.id,
            },
        )
    return len(rows)
