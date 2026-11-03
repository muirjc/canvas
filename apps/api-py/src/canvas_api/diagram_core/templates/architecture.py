"""Port of diagram-core's template/architecture-template-compiler.ts: a filled-in docs/architecture-template.md
to Mermaid `architecture-beta` DSL, for the network / deployment / cloud-infrastructure diagram types.

Icons: Mermaid's five built-ins and iconify `prefix:name` go straight into the DSL. Canvas's own libraries
(`aws:<id>`, `azure:<id>`) can only be referenced through the `canvas.icons` front matter, so when any is used
the compiler writes that block, listing EVERY service's and group's icon (a front-matter-carrying file is read as
app-saved, where a group's `(cloud)` without an icons entry means "no icon")."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from canvas_api.diagram_core.templates.helpers import (
    AliasAllocator,
    cell,
    err,
    find_section,
    pick_option,
    read_metadata_fields,
    read_yes_no,
)
from canvas_api.diagram_core.templates.markdown_table import extract_first_table, split_into_sections
from canvas_api.github.jstext import js_trim

__all__ = ["compile_architecture"]

# Icon library ids, versions and (where checked) icon ids, kept equal to the TypeScript manifests by
# packages/diagram-core/tests/contract/python-icon-catalogue.test.ts.
_CATALOGUE: dict[str, Any] = json.loads((Path(__file__).parent.parent / "icon_catalogue.json").read_text("utf-8"))
_MERMAID = _CATALOGUE["mermaid"]
BUILT_IN_ICON_IDS: tuple[str, ...] = tuple(_MERMAID["builtInIds"])

_SIDES = {"left": "L", "l": "L", "right": "R", "r": "R", "top": "T", "t": "T", "bottom": "B", "b": "B"}
# Azure's bundled manifest is the real icon set, so its ids are checked; AWS's is a placeholder (a deployment may
# serve the real set), so its ids aren't.
_LIBRARIES: dict[str, tuple[str, str, frozenset[str] | None]] = {
    "aws": (_CATALOGUE["aws"]["libraryId"], _CATALOGUE["aws"]["libraryVersion"], None),
    "azure": (
        _CATALOGUE["azure"]["libraryId"],
        _CATALOGUE["azure"]["libraryVersion"],
        frozenset(_CATALOGUE["azure"]["iconIds"]),
    ),
}
_PREFIXED = re.compile(r"([a-z0-9-]+):([a-z0-9-]+)", re.IGNORECASE | re.ASCII)


@dataclass
class _Icon:
    token: str
    """What goes between the parentheses in the DSL."""
    ref: tuple[str, str, str] | None
    """(libraryId, libraryVersion, iconId), when one can be expressed (built-ins and Canvas libraries)."""
    library: bool
    """True for an aws:/azure: icon, which needs the front matter."""


@dataclass
class _Group:
    id: str
    name: str
    icon: _Icon
    parent_name: str
    parent_id: str | None = None


def _resolve_icon(raw: str, fallback: str, where: str, errors: list[dict[str, Any]]) -> _Icon | None:
    value = js_trim(raw) or fallback
    built_in = pick_option(value, BUILT_IN_ICON_IDS)
    if built_in:
        return _Icon(built_in, (_MERMAID["libraryId"], _MERMAID["libraryVersion"], built_in), library=False)
    prefixed = _PREFIXED.fullmatch(value)
    if not prefixed:
        errors.append(
            err(
                f'{where}: unrecognized Icon "{raw}" (expected {", ".join(BUILT_IN_ICON_IDS)}, aws:<icon>, '
                "azure:<icon> or an iconify prefix:name)."
            )
        )
        return None
    prefix, icon_id = prefixed[1], prefixed[2]
    library = _LIBRARIES.get(prefix.lower())
    if library is None:
        return _Icon(value, None, library=False)
    library_id, version, ids = library
    if ids is not None and icon_id not in ids:
        errors.append(err(f'{where}: "{icon_id}" is not an icon in Canvas\'s {prefix} library.'))
        return None
    return _Icon(icon_id, (library_id, version, icon_id), library=True)


def _label(name: str) -> str:
    """Square brackets end a Mermaid architecture label, so they're dropped from names."""
    return name.replace("[", "").replace("]", "")


