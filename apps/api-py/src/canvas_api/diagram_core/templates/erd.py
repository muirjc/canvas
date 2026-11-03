"""Port of diagram-core's template/erd-template-compiler.ts: a filled-in docs/erd-template.md -> Mermaid
`erDiagram` DSL. An entity name that isn't a plain identifier gets a generated id plus an `id[Name]` alias."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from canvas_api.diagram_core.templates.helpers import (
    AliasAllocator,
    cell,
    err,
    find_section,
    list_cell,
    pick_option,
    read_metadata_fields,
    read_yes_no,
)
from canvas_api.diagram_core.templates.jsregex import S
from canvas_api.diagram_core.templates.markdown_table import extract_first_table, split_into_sections
from canvas_api.github.jstext import js_trim

__all__ = ["compile_erd"]

CARDINALITIES = ("Exactly one", "Zero or one", "One or more", "Zero or more")
FROM_TOKEN = {"Exactly one": "||", "Zero or one": "|o", "One or more": "}|", "Zero or more": "}o"}
TO_TOKEN = {"Exactly one": "||", "Zero or one": "o|", "One or more": "|{", "Zero or more": "o{"}
KEYS = ("PK", "FK", "UK")
DIRECTIONS = {
    "tb": "TB",
    "td": "TB",
    "top to bottom": "TB",
    "lr": "LR",
    "left to right": "LR",
    "bt": "BT",
    "bottom to top": "BT",
    "rl": "RL",
    "right to left": "RL",
}
_PLAIN_ID = re.compile(r"[A-Za-z0-9_-]+")
_NOT_ID = re.compile(r"[^A-Za-z0-9_-]+")
_EDGE_UNDERSCORES = re.compile(r"^_+|_+\Z")
_WHITESPACE = re.compile(f"{S}+")
_BRACKETS = re.compile(r"[\[\]]")


@dataclass
class _Entity:
    id: str
    name: str
    attributes: list[str] = field(default_factory=list)


def _entity_id(name: str) -> str:
    """ "Order Line" -> "Order_Line": an erDiagram id allows only letters, digits, `_` and `-`."""
    return _EDGE_UNDERSCORES.sub("", _NOT_ID.sub("_", name)) or "entity"


def compile_erd(markdown: str) -> dict[str, Any]:
    errors: list[dict[str, Any]] = []
    sections = split_into_sections(markdown)
    metadata_section = find_section(sections, "diagram metadata")
    entities_section = find_section(sections, "entities")
    attributes_section = find_section(sections, "attributes")
    relationships_section = find_section(sections, "relationships")

    if entities_section is None:
        errors.append(err('Missing required section "2. Entities".'))
    if relationships_section is None:
        errors.append(err('Missing required section "4. Relationships".'))
    if entities_section is None or relationships_section is None:
        return {"errors": errors}

    fields = read_metadata_fields(metadata_section) if metadata_section else {}
    title = js_trim(fields.get("Diagram title", ""))
    direction_raw = next((value for key, value in fields.items() if key.startswith("Direction")), "")
    direction = DIRECTIONS.get(direction_raw.lower()) if direction_raw else None
    if direction_raw and not direction:
        errors.append(
            err(
                f'Section 1: unrecognized Direction "{direction_raw}" '
                "(expected Top to bottom, Left to right, Bottom to top or Right to left)."
            )
        )

    # Section 2: entities
    ids = AliasAllocator(_entity_id)
    entities: list[_Entity] = []
    by_name: dict[str, _Entity] = {}
    for row in extract_first_table(entities_section.body):
        name = cell(row, "Name")
        if not name:
            continue
        if name in by_name:
            errors.append(err(f'Section 2: entity "{name}" is listed twice.'))
            continue
        entity = _Entity(ids.allocate(name), name)
        entities.append(entity)
        by_name[name] = entity
    if not entities:
        errors.append(err("Section 2: list at least one entity."))

    def resolve(name: str, where: str) -> _Entity | None:
        entity = by_name.get(name)
        if entity is None:
            errors.append(err(f'{where}: "{name}" is not listed in Section 2 (Entities).'))
        return entity

    # Section 3: attributes
    if attributes_section:
        for row in extract_first_table(attributes_section.body):
            entity_name = cell(row, "Entity")
            attribute = cell(row, "Attribute")
            if not entity_name and not attribute:
                continue
            where = f'Section 3, attribute "{entity_name}.{attribute}"'
            found = resolve(entity_name, where)
            if found is None:
                continue
            type_ = _WHITESPACE.sub("", cell(row, "Type"))
            if not attribute or not type_:
                errors.append(err(f"{where}: Attribute and Type are both required."))
                continue
            keys: list[str] = []
            bad_key = False
            for key in list_cell(cell(row, "Key")):
                known = pick_option(key, KEYS)
                if known is None:
                    errors.append(err(f'{where}: unrecognized Key "{key}" (expected PK, FK or UK).'))
                    bad_key = True
                elif known not in keys:
                    keys.append(known)
            if bad_key:
                continue
            comment = cell(row, "Comment").replace('"', "'")
            parts = [type_, _WHITESPACE.sub("_", attribute), ", ".join(keys), f'"{comment}"' if comment else ""]
            found.attributes.append(" ".join(p for p in parts if p))

    # Section 4: relationships
    relationships: list[str] = []
    for row in extract_first_table(relationships_section.body):
        from_ = cell(row, "From")
        to = cell(row, "To")
        if not from_ and not to:
            continue
        where = f'Section 4, "{from_}" -> "{to}"'
        from_entity = resolve(from_, where)
        to_entity = resolve(to, where)
        if from_entity is None or to_entity is None:
            continue
        from_card = pick_option(cell(row, "From cardinality") or "Exactly one", CARDINALITIES)
        to_card = pick_option(cell(row, "To cardinality") or "Zero or more", CARDINALITIES)
        if from_card is None or to_card is None:
            errors.append(err(f"{where}: cardinality must be one of {', '.join(CARDINALITIES)}."))
            continue
        identifying = read_yes_no(cell(row, "Identifying"), True)
        if identifying is None:
            errors.append(err(f"{where}: Identifying must be Yes or No."))
            continue
        label = cell(row, "Label") or "relates to"
        line = "--" if identifying else ".."
        relationships.append(
            f"{from_entity.id} {FROM_TOKEN[from_card]}{line}{TO_TOKEN[to_card]} {to_entity.id} : {label}"
        )

    if errors:
        return {"errors": errors}

    # Assembly
    lines = ["erDiagram"]
    if title:
        lines.append(f"    title {title}")
    if direction:
        lines.append(f"    direction {direction}")
    for entity in entities:
        plain = entity.id == entity.name and _PLAIN_ID.fullmatch(entity.name)
        head = entity.id if plain else f"{entity.id}[{_BRACKETS.sub('', entity.name)}]"
        if not entity.attributes:
            lines.append(f"    {head}")
            continue
        lines.append(f"    {head} {{")
        lines.extend(f"        {attribute}" for attribute in entity.attributes)
        lines.append("    }")
    if relationships:
        lines.append("")
    lines.extend(f"    {relationship}" for relationship in relationships)
    return {"dsl": "\n".join(lines) + "\n"}
