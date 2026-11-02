"""Mermaid classDiagram (packages/diagram-core/src/dsl/uml.ts).

A line-by-line port, like flowchart.py: the same regular expressions (JavaScript's `\\s`, `\\w` and `.` spelled out,
case-insensitive matches restricted to ASCII as JavaScript's non-unicode /i is), tried in the same order, the same
second pass for `class`/`style`, and the same front matter. Parse returns {"model": ...} or {"errors": [...]},
never raises (bad YAML front matter excepted, as in TypeScript).
"""

from __future__ import annotations

import re
from typing import Any

from canvas_api.diagram_core.containment_layout import compute_containment_layout
from canvas_api.diagram_core.flowchart import parse_style_props
from canvas_api.diagram_core.front_matter import (
    canvas_section,
    join_front_matter,
    read_legend,
    section,
    split_front_matter,
    strip_trailing_comment,
    with_legend,
)
from canvas_api.diagram_core.model import create_empty_diagram_model
from canvas_api.github.jstext import JS_WHITESPACE, js_trim

__all__ = ["UML_RELATION_KINDS", "parse_uml", "serialize_uml"]

S = f"[{JS_WHITESPACE}]"  # JavaScript's \s
DOT = "[^\\n\\r\\u2028\\u2029]"  # JavaScript's .
W = "[A-Za-z0-9_]"  # JavaScript's \w
ID = "[A-Za-z0-9_]+"

CLASS_BLOCK_START = re.compile(f"^class{S}+({ID})(?:~([^~]+)~)?(?:{S}+<<({W}+)>>)?{S}*\\{{\\Z")
CLASS_DECL = re.compile(f"^class{S}+({ID})(?:~([^~]+)~)?(?:{S}+<<({W}+)>>)?\\Z")
STANDALONE_ANNOTATION = re.compile(f"^<<({W}+)>>{S}+({ID})\\Z")
BODY_ANNOTATION = re.compile(f"^<<({W}+)>>\\Z")
BLOCK_END = re.compile("^\\}\\Z")

REL_TOKEN = r"\.\.\|>|<\|--|\*--|o--|-->|\.\.>|\(\)--|--\(\)|--|\.\."  # noqa: S105 - not a password
RELATIONSHIP = re.compile(
    f'^({ID}){S}*(?:"([^"]*)"{S}*)?({REL_TOKEN}){S}*(?:"([^"]*)"{S}*)?({ID})(?:{S}*:{S}*({DOT}+))?\\Z'
)
REL_TOKEN_TO_KIND = {
    "..|>": "realization",
    "<|--": "inheritance",
    "*--": "composition",
    "o--": "aggregation",
    "-->": "association",
    "..>": "dependency",
    "--": "link-solid",
    "..": "link-dashed",
    "()--": "lollipop-source",
    "--()": "lollipop-target",
}
REL_KIND_TO_TOKEN = {kind: token for token, kind in REL_TOKEN_TO_KIND.items()}
UML_RELATION_KINDS = (
    "inheritance",
    "composition",
    "aggregation",
    "association",
    "link-solid",
    "dependency",
    "realization",
    "link-dashed",
    "lollipop-source",
    "lollipop-target",
)

NOTE_FOR = re.compile(f'^note{S}+for{S}+({ID}){S}+"([^"]*)"\\Z')
NOTE_STANDALONE = re.compile(f'^note{S}+"([^"]*)"\\Z')
NAMESPACE_START = re.compile(f'^namespace{S}+({ID}(?:\\.{ID})*)(?:\\["([^"]*)"\\])?{S}*\\{{\\Z')

# re.ASCII: JavaScript's /i (no u flag) folds only ASCII letters here; Python's would also fold U+0130/U+0131 to "i".
DIRECTION_PATTERN = re.compile(f"^direction{S}+(TB|BT|LR|RL)\\Z", re.IGNORECASE | re.ASCII)
TITLE_PATTERN = re.compile(f"^title{S}+({DOT}+)\\Z")
ACC_TITLE_PATTERN = re.compile(f"^accTitle{S}*:{S}*({DOT}+)\\Z")
ACC_DESCR_PATTERN = re.compile(f"^accDescr{S}*:{S}*({DOT}+)\\Z")
MERMAID_CONFIG_DIRECTIVE_PATTERN = re.compile(f"^%%\\{{{DOT}*\\}}%%\\Z")

