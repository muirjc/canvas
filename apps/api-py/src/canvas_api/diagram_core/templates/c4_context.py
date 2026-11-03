"""Port of diagram-core's template/c4-context-template-compiler.ts: a filled-in docs/c4-context-template.md
to Mermaid `C4Context` DSL text, following that document's mapping reference.

Generates DSL text directly, not a model: c4.ts collapses Person/Person_Ext to one role, so going through the
model would drop every entity's Internal/External column."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from canvas_api.diagram_core.templates.helpers import AliasAllocator, err, find_section, read_metadata_fields
from canvas_api.diagram_core.templates.markdown_table import extract_first_table, split_into_sections
from canvas_api.github.jstext import js_trim

__all__ = ["column", "compile_c4_context"]

ENTITY_TYPES = ("Person", "System", "SystemDb", "SystemQueue")
BOUNDARY_TYPES = ("Enterprise", "System")


@dataclass
class _Entity:
    name: str
    alias: str
    keyword: str
    description: str


@dataclass
class _Boundary:
    alias: str
    label: str
    keyword: str
    member_aliases: list[str] = field(default_factory=list)


def column(row: dict[str, str], *headers: str) -> str:
    """`row[a] ?? row[b] ?? ''`: the first column PRESENT, even if blank (unlike helpers.cell)."""
    for header in headers:
        if header in row:
            return row[header]
    return ""


def _sanitize(value: str) -> str:
    """Mermaid C4 strings have no escapes, so a `"` becomes `'`."""
    return value.replace('"', "'")


def compile_c4_context(markdown: str) -> dict[str, Any]:
    errors: list[dict[str, Any]] = []
    sections = split_into_sections(markdown)
    metadata_section = find_section(sections, "diagram metadata")
    boundaries_section = find_section(sections, "boundaries")
    entities_section = find_section(sections, "surrounding entities")
    relationships_section = find_section(sections, "relationships")
    styling_section = find_section(sections, "styling notes")

    if metadata_section is None:
        errors.append(err('Missing required section "1. Diagram metadata".'))
    if entities_section is None:
        errors.append(err('Missing required section "3. Surrounding entities".'))
    if relationships_section is None:
        errors.append(err('Missing required section "4. Relationships".'))
    if errors or metadata_section is None or entities_section is None or relationships_section is None:
        return {"errors": errors}

    # Section 1: metadata. "Central system technology (optional)" has no slot in System(...), so isn't emitted.
    fields = read_metadata_fields(metadata_section)
    title = fields.get("Diagram title", "")
    central_name = fields.get("Central system name", "")
    central_description = fields.get("Central system description (one line)", "")
    if not central_name:
        errors.append(err('Section 1: "Central system name" is required.'))
    if not central_description:
        errors.append(err('Section 1: "Central system description (one line)" is required.'))
    if errors:
        return {"errors": errors}

    aliases = AliasAllocator()
    central_alias = aliases.allocate(central_name)

    # Section 3: surrounding entities.
    entities: list[_Entity] = []
    entity_by_name: dict[str, _Entity] = {}
    for row in extract_first_table(entities_section.body):
        name = js_trim(row.get("Name", ""))
        if not name:
            continue
        kind = js_trim(row.get("Type", ""))
        scope = js_trim(row.get("Internal/External", ""))
        if kind not in ENTITY_TYPES:
            errors.append(
                err(
                    f'Section 3, entity "{name}": unrecognized Type "{row.get("Type", "")}" '
                    f"(expected one of {', '.join(ENTITY_TYPES)})."
                )
            )
            continue
        if scope not in ("Internal", "External"):
            errors.append(
                err(
                    f'Section 3, entity "{name}": unrecognized Internal/External value '
                    f'"{row.get("Internal/External", "")}" (expected "Internal" or "External").'
                )
            )
            continue
        entity = _Entity(
            name=name,
            alias=aliases.allocate(name),
            keyword=f"{kind}_Ext" if scope == "External" else kind,
            description=_sanitize(js_trim(column(row, "Description (one line)", "Description"))),
        )
        entities.append(entity)
        entity_by_name[name] = entity

    # Section 2: boundaries (optional). Read after Section 3, so members can be resolved.
    boundaries: list[_Boundary] = []
    member_to_boundary: dict[str, _Boundary] = {}
    if boundaries_section is not None:
        for row in extract_first_table(boundaries_section.body):
            boundary_name = js_trim(row.get("Boundary name", ""))
            if not boundary_name:
                continue
            kind = js_trim(column(row, "Type (Enterprise / System)", "Type"))
            if kind not in BOUNDARY_TYPES:
                errors.append(
                    err(
                        f'Section 2, boundary "{boundary_name}": unrecognized Type "{kind}" '
                        '(expected "Enterprise" or "System").'
                    )
                )
                continue
            member_aliases: list[str] = []
            for member_name in (n for n in (js_trim(p) for p in row.get("Entities inside", "").split(",")) if n):
                member = entity_by_name.get(member_name)
                if member is None:
                    errors.append(
                        err(
                            f'Section 2, boundary "{boundary_name}": "{member_name}" is not listed in Section 3 '
                            "(Surrounding entities)."
                        )
                    )
                    continue
                member_aliases.append(member.alias)
            boundary = _Boundary(
                alias=aliases.allocate(boundary_name),
                label=_sanitize(boundary_name),
                keyword=f"{kind}_Boundary",
                member_aliases=member_aliases,
            )
            boundaries.append(boundary)
            for member_alias in member_aliases:
                member_to_boundary[member_alias] = boundary

    # Section 4: relationships.
    def resolve_alias(name: str) -> str | None:
        if name == central_name:
            return central_alias
        found = entity_by_name.get(name)
        return found.alias if found else None

    rels: list[tuple[str, str, str, str]] = []
    for row in extract_first_table(relationships_section.body):
        source = js_trim(row.get("From", ""))
        target = js_trim(row.get("To", ""))
        if not source and not target:
            continue
        label = js_trim(column(row, "Label (short verb phrase)", "Label"))
        technology = js_trim(column(row, "Technology/protocol (optional)", "Technology/protocol"))
        source_alias = resolve_alias(source)
        target_alias = resolve_alias(target)
        if not source_alias:
            errors.append(
                err(
                    f'Section 4: relationship "From" value "{source}" is not the central system and not listed '
                    "in Section 3."
                )
            )
            continue
        if not target_alias:
            errors.append(
                err(
                    f'Section 4: relationship "To" value "{target}" is not the central system and not listed '
                    "in Section 3."
                )
            )
            continue
        if (source == central_name) == (target == central_name):
            errors.append(
                err(
                    f'Section 4: relationship "{source}" -> "{target}" must connect the central system to exactly '
                    "one surrounding entity (Level 1 rule) -- never entity-to-entity, and never the central system "
                    "to itself."
                )
            )
            continue
        if not label:
            errors.append(err(f'Section 4: relationship "{source}" -> "{target}" is missing a Label.'))
            continue
        rels.append((source_alias, target_alias, _sanitize(label), _sanitize(technology) if technology else ""))

    # Section 5: styling notes (optional).
    style_lines: list[tuple[str, str, str, str]] = []
    if styling_section is not None:
        for row in extract_first_table(styling_section.body):
            entity_name = js_trim(row.get("Entity name", ""))
            if not entity_name:
                continue
            alias = resolve_alias(entity_name)
            if not alias:
                errors.append(
                    err(
                        f'Section 5: styling entry "{entity_name}" is not the central system and not listed in '
                        "Section 3."
                    )
                )
                continue
            colors = (
                js_trim(row.get("Background color", "")),
                js_trim(row.get("Font color", "")),
                js_trim(row.get("Border color", "")),
            )
            if any(colors):
                style_lines.append((alias, *colors))

    if errors:
        return {"errors": errors}

    # Assembly. The central system's description is not sanitized, as in TypeScript.
    lines = ["C4Context"]
    lines.append(f"    title {_sanitize(title) if title else f'System Context diagram: {central_name}'}")
    lines.append("")
    lines.append(f'    System({central_alias}, "{_sanitize(central_name)}", "{central_description}")')

    def element_line(e: _Entity) -> str:
        return f'{e.keyword}({e.alias}, "{_sanitize(e.name)}", "{e.description}")'

    for entity in entities:
        if entity.alias not in member_to_boundary:
            lines.append(f"    {element_line(entity)}")
    for boundary in boundaries:
        lines.append(f'    {boundary.keyword}({boundary.alias}, "{boundary.label}") {{')
        for member_alias in boundary.member_aliases:
            member = next(e for e in entities if e.alias == member_alias)
            lines.append(f"        {element_line(member)}")
        lines.append("    }")
    lines.append("")
    for source_alias, target_alias, label, technology in rels:
        tech_arg = f', "{technology}"' if technology else ""
        lines.append(f'    Rel({source_alias}, {target_alias}, "{label}"{tech_arg})')
    if style_lines:
        lines.append("")
        for alias, bg, font, border in style_lines:
            args = [
                f'${name}="{_sanitize(value)}"'
                for name, value in (("bgColor", bg), ("fontColor", font), ("borderColor", border))
                if value
            ]
            lines.append(f"    UpdateElementStyle({alias}, {', '.join(args)})")
    return {"dsl": "\n".join(lines)}
