"""Diagram types: the catalog list and admin create, edit, hide and delete (phase 2, canvas-1bty.6).

Ported from apps/api/src/diagrams/diagram-type.routes.ts and diagram-type.service.ts. Built-in types
come from the catalog seed (still TypeScript); admin-made ones are `origin = 'custom'`.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, StrictBool, StrictStr
from sqlalchemy import Connection, Engine, bindparam, column, table, text, update

from canvas_api.auth.roles import AdminUser, CurrentUser
from canvas_api.catalog import BUILTIN_DIAGRAM_TYPE_IDS, DSL_FAMILIES, PERSONAS
from canvas_api.db import get_engine
from canvas_api.errors import ApiError

router = APIRouter(tags=["DiagramTypes"])
Db = Annotated[Engine, Depends(get_engine)]


class DiagramTypeBody(BaseModel):
    """POST and PATCH bodies. Every field is optional here; POST treats a missing one as empty."""

    name: StrictStr | None = None
    dslFamily: StrictStr | None = None
    personas: list[StrictStr] | None = None
    paletteLibraryIds: list[StrictStr] | None = None
    description: StrictStr | None = None
    #: PATCH only: hide or unhide (any type).
    hidden: StrictBool | None = None


def slugify(name: str) -> str:
    """ "Process Map (Ops)" -> "process-map-ops" (slugifyDiagramTypeName)."""
    normalized = unicodedata.normalize("NFKD", name.lower())
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", normalized))[:60]


def _validate(*, name: str | None = None, dsl_family: str | None = None, personas: list[str] | None = None) -> None:
    if name is not None and not name.strip():
        raise ApiError(400, "A diagram type needs a name.")
    if dsl_family is not None and dsl_family not in DSL_FAMILIES:
        raise ApiError(400, f'Unknown diagram family "{dsl_family}" ({", ".join(DSL_FAMILIES)}).')
    if personas is not None:
        if not personas:
            raise ApiError(400, "Choose at least one persona.")
        unknown = [p for p in personas if p not in PERSONAS]
        if unknown:
            raise ApiError(400, f"Unknown persona(s): {', '.join(unknown)}.")


#: A diagram type's ordered join rows (array-columns.ts): personas and palette libraries. Whole
#: statements per table, never assembled from names.
_JOIN_SQL = {
    "personas": {
        "delete": text("DELETE FROM diagram_types_personas WHERE diagram_type_id = :id"),
        "insert": text(
            "INSERT INTO diagram_types_personas (diagram_type_id, persona, position) VALUES (:id, :value, :position)"
        ),
        "select": text(
            "SELECT diagram_type_id, persona AS value FROM diagram_types_personas"
            " WHERE diagram_type_id IN :ids ORDER BY diagram_type_id, position"
        ).bindparams(bindparam("ids", expanding=True)),
    },
    "palette": {
        "delete": text("DELETE FROM diagram_type_palette_libraries WHERE diagram_type_id = :id"),
        "insert": text(
            "INSERT INTO diagram_type_palette_libraries (diagram_type_id, library_id, position)"
            " VALUES (:id, :value, :position)"
        ),
        "select": text(
            "SELECT diagram_type_id, library_id AS value FROM diagram_type_palette_libraries"
            " WHERE diagram_type_id IN :ids ORDER BY diagram_type_id, position"
        ).bindparams(bindparam("ids", expanding=True)),
    },
}
_LIST_ALL = text(
    "SELECT id, name, abstraction_level, dsl_family, origin, admin_edited, description, hidden"
    " FROM diagram_types ORDER BY name"
)
_LIST_SOME = text(
    "SELECT id, name, abstraction_level, dsl_family, origin, admin_edited, description, hidden"
    " FROM diagram_types WHERE id IN :ids ORDER BY name"
).bindparams(bindparam("ids", expanding=True))
#: For partial updates: SQLAlchemy Core builds the SET list from the columns given.
_diagram_types = table(
    "diagram_types",
    column("id"),
    column("name"),
    column("dsl_family"),
    column("description"),
    column("hidden"),
    column("admin_edited"),
)


def _set_join_rows(conn: Connection, kind: Literal["personas", "palette"], type_id: str, values: list[str]) -> None:
    conn.execute(_JOIN_SQL[kind]["delete"], {"id": type_id})
    if values:
        conn.execute(
            _JOIN_SQL[kind]["insert"],
            [{"id": type_id, "value": value, "position": i} for i, value in enumerate(values)],
        )


def _join_rows(conn: Connection, kind: Literal["personas", "palette"], ids: list[str]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    if not ids:
        return result
    for row in conn.execute(_JOIN_SQL[kind]["select"], {"ids": ids}).all():
        result.setdefault(row.diagram_type_id, []).append(row.value)
    return result


def list_diagram_type_records(conn: Connection, ids: list[str] | None = None) -> list[dict[str, Any]]:
    """All diagram types (or just `ids`), ordered by name."""
    result = conn.execute(_LIST_ALL) if ids is None else conn.execute(_LIST_SOME, {"ids": ids or [""]})
    rows = result.all()
    row_ids = [r.id for r in rows]
    personas = _join_rows(conn, "personas", row_ids)
    palettes = _join_rows(conn, "palette", row_ids)
    return [
        {
            "id": r.id,
            "name": r.name,
            "personas": personas.get(r.id, []),
            "abstractionLevel": r.abstraction_level,
            "dslFamily": r.dsl_family,
            "defaultPaletteLibraryIds": palettes.get(r.id, []),
            "origin": r.origin,
            "adminEdited": bool(r.admin_edited),
            "description": r.description,
            "hidden": bool(r.hidden),
        }
        for r in rows
    ]


def _get_record(conn: Connection, type_id: str) -> dict[str, Any]:
    records = list_diagram_type_records(conn, [type_id])
    if not records:
        raise ApiError(404, f"No diagram type with id {type_id}")
    return records[0]


@router.get("/diagram-types")
def list_diagram_types(
    _user: CurrentUser,
    db: Db,
    persona: str | None = None,
    includeHidden: str | None = None,
) -> dict[str, Any]:
    """The catalog, optionally for one persona. Hidden types are left out of the create pickers unless
    includeHidden=true (the admin page, and the project browser labelling existing diagrams)."""
    include_hidden = includeHidden == "true"
    with db.connect() as conn:
        records = list_diagram_type_records(conn)
    return {
        "diagramTypes": [
            t for t in records if (include_hidden or not t["hidden"]) and (not persona or persona in t["personas"])
        ]
    }


@router.post("/admin/diagram-types", status_code=201)
def create_diagram_type(_admin: AdminUser, db: Db, body: DiagramTypeBody | None = None) -> dict[str, Any]:
    body = body or DiagramTypeBody()
    name = body.name or ""
    dsl_family = body.dslFamily or ""
    personas = body.personas or []
    _validate(name=name, dsl_family=dsl_family, personas=personas)
    type_id = slugify(name)
    if not type_id:
        raise ApiError(400, "The name needs at least one letter or digit.")
    if type_id in BUILTIN_DIAGRAM_TYPE_IDS:
        raise ApiError(409, f'"{name}" collides with the built-in diagram type "{type_id}".')
    with db.begin() as conn:
        if conn.execute(text("SELECT id FROM diagram_types WHERE id = :id"), {"id": type_id}).first():
            raise ApiError(409, f'A diagram type with id "{type_id}" already exists.')
        conn.execute(
            text(
                "INSERT INTO diagram_types (id, name, abstraction_level, dsl_family, origin, description)"
                " VALUES (:id, :name, 'N/A', :family, 'custom', :description)"
            ),
            {"id": type_id, "name": name.strip(), "family": dsl_family, "description": body.description},
        )
        _set_join_rows(conn, "personas", type_id, personas)
        _set_join_rows(conn, "palette", type_id, body.paletteLibraryIds or [])
        return {"diagramType": _get_record(conn, type_id)}


@router.patch("/admin/diagram-types/{id}")
def update_diagram_type(id: str, _admin: AdminUser, db: Db, body: DiagramTypeBody | None = None) -> dict[str, Any]:
    """Any type can be edited. A built-in type's family never changes; a custom type's family is locked
    once a diagram uses it. Editing a built-in marks it admin-edited (the catalog seed then leaves it
    alone); hiding doesn't count as editing."""
    patch = body or DiagramTypeBody()
    given = patch.model_fields_set
    _validate(
        name=patch.name if "name" in given else None,
        dsl_family=patch.dslFamily if "dslFamily" in given else None,
        personas=patch.personas if "personas" in given else None,
    )
    with db.begin() as conn:
        row = conn.execute(text("SELECT origin, dsl_family FROM diagram_types WHERE id = :id"), {"id": id}).first()
        if row is None:
            raise ApiError(404, f"No diagram type with id {id}")
        family_changes = patch.dslFamily is not None and patch.dslFamily != row.dsl_family
        if row.origin == "builtin" and family_changes:
            raise ApiError(409, f'"{id}" is a built-in diagram type, so its family can\'t change.')
        if (
            family_changes
            and conn.execute(text("SELECT id FROM diagrams WHERE diagram_type_id = :id"), {"id": id}).first()
        ):
            raise ApiError(409, f'"{id}" already has diagrams, so its family can\'t change.')
        edits_definition = bool(given & {"name", "dslFamily", "description", "personas", "paletteLibraryIds"})
        changes: dict[str, Any] = {}
        if patch.name is not None:
            changes["name"] = patch.name.strip()
        if patch.dslFamily is not None:
            changes["dsl_family"] = patch.dslFamily
        if "description" in given:
            changes["description"] = patch.description
        if patch.hidden is not None:
            changes["hidden"] = patch.hidden
        if row.origin == "builtin" and edits_definition:
            changes["admin_edited"] = True
        if changes:
            conn.execute(update(_diagram_types).where(_diagram_types.c.id == id).values(**changes))
        if patch.personas is not None:
            _set_join_rows(conn, "personas", id, patch.personas)
        if patch.paletteLibraryIds is not None:
            _set_join_rows(conn, "palette", id, patch.paletteLibraryIds)
        return {"diagramType": _get_record(conn, id)}