STYLE_DIRECTIVE = re.compile(f"^style{S}+({ID}){S}+({DOT}+)\\Z")
CLASSDEF_DIRECTIVE = re.compile(f"^classDef{S}+({ID}){S}+({DOT}+?);?\\Z")
CLASS_ASSIGN_DIRECTIVE = re.compile(f"^class{S}+((?:{ID})(?:{S}*,{S}*{ID})*){S}+({ID}){S}*;?\\Z")
CLASS_SHORTHAND = re.compile(f"^({ID}):::({ID}(?:{S}*,{S}*{ID})*)\\Z")

_LINE_SPLIT = re.compile(r"\r?\n")
_SPACES = re.compile(f"{S}+")
_VISIBILITY = re.compile(r"^[+\-#~]")


def _split_member_modifier(text: str) -> tuple[str, bool, bool]:
    trimmed = js_trim(text)
    if trimmed.endswith("$"):
        return js_trim(trimmed[:-1]), True, False
    if trimmed.endswith("*"):
        return js_trim(trimmed[:-1]), False, True
    return trimmed, False, False


def _parse_member_line(raw_line: str) -> dict[str, Any] | None:
    remainder = js_trim(raw_line)
    if not remainder:
        return None
    visibility = None
    if _VISIBILITY.match(remainder):
        visibility = remainder[0]
        remainder = js_trim(remainder[1:])
    if not remainder:
        return None

    paren_index = remainder.find("(")
    if paren_index != -1:
        close_index = remainder.find(")", paren_index)
        if close_index == -1:
            return None
        name = js_trim(remainder[:paren_index])
        params = js_trim(remainder[paren_index + 1 : close_index])
        if not name:
            return None
        return_type, is_static, is_abstract = _split_member_modifier(remainder[close_index + 1 :])
        return {
            "kind": "method",
            "visibility": visibility,
            "name": name,
            "params": params,
            "returnType": return_type or None,
            "isStatic": is_static or None,
            "isAbstract": is_abstract or None,
        }

    core, is_static, is_abstract = _split_member_modifier(remainder)
    parts = [p for p in _SPACES.split(core) if p]
    if not parts:
        return None
    if len(parts) == 1:
        return {
            "kind": "attribute",
            "visibility": visibility,
            "name": parts[0],
            "isStatic": is_static or None,
            "isAbstract": is_abstract or None,
        }
    return {
        "kind": "attribute",
        "visibility": visibility,
        "name": parts[-1],
        "type": " ".join(parts[:-1]),
        "isStatic": is_static or None,
        "isAbstract": is_abstract or None,
    }


def _js_text(value: Any) -> str:
    """A value in a template literal: `${value}`."""
    if value is None:
        return "undefined"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _js_truthy(value: Any) -> bool:
    """JavaScript truthiness for JSON/YAML values ([] and {} are truthy, 0 and "" are not)."""
    if isinstance(value, dict | list):
        return True
    return bool(value)


def _prop(value: Any, key: str) -> Any:
    """`value.key` on a YAML value (undefined unless it's an object)."""
    return value.get(key) if isinstance(value, dict) else None


def _serialize_member_line(member: dict[str, Any]) -> str:
    visibility = member.get("visibility") or ""
    modifier = "$" if member.get("isStatic") else "*" if member.get("isAbstract") else ""
    if member.get("kind") == "method":
        return_part = f" {member['returnType']}" if member.get("returnType") else ""
        params = member.get("params")
        return (
            f"  {visibility}{_js_text(member.get('name'))}({'' if params is None else params}){return_part}{modifier}"
        )
    type_part = f"{member['type']} " if member.get("type") else ""
    return f"  {visibility}{type_part}{_js_text(member.get('name'))}{modifier}"


