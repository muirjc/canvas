"""A diagram type's active (published) standard, read only (standard.service.ts getActiveStandard).

Writing standards (drafts, publish, retire) moves in phase 5; saving a diagram only needs the rules to
validate against. Rules are assembled as the TypeScript service does: the allowed/mandatory shape join
tables, the JSON columns, and the v2 kind rules spread on top.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Connection, text


@dataclass(frozen=True)
class ActiveStandard:
    version: int
    rules: dict[str, Any]


def _json(value: Any) -> Any:
    """A JSON column: Postgres (JSONB) hands back the value, SQLite (TEXT) the text."""
    return json.loads(value) if isinstance(value, str) else value


def get_active_standard(conn: Connection, diagram_type_id: str) -> ActiveStandard | None:
    row = conn.execute(
        text(
            "SELECT id, version, allowed_icon_library_refs, color_palette, font_constraints, kind_rules"
            " FROM standards WHERE diagram_type_id = :type AND status = 'published'"
        ),
        {"type": diagram_type_id},
    ).first()
    if row is None:
        return None
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
    return ActiveStandard(int(row.version), rules)