def compile_architecture(markdown: str) -> dict[str, Any]:
    errors: list[dict[str, Any]] = []
    sections = split_into_sections(markdown)
    metadata_section = find_section(sections, "diagram metadata")
    groups_section = find_section(sections, "groups")
    services_section = find_section(sections, "services")
    junctions_section = find_section(sections, "junctions")
    connections_section = find_section(sections, "connections")

    if services_section is None:
        errors.append(err('Missing required section "3. Services".'))
    if connections_section is None:
        errors.append(err('Missing required section "5. Connections".'))
    if errors or services_section is None or connections_section is None:
        return {"errors": errors}

    title = read_metadata_fields(metadata_section).get("Diagram title", "") if metadata_section else ""
    # Groups, services and junctions share one id namespace in Mermaid.
    ids = AliasAllocator()
    names_taken: set[str] = set()

    def claim(name: str, where: str) -> bool:
        if name in names_taken:
            errors.append(err(f'{where}: the name "{name}" is already used by another group, service or junction.'))
            return False
        names_taken.add(name)
        return True

    # Section 2: groups.
    groups: list[_Group] = []
    group_by_name: dict[str, _Group] = {}
    if groups_section is not None:
        for row in extract_first_table(groups_section.body):
            name = cell(row, "Group")
            if not name:
                continue
            where = f'Section 2, group "{name}"'
            icon = _resolve_icon(cell(row, "Icon"), "cloud", where, errors)
            if icon is None or not claim(name, where):
                continue
            group = _Group(ids.allocate(name), name, icon, cell(row, "Inside group"))
            groups.append(group)
            group_by_name[name] = group

    def group_id(name: str, where: str) -> str | None:
        if not name:
            return None
        found = group_by_name.get(name)
        if found is None:
            errors.append(err(f'{where}: group "{name}" is not listed in Section 2 (Groups).'))
            return None
        return found.id

    for group in groups:
        group.parent_id = group_id(group.parent_name, f'Section 2, group "{group.name}"')
    # Parents before children; a cycle can't be ordered.
    ordered_groups: list[_Group] = []
    visiting: set[int] = set()

    def visit(group: _Group) -> None:
        if any(g is group for g in ordered_groups):
            return
        if id(group) in visiting:
            errors.append(err(f'Section 2: groups "{group.name}" and "{group.parent_name}" are inside each other.'))
            return
        visiting.add(id(group))
        parent = group_by_name.get(group.parent_name) if group.parent_name else None
        if parent is not None:
            visit(parent)
        visiting.discard(id(group))
        if not any(g is group for g in ordered_groups):
            ordered_groups.append(group)

    for group in groups:
        visit(group)

    # Section 3: services.
    endpoint_id: dict[str, str] = {}
    service_lines: list[str] = []
    icons: dict[str, _Icon] = {group.id: group.icon for group in groups}
    for row in extract_first_table(services_section.body):
        name = cell(row, "Service")
        if not name:
            continue
        where = f'Section 3, service "{name}"'
        icon = _resolve_icon(cell(row, "Icon"), "server", where, errors)
        if icon is None or not claim(name, where):
            continue
        parent = cell(row, "Group")
        parent_id = group_id(parent, where)
        if parent and not parent_id:
            continue
        service_id = ids.allocate(name)
        endpoint_id[name] = service_id
        icons[service_id] = icon
        service_lines.append(
            f"service {service_id}({icon.token})[{_label(name)}]{f' in {parent_id}' if parent_id else ''}"
        )
    if not service_lines and not errors:
        errors.append(err("Section 3: list at least one service."))

    # Section 4: junctions.
    junction_lines: list[str] = []
    if junctions_section is not None:
        for row in extract_first_table(junctions_section.body):
            name = cell(row, "Junction")
            if not name:
                continue
            where = f'Section 4, junction "{name}"'
            if not claim(name, where):
                continue
            parent = cell(row, "Group")
            parent_id = group_id(parent, where)
            if parent and not parent_id:
                continue
            junction_id = ids.allocate(name)
            endpoint_id[name] = junction_id
            junction_lines.append(f"junction {junction_id}{f' in {parent_id}' if parent_id else ''}")

    # Section 5: connections.
    edge_lines: list[str] = []
    for row in extract_first_table(connections_section.body):
        source = cell(row, "From")
        target = cell(row, "To")
        if not source and not target:
            continue
        where = f'Section 5, "{source}" -> "{target}"'
        source_id = endpoint_id.get(source)
        target_id = endpoint_id.get(target)
        if not source_id or not target_id:
            missing = target if source_id else source
            errors.append(
                err(
                    f'{where}: "{missing}" is a group -- connect a service or junction inside it instead.'
                    if missing in group_by_name
                    else f'{where}: "{missing}" is not listed in Section 3 or 4.'
                )
            )
            continue
        source_side = _SIDES.get((cell(row, "From side") or "Right").lower())
        target_side = _SIDES.get((cell(row, "To side") or "Left").lower())
        arrow = read_yes_no(cell(row, "Arrow"), True)
        if not source_side or not target_side or arrow is None:
            errors.append(err(f"{where}: sides must be Left, Right, Top or Bottom, and Arrow Yes or No."))
            continue
        edge_lines.append(f"{source_id}:{source_side} {'-->' if arrow else '--'} {target_side}:{target_id}")

    if errors:
        return {"errors": errors}

    # Assembly.
    lines: list[str] = []
    if any(icon.library for icon in icons.values()):
        lines += ["---", "canvas:", "  icons:"]
        for icon_owner, icon in icons.items():
            if icon.ref is None:
                continue
            library_id, version, icon_id = icon.ref
            lines += [
                f"    {icon_owner}:",
                f"      libraryId: {library_id}",
                f'      libraryVersion: "{version}"',
                f"      iconId: {icon_id}",
            ]
        lines.append("---")
    lines.append("architecture-beta")
    if title:
        lines.append(f"    title {title}")
    for group in ordered_groups:
        parent = f" in {group.parent_id}" if group.parent_id else ""
        lines.append(f"    group {group.id}({group.icon.token})[{_label(group.name)}]{parent}")
    lines += [f"    {line}" for line in [*service_lines, *junction_lines]]
    if edge_lines:
        lines.append("")
    lines += [f"    {line}" for line in edge_lines]
    return {"dsl": "\n".join(lines) + "\n"}
