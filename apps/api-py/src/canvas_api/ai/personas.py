"""AI personas and their reference material (apps/api/src/ai/persona.service.ts,
persona-reference-material.service.ts)."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from sqlalchemy import Connection, bindparam, text

from canvas_api.catalog import DSL_FAMILIES
from canvas_api.timestamps import to_api

PERSONA_CATEGORIES = ("Business", "Enterprise", "Solution", "Technical")


class InvalidPersonaCategoryError(Exception):
    def __init__(self) -> None:
        super().__init__(f"category must be one of: {', '.join(PERSONA_CATEGORIES)}")


class InvalidReferenceMaterialError(Exception):
    pass


_PERSONA_COLUMNS = "id, name, category, system_prompt, status, created_at, updated_at"
_ACTIVE = text(
    "SELECT id, name, category, system_prompt, status, created_at, updated_at FROM ai_personas"
    " WHERE status = 'active' ORDER BY category, name"
)
_ALL = text(
    "SELECT id, name, category, system_prompt, status, created_at, updated_at FROM ai_personas ORDER BY category, name"
)
_ONE = text("SELECT id, name, category, system_prompt, status, created_at, updated_at FROM ai_personas WHERE id = :id")


def _persona(row: Any) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "name": row.name,
        "category": row.category,
        "systemPrompt": row.system_prompt,
        "status": row.status,
        "createdAt": to_api(row.created_at),
        "updatedAt": to_api(row.updated_at),
    }


def list_active_personas(conn: Connection) -> list[dict[str, Any]]:
    return [_persona(r) for r in conn.execute(_ACTIVE)]


def list_all_personas(conn: Connection) -> list[dict[str, Any]]:
    return [_persona(r) for r in conn.execute(_ALL)]


def get_persona(conn: Connection, persona_id: str) -> dict[str, Any] | None:
    row = conn.execute(_ONE, {"id": persona_id}).first()
    return _persona(row) if row else None


def create_persona(conn: Connection, name: str, category: str, system_prompt: str) -> dict[str, Any]:
    if category not in PERSONA_CATEGORIES:
        raise InvalidPersonaCategoryError()
    persona_id = str(uuid4())
    conn.execute(
        text("INSERT INTO ai_personas (id, name, category, system_prompt) VALUES (:id, :name, :category, :prompt)"),
        {"id": persona_id, "name": name, "category": category, "prompt": system_prompt},
    )
    created = get_persona(conn, persona_id)
    assert created is not None  # noqa: S101 - inserted just above, same transaction
    return created


def update_persona(
    conn: Connection, persona_id: str, name: str | None, category: str | None, system_prompt: str | None
) -> dict[str, Any] | None:
    if category is not None and category not in PERSONA_CATEGORIES:
        raise InvalidPersonaCategoryError()
    existing = get_persona(conn, persona_id)
    if existing is None:
        return None
    conn.execute(
        text(
            "UPDATE ai_personas SET name = :name, category = :category, system_prompt = :prompt,"
            " updated_at = CURRENT_TIMESTAMP WHERE id = :id"
        ),
        {
            "name": name if name is not None else existing["name"],
            "category": category if category is not None else existing["category"],
            "prompt": system_prompt if system_prompt is not None else existing["systemPrompt"],
            "id": persona_id,
        },
    )
    return get_persona(conn, persona_id)


def archive_persona(conn: Connection, persona_id: str) -> dict[str, Any] | None:
    changed = conn.execute(
        text("UPDATE ai_personas SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = :id"),
        {"id": persona_id},
    )
    return get_persona(conn, persona_id) if changed.rowcount else None


# --- reference material ------------------------------------------------------------------------------

_ENTRIES = text(
    "SELECT id, persona_id, content, created_at, updated_at FROM ai_persona_reference_material"
    " WHERE persona_id = :persona ORDER BY created_at"
)
_ENTRY = text(
    "SELECT id, persona_id, content, created_at, updated_at FROM ai_persona_reference_material"
    " WHERE id = :id AND persona_id = :persona"
)
_FAMILIES = text(
    "SELECT reference_material_id, diagram_family FROM ai_persona_reference_material_families"
    " WHERE reference_material_id IN :ids ORDER BY reference_material_id, position"
).bindparams(bindparam("ids", expanding=True))


def _families(conn: Connection, entry_ids: list[str]) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    if entry_ids:
        for r in conn.execute(_FAMILIES, {"ids": entry_ids}):
            found.setdefault(str(r.reference_material_id), []).append(r.diagram_family)
    return found


def _entry(row: Any, families: list[str]) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "personaId": str(row.persona_id),
        "content": row.content,
        "diagramFamilies": families,
        "createdAt": to_api(row.created_at),
        "updatedAt": to_api(row.updated_at),
    }


def _check_content(content: str) -> None:
    if content.strip() == "":
        raise InvalidReferenceMaterialError("content must be non-empty")


def _check_families(families: list[str] | None) -> None:
    invalid = [f for f in families or [] if f not in DSL_FAMILIES]
    if invalid:
        raise InvalidReferenceMaterialError(
            "diagramFamilies must be registered diagram-type family ids, got invalid value(s): " + ", ".join(invalid)
        )


def _set_families(conn: Connection, entry_id: str, families: list[str]) -> None:
    conn.execute(
        text("DELETE FROM ai_persona_reference_material_families WHERE reference_material_id = :id"), {"id": entry_id}
    )
    for position, family in enumerate(families):
        conn.execute(
            text(
                "INSERT INTO ai_persona_reference_material_families (reference_material_id, diagram_family, position)"
                " VALUES (:id, :family, :position)"
            ),
            {"id": entry_id, "family": family, "position": position},
        )


def list_reference_material(conn: Connection, persona_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(_ENTRIES, {"persona": persona_id}).all()
    families = _families(conn, [str(r.id) for r in rows])
    return [_entry(r, families.get(str(r.id), [])) for r in rows]


def get_reference_material(conn: Connection, persona_id: str, entry_id: str) -> dict[str, Any] | None:
    row = conn.execute(_ENTRY, {"id": entry_id, "persona": persona_id}).first()
    return _entry(row, _families(conn, [str(row.id)]).get(str(row.id), [])) if row else None


def create_reference_material(
    conn: Connection, persona_id: str, content: str, families: list[str] | None
) -> dict[str, Any]:
    _check_content(content)
    _check_families(families)
    entry_id = str(uuid4())
    conn.execute(
        text("INSERT INTO ai_persona_reference_material (id, persona_id, content) VALUES (:id, :persona, :content)"),
        {"id": entry_id, "persona": persona_id, "content": content},
    )
    if families:
        _set_families(conn, entry_id, families)
    created = get_reference_material(conn, persona_id, entry_id)
    assert created is not None  # noqa: S101 - inserted just above, same transaction
    return created


def update_reference_material(
    conn: Connection, persona_id: str, entry_id: str, content: str | None, families: list[str] | None
) -> dict[str, Any] | None:
    if content is not None:
        _check_content(content)
    if families is not None:
        _check_families(families)
    existing = get_reference_material(conn, persona_id, entry_id)
    if existing is None:
        return None
    conn.execute(
        text(
            "UPDATE ai_persona_reference_material SET content = :content, updated_at = CURRENT_TIMESTAMP"
            " WHERE id = :id AND persona_id = :persona"
        ),
        {"content": content if content is not None else existing["content"], "id": entry_id, "persona": persona_id},
    )
    if families is not None:
        _set_families(conn, entry_id, families)
    return get_reference_material(conn, persona_id, entry_id)


def delete_reference_material(conn: Connection, persona_id: str, entry_id: str) -> bool:
    deleted = conn.execute(
        text("DELETE FROM ai_persona_reference_material WHERE id = :id AND persona_id = :persona"),
        {"id": entry_id, "persona": persona_id},
    )
    return bool(deleted.rowcount)


def reference_material_for_family(conn: Connection, persona_id: str, family: str) -> list[dict[str, Any]]:
    """Entries scoped to this family, or to none (they apply to every family)."""
    return [
        e
        for e in list_reference_material(conn, persona_id)
        if not e["diagramFamilies"] or family in e["diagramFamilies"]
    ]