def parse_uml(dsl: str) -> dict[str, Any]:
    front_matter, body = split_front_matter(dsl)
    canvas = canvas_section(front_matter)
    positions = section(canvas, "positions")
    styles = section(canvas, "styles")
    container_meta = section(canvas, "containers")
    is_fresh_import = not positions and not container_meta
    placeholder = {"x": 0, "y": 0}
    auto = [0]

    def next_position() -> dict[str, float]:
        k = auto[0]
        auto[0] += 1
        return {"x": (k % 4) * 180 + 40, "y": (k // 4) * 140 + 40}

    def container_position(meta: Any) -> dict[str, Any]:
        if _js_truthy(meta):
            return {"x": _prop(meta, "x"), "y": _prop(meta, "y")}
        return placeholder if is_fresh_import else next_position()

    def container_size(meta: Any) -> dict[str, Any] | None:
        width, height = _prop(meta, "width"), _prop(meta, "height")
        return {"width": width, "height": height} if width is not None and height is not None else None

    lines = _LINE_SPLIT.split(body)
    errors: list[dict[str, Any]] = []
    nodes_by_id: dict[str, dict[str, Any]] = {}
    containers_by_id: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    header_seen = False
    inside_class_body: tuple[str, int, str] | None = None
    edge_counter = 0
    container_counter = 0
    direction = title = acc_title = acc_descr = config_directive = None
    namespace_stack: list[tuple[str, int, str]] = []
    class_defs: dict[str, dict[str, Any]] = {}
    class_assignments: list[tuple[list[str], str]] = []
    style_directives: list[tuple[str, str]] = []

    def current_namespace_id() -> str | None:
        return namespace_stack[-1][0] if namespace_stack else None

    def ensure_class(
        class_id: str, annotation: str | None = None, container_id: str | None = None, generic: str | None = None
    ) -> None:
        existing = nodes_by_id.get(class_id)
        if existing is None:
            position = positions.get(class_id)
            nodes_by_id[class_id] = {
                "id": class_id,
                "label": class_id,
                "shape": "rectangle",
                "role": "class",
                "position": position if position is not None else (placeholder if is_fresh_import else next_position()),
                "style": styles.get(class_id),
                "containerId": container_id,
                "umlStereotype": annotation,
                "umlGenericParameter": generic,
            }
            return
        if annotation is not None:
            existing["umlStereotype"] = annotation
        if generic is not None:
            existing["umlGenericParameter"] = generic

    for i, raw_line in enumerate(lines):
        line = js_trim(raw_line)
        if not line:
            continue
        if MERMAID_CONFIG_DIRECTIVE_PATTERN.match(line):
            config_directive = line
            continue
        line = strip_trailing_comment(line)
        if not line:
            continue

        if not header_seen:
            if line == "classDiagram":
                header_seen = True
                continue
            errors.append({"line": i + 1, "content": raw_line, "message": 'Expected "classDiagram" header line'})
            continue

        if inside_class_body is not None:
            if BLOCK_END.match(line):
                inside_class_body = None
                continue
            if m := BODY_ANNOTATION.match(line):
                nodes_by_id[inside_class_body[0]]["umlStereotype"] = m.group(1)
                continue
            member = _parse_member_line(line)
            if member is None:
                errors.append(
                    {
                        "line": i + 1,
                        "content": raw_line,
                        "message": f'Could not interpret line as a class member: "{line}"',
                    }
                )
                continue
            node = nodes_by_id[inside_class_body[0]]
            node["members"] = [*node["members"], member] if node.get("members") else [member]
            continue

        if m := DIRECTION_PATTERN.match(line):
            direction = m.group(1).upper()
            continue
        if m := TITLE_PATTERN.match(line):
            title = m.group(1)
            continue
        if m := ACC_TITLE_PATTERN.match(line):
            acc_title = m.group(1)
            continue
        if m := ACC_DESCR_PATTERN.match(line):
            acc_descr = m.group(1)
            continue

        if m := NAMESPACE_START.match(line):
            qualified_name, bracket_label = m.group(1), m.group(2)
            segments = qualified_name.split(".")
            parent_id = current_namespace_id()
            current_id = parent_id or ""
            for seg_idx, segment in enumerate(segments):
                current_id = f"{current_id}.{segment}" if current_id else segment
                is_leaf = seg_idx == len(segments) - 1
                existing = containers_by_id.get(current_id)
                if existing is None:
                    meta = container_meta.get(current_id)
                    containers_by_id[current_id] = {
                        "id": current_id,
                        "label": bracket_label if is_leaf and bracket_label is not None else segment,
                        "role": "namespace",
                        "position": container_position(meta),
                        "size": container_size(meta),
                        "parentContainerId": parent_id,
                    }
                elif is_leaf and bracket_label is not None:
                    existing["label"] = bracket_label
                parent_id = current_id
            namespace_stack.append((current_id, i + 1, raw_line))
            continue
        if namespace_stack and BLOCK_END.match(line):
            namespace_stack.pop()
            continue

        if m := NOTE_FOR.match(line):
            class_id, text = m.group(1), m.group(2)
            ensure_class(class_id, None, current_namespace_id())
            container_counter += 1
            note_id = f"note{container_counter}"
            meta = container_meta.get(note_id)
            containers_by_id[note_id] = {
                "id": note_id,
                "label": text,
                "role": "note",
                "attachedNodeIds": [class_id],
                "position": container_position(meta),
                "size": container_size(meta),
            }
            continue
        if m := NOTE_STANDALONE.match(line):
            container_counter += 1
            note_id = f"note{container_counter}"
            meta = container_meta.get(note_id)
            containers_by_id[note_id] = {
                "id": note_id,
                "label": m.group(1),
                "role": "note",
                "attachedNodeIds": [],
                "position": container_position(meta),
                "size": container_size(meta),
            }
            continue

        if m := STANDALONE_ANNOTATION.match(line):
            ensure_class(m.group(2), m.group(1), current_namespace_id())
            continue
        if m := CLASS_BLOCK_START.match(line):
            ensure_class(m.group(1), m.group(3), current_namespace_id(), m.group(2))
            inside_class_body = (m.group(1), i + 1, raw_line)
            continue
        if m := CLASS_DECL.match(line):
            ensure_class(m.group(1), m.group(3), current_namespace_id(), m.group(2))
            continue

        if m := STYLE_DIRECTIVE.match(line):
            style_directives.append((m.group(1), m.group(2)))
            continue
        if m := CLASSDEF_DIRECTIVE.match(line):
            class_defs[m.group(1)] = parse_style_props(m.group(2))
            continue
        if m := CLASS_ASSIGN_DIRECTIVE.match(line):
            class_assignments.append(([js_trim(x) for x in m.group(1).split(",")], m.group(2)))
            continue
        if m := CLASS_SHORTHAND.match(line):
            ensure_class(m.group(1), None, current_namespace_id())
            class_assignments.append(([m.group(1)], js_trim(m.group(2).split(",")[0])))
            continue

        if m := RELATIONSHIP.match(line):
            source, source_card, token, target_card, target, label = m.groups()
            ensure_class(source, None, current_namespace_id())
            ensure_class(target, None, current_namespace_id())
            edge_counter += 1
            edges.append(
                {
                    "id": f"e{edge_counter}",
                    "sourceId": source,
                    "targetId": target,
                    "label": label,
                    "umlRelationKind": REL_TOKEN_TO_KIND[token],
                    "sourceCardinality": source_card,
                    "targetCardinality": target_card,
                }
            )
            continue

        errors.append(
            {
                "line": i + 1,
                "content": raw_line,
                "message": f'Could not interpret line as a class, relationship, or directive: "{line}"',
            }
        )

    if inside_class_body is not None:
        body_id, body_line, body_content = inside_class_body
        errors.append(
            {
                "line": body_line,
                "content": body_content,
                "message": f"Unclosed class body for '{body_id}' opened at line {body_line}",
            }
        )
    for _, open_line, open_content in namespace_stack:
        errors.append(
            {
                "line": open_line,
                "content": open_content,
                "message": f"Unclosed 'namespace' block opened at line {open_line}",
            }
        )

    if errors:
        return {"errors": errors}

    for class_ids, class_name in class_assignments:
        class_style = class_defs.get(class_name)
        if class_style is None:
            continue
        for class_id in class_ids:
            styled = nodes_by_id.get(class_id)
            if styled is None:
                continue
            styled["style"] = {**(styled.get("style") or {}), **class_style}
    for class_id, props_raw in style_directives:
        styled = nodes_by_id.get(class_id)
        if styled is None:
            continue
        styled["style"] = {**(styled.get("style") or {}), **parse_style_props(props_raw)}

    if is_fresh_import:
        all_nodes = list(nodes_by_id.values())
        all_containers = list(containers_by_id.values())
        node_positions, container_positions, container_sizes = compute_containment_layout(all_nodes, all_containers)
        for node in all_nodes:
            node["position"] = node_positions.get(node["id"], node["position"])
        for container in all_containers:
            container["position"] = container_positions.get(container["id"], container["position"])
            container["size"] = container_sizes.get(container["id"])

    model = create_empty_diagram_model("uml")
    model.update(
        {
            "nodes": list(nodes_by_id.values()),
            "edges": edges,
            "containers": list(containers_by_id.values()),
            "direction": direction,
            "title": title,
            "accTitle": acc_title,
            "accDescr": acc_descr,
            "mermaidConfigDirective": config_directive,
            "legend": read_legend(front_matter),
        }
    )
    return {"model": model}


# --- serializing -----------------------------------------------------------------------------------


def _entries(pairs: list[tuple[Any, Any]]) -> dict[str, Any]:
    """Object.fromEntries: a later duplicate key replaces the value but keeps the first position."""
    out: dict[str, Any] = {}
    for key, value in pairs:
        out[_js_text(key)] = value
    return out


def _container_meta(container: dict[str, Any]) -> dict[str, Any]:
    position = container["position"]
    size = container.get("size")
    if size:
        return {"x": position["x"], "y": position["y"], "width": size["width"], "height": size["height"]}
    return {"x": position["x"], "y": position["y"]}


def serialize_uml(model: dict[str, Any]) -> str:
    nodes = model.get("nodes") or []
    edges = model.get("edges") or []
    containers = model.get("containers") or []
    front_matter = {
        "canvas": {
            "positions": _entries([(n["id"], n.get("position")) for n in nodes]),
            "styles": _entries([(n["id"], n["style"]) for n in nodes if n.get("style")]),
            "containers": _entries([(c["id"], _container_meta(c)) for c in containers]),
        }
    }

    lines = ["classDiagram"]
    if model.get("title"):
        lines.append(f"title {model['title']}")
    if model.get("mermaidConfigDirective"):
        lines.insert(0, model["mermaidConfigDirective"])
    if model.get("accTitle"):
        lines.append(f"accTitle: {model['accTitle']}")
    if model.get("accDescr"):
        lines.append(f"accDescr: {model['accDescr']}")
    if model.get("direction"):
        lines.append(f"direction {model['direction']}")

    def class_lines(node: dict[str, Any]) -> list[str]:
        generic_part = f"~{node['umlGenericParameter']}~" if node.get("umlGenericParameter") else ""
        annotation_part = f" <<{node['umlStereotype']}>>" if node.get("umlStereotype") else ""
        members = node.get("members")
        if not members:
            return [f"class {node['id']}{generic_part}{annotation_part}"]
        return [
            f"class {node['id']}{generic_part}{annotation_part} {{",
            *(_serialize_member_line(member) for member in members),
            "}",
        ]

    def emit_namespace(container: dict[str, Any]) -> list[str]:
        short_name = container["id"].split(".")[-1]
        label = container.get("label")
        header = (
            f'namespace {short_name}["{_js_text(label)}"] {{' if label != short_name else f"namespace {short_name} {{"
        )
        out = [header]
        for node in nodes:
            if node.get("containerId") == container["id"]:
                out.extend(f"  {line}" for line in class_lines(node))
        for child in containers:
            if child.get("role") == "namespace" and child.get("parentContainerId") == container["id"]:
                out.extend(f"  {line}" for line in emit_namespace(child))
        out.append("}")
        return out

    namespace_ids = {c["id"] for c in containers if c.get("role") == "namespace"}
    namespaced_node_ids = {n["id"] for n in nodes if n.get("containerId") in namespace_ids}
    for container in containers:
        if container.get("role") == "namespace" and not container.get("parentContainerId"):
            lines.extend(emit_namespace(container))
    for node in nodes:
        if node["id"] in namespaced_node_ids:
            continue
        lines.extend(class_lines(node))
    for edge in edges:
        kind = edge.get("umlRelationKind")
        token = (REL_KIND_TO_TOKEN.get(kind) if kind else None) or REL_KIND_TO_TOKEN["association"]
        source_part = (
            f'{edge["sourceId"]} "{edge["sourceCardinality"]}"' if edge.get("sourceCardinality") else edge["sourceId"]
        )
        target_part = (
            f'"{edge["targetCardinality"]}" {edge["targetId"]}' if edge.get("targetCardinality") else edge["targetId"]
        )
        label_part = f" : {edge['label']}" if edge.get("label") else ""
        lines.append(f"{source_part} {token} {target_part}{label_part}")
    for container in containers:
        if container.get("role") != "note":
            continue
        attached = container.get("attachedNodeIds")
        if attached:
            lines.append(f'note for {attached[0]} "{_js_text(container.get("label"))}"')
        else:
            lines.append(f'note "{_js_text(container.get("label"))}"')

    return join_front_matter(with_legend(front_matter, model), "\n".join(lines) + "\n")
