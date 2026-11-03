"""Port of diagram-core's template/uml-class-template-compiler.ts: a filled-in docs/uml-class-template.md ->
Mermaid `classDiagram` DSL. Class names are code identifiers, used as-is: a name that isn't one is reported, not
renamed."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from canvas_api.diagram_core.templates.helpers import cell, err, find_section, pick_option, read_metadata_fields
from canvas_api.diagram_core.templates.jsregex import DOT, S
from canvas_api.diagram_core.templates.markdown_table import extract_first_table, split_into_sections
from canvas_api.github.jstext import js_trim

__all__ = ["compile_uml_class"]

_CLASS_NAME = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)(?:<([^<>]+)>)?")
_NAMESPACE_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*")
_WORD = re.compile(r"[A-Za-z0-9_]+")
_MEMBER_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_GENERIC_SUFFIX = re.compile(f"<{DOT}*>\\Z")
_WHITESPACE = re.compile(f"{S}+")
KINDS = ("Attribute", "Method")
VISIBILITY = {
    "public": "+",
    "+": "+",
    "private": "-",
    "-": "-",
    "protected": "#",
    "#": "#",
    "package": "~",
    "~": "~",
}
MODIFIERS = {"Static": "$", "Abstract": "*"}
MODIFIER_NAMES = tuple(MODIFIERS)
RELATIONSHIPS = ("Inheritance", "Realization", "Composition", "Aggregation", "Association", "Dependency", "Link")
TOKEN = {
    "Realization": "..|>",
    "Composition": "*--",
    "Aggregation": "o--",
    "Association": "-->",
    "Dependency": "..>",
    "Link": "--",
}
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


@dataclass
class _UmlClass:
    name: str
    generic: str | None
    stereotype: str | None
    namespace: str | None
    members: list[str] = field(default_factory=list)


def _mermaid_type(type_: str) -> str:
    """`List<String>` -> `List~String~` (Mermaid's generic notation); spaces inside a type dropped."""
    return _WHITESPACE.sub("", type_.replace("<", "~").replace(">", "~"))


def _quoted(value: str) -> str:
    return f' "{value.replace(chr(34), chr(39))}"' if value else ""


def compile_uml_class(markdown: str) -> dict[str, Any]:
    errors: list[dict[str, Any]] = []
    sections = split_into_sections(markdown)
    metadata_section = find_section(sections, "diagram metadata")
    classes_section = find_section(sections, "classes")
    members_section = find_section(sections, "members")
    relationships_section = find_section(sections, "relationships")

    if classes_section is None:
        return {"errors": [err('Missing required section "2. Classes".')]}

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

    # Section 2: classes
    classes: list[_UmlClass] = []
    by_name: dict[str, _UmlClass] = {}
    for row in extract_first_table(classes_section.body):
        raw = cell(row, "Class")
        if not raw:
            continue
        where = f'Section 2, class "{raw}"'
        match = _CLASS_NAME.fullmatch(raw)
        if match is None:
            errors.append(
                err(
                    f"{where}: a class name must be one word (letters, digits, _), "
                    "optionally generic like Repository<T>."
                )
            )
            continue
        name, generic = match[1], match[2]
        if name in by_name:
            errors.append(err(f"{where}: listed twice."))
            continue
        stereotype = cell(row, "Stereotype")
        if stereotype and not _WORD.fullmatch(stereotype):
            errors.append(err(f"{where}: a stereotype is one word, e.g. interface."))
            continue
        namespace = cell(row, "Namespace")
        if namespace and not _NAMESPACE_NAME.fullmatch(namespace):
            errors.append(err(f'{where}: namespace "{namespace}" must be a name like Billing or Billing.Core.'))
            continue
        uml_class = _UmlClass(name, _mermaid_type(generic) if generic else None, stereotype or None, namespace or None)
        classes.append(uml_class)
        by_name[name] = uml_class
    if not classes:
        errors.append(err("Section 2: list at least one class."))

    def resolve(raw: str, where: str) -> _UmlClass | None:
        """Rows elsewhere may name a class with or without its generic part."""
        uml_class = by_name.get(_GENERIC_SUFFIX.sub("", raw, count=1))
        if uml_class is None:
            errors.append(err(f'{where}: "{raw}" is not listed in Section 2 (Classes).'))
        return uml_class

    # Section 3: members
    if members_section:
        for row in extract_first_table(members_section.body):
            class_name = cell(row, "Class")
            member = cell(row, "Member")
            if not class_name and not member:
                continue
            where = f'Section 3, member "{class_name}.{member}"'
            owner = resolve(class_name, where)
            if owner is None:
                continue
            if not _MEMBER_NAME.fullmatch(member):
                errors.append(err(f"{where}: a member name must be one word (letters, digits, _)."))
                continue
            kind = pick_option(cell(row, "Kind") or ("Method" if cell(row, "Parameters") else "Attribute"), KINDS)
            visibility_raw = cell(row, "Visibility")
            visibility = VISIBILITY.get(visibility_raw.lower()) if visibility_raw else ""
            modifier_raw = cell(row, "Modifier")
            modifier = pick_option(modifier_raw, MODIFIER_NAMES) if modifier_raw else None
            if kind is None or visibility is None or (modifier_raw and not modifier):
                errors.append(
                    err(
                        f"{where}: Kind must be Attribute or Method, Visibility Public/Private/Protected/Package, "
                        "Modifier Static/Abstract."
                    )
                )
                continue
            type_ = _mermaid_type(cell(row, "Type"))
            mod = MODIFIERS[modifier] if modifier else ""
            if kind == "Method":
                parameters = cell(row, "Parameters").replace("<", "~").replace(">", "~")
                owner.members.append(f"{visibility}{member}({parameters}){f' {type_}' if type_ else ''}{mod}")
            else:
                owner.members.append(f"{visibility}{f'{type_} ' if type_ else ''}{member}{mod}")

    # Section 4: relationships
    relationships: list[str] = []
    if relationships_section:
        for row in extract_first_table(relationships_section.body):
            from_ = cell(row, "From")
            to = cell(row, "To")
            if not from_ and not to:
                continue
            where = f'Section 4, "{from_}" -> "{to}"'
            from_class = resolve(from_, where)
            to_class = resolve(to, where)
            if from_class is None or to_class is None:
                continue
            relationship = pick_option(cell(row, "Relationship") or "Association", RELATIONSHIPS)
            if relationship is None:
                errors.append(
                    err(
                        f'{where}: unrecognized Relationship "{cell(row, "Relationship")}" '
                        f"(expected {', '.join(RELATIONSHIPS)})."
                    )
                )
                continue
            label = cell(row, "Label")
            from_mult = _quoted(cell(row, "From multiplicity"))
            to_mult = _quoted(cell(row, "To multiplicity"))
            suffix = f" : {label}" if label else ""
            # Mermaid has no "--|>" here: inheritance is written parent-first with "<|--".
            relationships.append(
                f"{to_class.name}{to_mult} <|--{from_mult} {from_class.name}{suffix}"
                if relationship == "Inheritance"
                else f"{from_class.name}{from_mult} {TOKEN[relationship]}{to_mult} {to_class.name}{suffix}"
            )

    if errors:
        return {"errors": errors}

    # Assembly
    lines = ["classDiagram"]
    if title:
        lines.append(f"    title {title}")
    if direction:
        lines.append(f"    direction {direction}")

    def class_lines(c: _UmlClass, indent: str) -> list[str]:
        generic = f"~{c.generic}~" if c.generic else ""
        stereotype = f" <<{c.stereotype}>>" if c.stereotype else ""
        head = f"class {c.name}{generic}{stereotype}"
        if not c.members:
            return [f"{indent}{head}"]
        return [f"{indent}{head} {{", *(f"{indent}    {m}" for m in c.members), f"{indent}}}"]

    for c in classes:
        if not c.namespace:
            lines.extend(class_lines(c, "    "))
    namespaces = dict.fromkeys(c.namespace for c in classes if c.namespace)
    for namespace in namespaces:
        lines.append(f"    namespace {namespace} {{")
        for c in classes:
            if c.namespace == namespace:
                lines.extend(class_lines(c, "        "))
        lines.append("    }")
    if relationships:
        lines.append("")
    lines.extend(f"    {relationship}" for relationship in relationships)
    return {"dsl": "\n".join(lines) + "\n"}
