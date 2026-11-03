"""Port of diagram-core's template/c4-levels-template-compiler.ts: a filled-in docs/c4-levels-template.md ->
Mermaid C4 DSL for the C4 Container, Component and Deployment diagram types. One compiler per level from one
factory, differing only in the header and the element/boundary types allowed. No "central system" rule here
(unlike Level 1): any two elements can be related."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from canvas_api.diagram_core.templates.helpers import (
    AliasAllocator,
    cell,
    err,
    find_section,
    pick_option,
    read_metadata_fields,
)
from canvas_api.diagram_core.templates.markdown_table import extract_first_table, split_into_sections

__all__ = ["compile_c4_component", "compile_c4_container", "compile_c4_deployment"]

Level = Literal["container", "component", "deployment"]

HEADER: dict[Level, str] = {"container": "C4Container", "component": "C4Component", "deployment": "C4Deployment"}
BASE_TYPES = ("Person", "System", "SystemDb", "SystemQueue", "Container", "ContainerDb", "ContainerQueue")
COMPONENT_TYPES = ("Component", "ComponentDb", "ComponentQueue")
ELEMENT_TYPES: dict[Level, tuple[str, ...]] = {
    "container": BASE_TYPES,
    "component": (*BASE_TYPES, *COMPONENT_TYPES),
    "deployment": BASE_TYPES,
}
BOUNDARY_TYPES: dict[Level, tuple[str, ...]] = {
    "container": ("System", "Container", "Enterprise", "Boundary"),
    "component": ("System", "Container", "Enterprise", "Boundary"),
    "deployment": ("Node",),
}
BOUNDARY_KEYWORD = {
    "System": "System_Boundary",
    "Container": "Container_Boundary",
    "Enterprise": "Enterprise_Boundary",
    "Boundary": "Boundary",
    "Node": "Deployment_Node",
}
SCOPES = ("Internal", "External")


@dataclass(eq=False)
class _Boundary:
    id: str
    name: str
    line: str
    inside_name: str
    parent: _Boundary | None = None


@dataclass(eq=False)
class _Element:
    line: str
    boundary: _Boundary | None


def _q(value: str) -> str:
    """Mermaid C4 text has no escape for `"`, so it becomes a single quote."""
    return '"' + value.replace('"', "'") + '"'


def _make_compiler(level: Level) -> Callable[[str], dict[str, Any]]:
    def compile_level(markdown: str) -> dict[str, Any]:
        errors: list[dict[str, Any]] = []
        sections = split_into_sections(markdown)
        metadata_section = find_section(sections, "diagram metadata")
        boundaries_section = find_section(sections, "boundaries")
        elements_section = find_section(sections, "elements")
        relationships_section = find_section(sections, "relationships")

        if elements_section is None:
            errors.append(err('Missing required section "3. Elements".'))
        if relationships_section is None:
            errors.append(err('Missing required section "4. Relationships".'))
        if elements_section is None or relationships_section is None:
            return {"errors": errors}

        title = read_metadata_fields(metadata_section).get("Diagram title", "") if metadata_section else ""
        ids = AliasAllocator()

        # Section 2: boundaries
        boundaries: list[_Boundary] = []
        boundary_by_name: dict[str, _Boundary] = {}
        if boundaries_section:
            for row in extract_first_table(boundaries_section.body):
                name = cell(row, "Boundary")
                if not name:
                    continue
                where = f'Section 2, boundary "{name}"'
                allowed = BOUNDARY_TYPES[level]
                boundary_type = pick_option(cell(row, "Type") or allowed[0], allowed)
                if boundary_type is None:
                    errors.append(
                        err(
                            f'{where}: Type "{cell(row, "Type")}" isn\'t allowed on a {HEADER[level]} diagram '
                            f"(expected {', '.join(allowed)})."
                        )
                    )
                    continue
                if name in boundary_by_name:
                    errors.append(err(f"{where}: listed twice."))
                    continue
                boundary_id = ids.allocate(name)
                technology = cell(row, "Technology")
                description = cell(row, "Description")
                # Positional args per Mermaid: Boundary(alias, label, type); Deployment_Node(alias, label, type, descr).
                args = [boundary_id, _q(name)]
                if boundary_type == "Node":
                    if technology or description:
                        args.append(_q(technology))
                    if description:
                        args.append(_q(description))
                elif boundary_type == "Boundary" and technology:
                    args.append(_q(technology))
                boundary = _Boundary(
                    boundary_id,
                    name,
                    f"{BOUNDARY_KEYWORD[boundary_type]}({', '.join(args)}) {{",
                    cell(row, "Inside"),
                )
                boundaries.append(boundary)
                boundary_by_name[name] = boundary

        def boundary_named(name: str, where: str) -> _Boundary | None:
            found = boundary_by_name.get(name)
            if found is None:
                errors.append(err(f'{where}: boundary "{name}" is not listed in Section 2 (Boundaries).'))
            return found

        for boundary in boundaries:
            if boundary.inside_name:
                boundary.parent = boundary_named(boundary.inside_name, f'Section 2, boundary "{boundary.name}"')
        for boundary in boundaries:
            seen: list[_Boundary] = []
            b: _Boundary | None = boundary
            while b is not None:
                if any(s is b for s in seen):
                    errors.append(err(f'Section 2: boundary "{boundary.name}" ends up inside itself.'))
                    boundary.parent = None
                    break
                seen.append(b)
                b = b.parent

        # Section 3: elements
        elements: list[_Element] = []
        element_id_by_name: dict[str, str] = {}
        for row in extract_first_table(elements_section.body):
            name = cell(row, "Name")
            if not name:
                continue
            where = f'Section 3, element "{name}"'
            allowed = ELEMENT_TYPES[level]
            element_type = pick_option(cell(row, "Type"), allowed)
            if element_type is None:
                errors.append(
                    err(
                        f'{where}: Type "{cell(row, "Type")}" isn\'t allowed on a {HEADER[level]} diagram '
                        f"(expected {', '.join(allowed)})."
                    )
                )
                continue
            scope = pick_option(cell(row, "Internal/External") or "Internal", SCOPES)
            if scope is None:
                errors.append(err(f"{where}: Internal/External must be Internal or External."))
                continue
            if name in element_id_by_name or name in boundary_by_name:
                errors.append(err(f"{where}: the name is already used by another element or boundary."))
                continue
            technology = cell(row, "Technology")
            has_technology = element_type.startswith(("Container", "Component"))
            if technology and not has_technology:
                errors.append(err(f"{where}: only containers and components have a Technology."))
                continue
            inside = cell(row, "Inside")
            element_boundary = boundary_named(inside, where) if inside else None
            if inside and element_boundary is None:
                continue
            element_id = ids.allocate(name)
            element_id_by_name[name] = element_id
            description = cell(row, "Description")
            args = [element_id, _q(name)]
            if has_technology:
                args.append(_q(technology))
            args.append(_q(description))
            # Trailing empty strings add nothing; drop them so the line reads naturally.
            while len(args) > 2 and args[-1] == '""':
                args.pop()
            ext = "_Ext" if scope == "External" else ""
            elements.append(_Element(f"{element_type}{ext}({', '.join(args)})", element_boundary))
        if not elements and not errors:
            errors.append(err("Section 3: list at least one element."))

        # Section 4: relationships
        rel_lines: list[str] = []
        for row in extract_first_table(relationships_section.body):
            from_ = cell(row, "From")
            to = cell(row, "To")
            if not from_ and not to:
                continue
            where = f'Section 4, "{from_}" -> "{to}"'
            from_id = element_id_by_name.get(from_)
            to_id = element_id_by_name.get(to)
            if not from_id or not to_id:
                missing = to if from_id else from_
                errors.append(
                    err(
                        f'{where}: "{missing}" is a boundary -- relate the elements inside it.'
                        if missing in boundary_by_name
                        else f'{where}: "{missing}" is not listed in Section 3 (Elements).'
                    )
                )
                continue
            label = cell(row, "Label")
            if not label:
                errors.append(err(f"{where}: a Label is required."))
                continue
            technology = cell(row, "Technology")
            tech = f", {_q(technology)}" if technology else ""
            rel_lines.append(f"Rel({from_id}, {to_id}, {_q(label)}{tech})")

        if errors:
            return {"errors": errors}

        # Assembly
        lines = [HEADER[level]]
        if title:
            lines.append(f"    title {title}")

        def emit(parent: _Boundary | None, depth: int) -> None:
            indent = "    " * depth
            lines.extend(f"{indent}{e.line}" for e in elements if e.boundary is parent)
            for child in boundaries:
                if child.parent is parent:
                    lines.append(f"{indent}{child.line}")
                    emit(child, depth + 1)
                    lines.append(f"{indent}}}")

        emit(None, 1)
        if rel_lines:
            lines.append("")
        lines.extend(f"    {line}" for line in rel_lines)
        return {"dsl": "\n".join(lines) + "\n"}

    return compile_level


compile_c4_container = _make_compiler("container")
compile_c4_component = _make_compiler("component")
compile_c4_deployment = _make_compiler("deployment")
