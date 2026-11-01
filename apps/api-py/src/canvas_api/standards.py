"""Reading standards (standard.service.ts): a diagram type's active one for validation, and full
records for the standards routes (routes/standards.py).

Rules are assembled as the TypeScript service does: the allowed/mandatory shape join tables, the JSON
columns, and the v2 kind rules spread on top.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Connection, text

from canvas_api.timestamps import to_api


@dataclass(frozen=True)
class ActiveStandard:
    version: int
    rules: dict[str, Any]


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
    return ActiveStandard(int(row.version), rules_of(conn, row))


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