@router.delete("/admin/diagram-types/{id}", status_code=204)
def delete_diagram_type(id: str, _admin: AdminUser, db: Db) -> Response:
    """Deletes a custom type no diagram (deleted ones included: they can be restored) or template uses,
    with its standards. Built-in types can only be hidden -- the catalog seed would recreate one."""
    with db.begin() as conn:
        row = conn.execute(text("SELECT origin FROM diagram_types WHERE id = :id"), {"id": id}).first()
        if row is None:
            raise ApiError(404, f"No diagram type with id {id}")
        if row.origin == "builtin":
            raise ApiError(409, f'"{id}" is a built-in diagram type and can\'t be deleted; hide it instead.')
        diagrams = int(
            conn.execute(text("SELECT COUNT(*) FROM diagrams WHERE diagram_type_id = :id"), {"id": id}).scalar_one()
        )
        templates = int(
            conn.execute(text("SELECT COUNT(*) FROM templates WHERE diagram_type_id = :id"), {"id": id}).scalar_one()
        )
        if diagrams > 0 or templates > 0:
            uses = [
                f"{diagrams} diagram{'' if diagrams == 1 else 's'}" if diagrams > 0 else "",
                f"{templates} template{'' if templates == 1 else 's'}" if templates > 0 else "",
            ]
            raise ApiError(
                409,
                f'"{id}" is used by {" and ".join(u for u in uses if u)} (deleted diagrams included),'
                " so it can't be deleted; hide it instead.",
            )
        conn.execute(text("DELETE FROM standards WHERE diagram_type_id = :id"), {"id": id})
        conn.execute(text("DELETE FROM diagram_types WHERE id = :id"), {"id": id})
    return Response(status_code=204)
