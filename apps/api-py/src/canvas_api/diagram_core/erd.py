"""Mermaid erDiagram (packages/diagram-core/src/dsl/erd.ts).

A line-by-line port: the same regular expressions (JavaScript's `\\s`, `\\S` and `.` spelled out, `\\Z` for `$`),
tried in the same order, the same second pass for `class` then `style`, and the same front matter. Parse returns
{"model": ...} or {"errors": [...]}, never raises (bad YAML front matter excepted, as in TypeScript).
"""

from __future__ import annotations

import re
from typing import Any

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

__all__ = [
    "DEFAULT_ER_SOURCE_CARDINALITY",
    "DEFAULT_ER_TARGET_CARDINALITY",
    "ER_SOURCE_CARDINALITY_TOKENS",
    "ER_TARGET_CARDINALITY_TOKENS",
    "parse_erd",
    "serialize_erd",
]

S = f"[{JS_WHITESPACE}]"  # JavaScript's \s
NS = f"[^{JS_WHITESPACE}]"  # JavaScript's \S
DOT = "[^\\n\\r\\u2028\\u2029]"  # JavaScript's .
ID = "[A-Za-z0-9_-]+"
#: JavaScript's /i without the u flag folds ASCII letters only; Python's IGNORECASE alone would also fold
#: U+017F (long s) to s and the Kelvin sign to k.
_ASCII_I = re.IGNORECASE | re.ASCII

RELATIONSHIP_PATTERN = re.compile(f"^({ID}){S}+([|o}}{{.-]+){S}+({ID}){S}*:{S}*({DOT}+)\\Z")
DEFAULT_ER_SOURCE_CARDINALITY = "||"
DEFAULT_ER_TARGET_CARDINALITY = "o{"
DEFAULT_CARDINALITY = f"{DEFAULT_ER_SOURCE_CARDINALITY}--{DEFAULT_ER_TARGET_CARDINALITY}"
ER_SOURCE_CARDINALITY_TOKENS = ("||", "|o", "}|", "}o")
ER_TARGET_CARDINALITY_TOKENS = ("||", "o|", "|{", "o{")
DEFAULT_RELATIONSHIP_LABEL = "relates to"
ENTITY_BLOCK_START = re.compile(f"^({ID}){S}*\\{{\\Z")
BLOCK_END = re.compile("^\\}\\Z")
ATTRIBUTE_LINE = re.compile(f'^({NS}+){S}+({NS}+)(?:{S}+([^"]*?))?{S}*(?:"([^"]*)")?\\Z')
RECOGNIZED_KEYS = {"PK", "FK", "UK"}
ALIAS_BLOCK_START = re.compile(f"^({ID}){S}*\\[([^\\]]+)\\]{S}*\\{{\\Z")
ALIAS_PATTERN = re.compile(f"^({ID}){S}*\\[([^\\]]+)\\]\\Z")
BARE_ENTITY = re.compile(f"^({ID})\\Z")
DIRECTION_PATTERN = re.compile(f"^direction{S}+(TB|BT|LR|RL)\\Z", _ASCII_I)
TITLE_PATTERN = re.compile(f"^title{S}+({DOT}+)\\Z")
ACC_TITLE_PATTERN = re.compile(f"^accTitle{S}*:{S}*({DOT}+)\\Z")
ACC_DESCR_PATTERN = re.compile(f"^accDescr{S}*:{S}*({DOT}+)\\Z")
MERMAID_CONFIG_DIRECTIVE_PATTERN = re.compile(f"^%%\\{{{DOT}*\\}}%%\\Z")
STYLE_DIRECTIVE = re.compile(f"^style{S}+({ID}){S}+({DOT}+)\\Z")
CLASSDEF_DIRECTIVE = re.compile(f"^classDef{S}+({ID}){S}+({DOT}+?);?\\Z")
CLASS_ASSIGN_DIRECTIVE = re.compile(f"^class{S}+((?:{ID})(?:{S}*,{S}*{ID})*){S}+({ID}){S}*;?\\Z")
CLASS_SHORTHAND = re.compile(f"^({ID})(?:{S}*\\[([^\\]]+)\\])?:::({ID}(?:{S}*,{S}*{ID})*)\\Z")
CARDINALITY_TOKEN = re.compile("^([|o{}]{2})(--|\\.\\.)([|o{}]{2})\\Z")
QUOTED_LABEL = re.compile('^"(.*)"\\Z', re.DOTALL)
_LINE_SPLIT = re.compile(r"\r?\n")


def _parse_cardinality_token(token: str) -> tuple[str, str, bool] | None:
    match = CARDINALITY_TOKEN.match(token)
    if not match:
        return None
    return match.group(1), match.group(3), match.group(2) == ".."


def _merge(base: Any, patch: dict[str, Any]) -> dict[str, Any]:
    """`{ ...base, ...patch }` where a patch value of undefined (None) still overwrites."""
    return {**(base or {}), **patch}


def _js_upper(text: str) -> str:
    """String.prototype.toUpperCase; only ever compared with PK/FK/UK, which no other letters upper-case to."""
    return text.upper()


def parse_erd(dsl: str) -> dict[str, Any]:
    front_matter, body = split_front_matter(dsl)
    canvas = canvas_section(front_matter)
    positions = section(canvas, "positions")
    styles = section(canvas, "styles")
    auto = [0]

    def next_position() -> dict[str, float]:
        k = auto[0]
        auto[0] += 1
        return {"x": (k % 4) * 200 + 40, "y": (k // 4) * 140 + 40}

    lines = _LINE_SPLIT.split(body)
    errors: list[dict[str, Any]] = []
    nodes_by_id: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    header_seen = False
    edge_counter = 0
    open_entity: dict[str, Any] | None = None
    direction = title = acc_title = acc_descr = config_directive = None
    class_defs: dict[str, dict[str, Any]] = {}
    class_assignments: list[tuple[list[str], str]] = []
    style_directives: list[tuple[str, str]] = []

    def ensure_entity(entity_id: str, alias_label: str | None = None) -> None:
        existing = nodes_by_id.get(entity_id)
        if existing is None:
            position = positions.get(entity_id)
            nodes_by_id[entity_id] = {
                "id": entity_id,
                "label": alias_label if alias_label is not None else entity_id,
                "shape": "rectangle",
                "role": "entity",
                "position": position if position is not None else next_position(),
                "style": styles.get(entity_id),
            }
        elif alias_label is not None:
            existing["label"] = alias_label

    def push_attribute(entity_id: str, attribute: dict[str, Any]) -> None:
        node = nodes_by_id[entity_id]
        node["attributes"] = [*node["attributes"], attribute] if node.get("attributes") else [attribute]

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
            if line == "erDiagram":
                header_seen = True
                continue
            errors.append({"line": i + 1, "content": raw_line, "message": 'Expected "erDiagram" header line'})
            continue

        if open_entity is not None:
            if BLOCK_END.match(line):
                open_entity = None
                continue
            if m := ATTRIBUTE_LINE.match(line):
                attr_type, name, constraints_raw, comment = m.group(1), m.group(2), m.group(3), m.group(4)
                keys = [
                    k
                    for k in (_js_upper(js_trim(k)) for k in (constraints_raw or "").split(","))
                    if k in RECOGNIZED_KEYS
                ]
                push_attribute(
                    open_entity["id"], {"type": attr_type, "name": name, "keys": keys, "comment": comment or None}
                )
                continue
            errors.append(
                {
                    "line": i + 1,
                    "content": raw_line,
                    "message": f'Could not interpret line as an entity attribute: "{line}"',
                }
            )
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

        if m := ALIAS_BLOCK_START.match(line):
            ensure_entity(m.group(1), m.group(2))
            open_entity = {"id": m.group(1), "line": i + 1, "content": raw_line}
            continue
        if m := ENTITY_BLOCK_START.match(line):
            ensure_entity(m.group(1))
            open_entity = {"id": m.group(1), "line": i + 1, "content": raw_line}
            continue
        if m := CLASS_SHORTHAND.match(line):
            ensure_entity(m.group(1), m.group(2))
            class_assignments.append(([m.group(1)], js_trim(m.group(3).split(",")[0])))
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

        if m := RELATIONSHIP_PATTERN.match(line):
            source, cardinality_token, target, raw_label = m.group(1), m.group(2), m.group(3), m.group(4)
            ensure_entity(source)
            ensure_entity(target)
            edge_counter += 1
            cardinality = _parse_cardinality_token(cardinality_token)
            quoted = QUOTED_LABEL.match(raw_label)
            edges.append(
                {
                    "id": f"e{edge_counter}",
                    "sourceId": source,
                    "targetId": target,
                    "label": quoted.group(1) if quoted else raw_label,
                    "erSourceCardinality": cardinality[0] if cardinality else None,
                    "erTargetCardinality": cardinality[1] if cardinality else None,
                    "lineStyle": "dotted" if cardinality and cardinality[2] else None,
                }
            )
            continue

        if m := ALIAS_PATTERN.match(line):
            ensure_entity(m.group(1), m.group(2))
            continue
        if m := BARE_ENTITY.match(line):
            ensure_entity(m.group(1))
            continue

        errors.append(
            {
                "line": i + 1,
                "content": raw_line,
                "message": f'Could not interpret line as an entity, relationship, or directive: "{line}"',
            }
        )

    if open_entity is not None:
        errors.append(
            {
                "line": open_entity["line"],
                "content": open_entity["content"],
                "message": f"Unclosed attribute block for entity '{open_entity['id']}' opened at line "
                f"{open_entity['line']}",
            }
        )

    if errors:
        return {"errors": errors}

    for entity_ids, class_name in class_assignments:
        class_style = class_defs.get(class_name)
        if not class_style:
            continue
        for entity_id in entity_ids:
            node = nodes_by_id.get(entity_id)
            if node is not None:
                node["style"] = _merge(node.get("style"), class_style)
    for entity_id, props_raw in style_directives:
        node = nodes_by_id.get(entity_id)
        if node is not None:
            node["style"] = _merge(node.get("style"), parse_style_props(props_raw))

    model = create_empty_diagram_model("erd")
    model.update(
        {
            "nodes": list(nodes_by_id.values()),
            "edges": edges,
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


def _js_text(value: Any) -> str:
    """A value in a template literal: `${value}` (undefined as "undefined")."""
    if value is None:
        return "undefined"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _js_truthy(value: Any) -> bool:
    """JavaScript truthiness: an empty object or array is truthy, unlike in Python."""
    if isinstance(value, dict | list):
        return True
    if isinstance(value, float) and value != value:
        return False
    return bool(value)


def _entries(pairs: list[tuple[Any, Any]]) -> dict[str, Any]:
    """Object.fromEntries: a later duplicate key replaces the value but keeps the first position."""
    out: dict[str, Any] = {}
    for key, value in pairs:
        out[str(key)] = value
    return out


def _declaration_for(node: dict[str, Any]) -> str:
    label = node.get("label")
    return f"{node['id']}[{_js_text(label)}]" if label != node["id"] else str(node["id"])


def serialize_erd(model: dict[str, Any]) -> str:
    nodes = model.get("nodes") or []
    edges = model.get("edges") or []
    front_matter = {
        "canvas": {
            "positions": _entries([(n["id"], n.get("position")) for n in nodes]),
            "styles": _entries([(n["id"], n["style"]) for n in nodes if _js_truthy(n.get("style"))]),
        }
    }

    lines = ["erDiagram"]
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

    declared: set[str] = set()
    for node in nodes:
        attributes = node.get("attributes")
        if attributes:
            lines.append(f"{_declaration_for(node)} {{")
            for attribute in attributes:
                keys = attribute.get("keys") or []
                keys_part = f" {', '.join(keys)}" if len(keys) > 0 else ""
                comment_part = f' "{attribute["comment"]}"' if _js_truthy(attribute.get("comment")) else ""
                lines.append(
                    f"  {_js_text(attribute.get('type'))} {_js_text(attribute.get('name'))}{keys_part}{comment_part}"
                )
            lines.append("}")
            declared.add(node["id"])
    for node in nodes:
        if node["id"] not in declared and node.get("label") != node["id"]:
            lines.append(_declaration_for(node))
            declared.add(node["id"])
    for edge in edges:
        line_token = ".." if edge.get("lineStyle") == "dotted" else "--"
        source_card, target_card = edge.get("erSourceCardinality"), edge.get("erTargetCardinality")
        cardinality_token = (
            f"{source_card}{line_token}{target_card}"
            if _js_truthy(source_card) and _js_truthy(target_card)
            else DEFAULT_CARDINALITY
        )
        label = edge.get("label")
        label_text = (js_trim(label) if isinstance(label, str) else "") or DEFAULT_RELATIONSHIP_LABEL
        lines.append(f"{edge['sourceId']} {cardinality_token} {edge['targetId']} : {label_text}")
        declared.add(edge["sourceId"])
        declared.add(edge["targetId"])
    for node in nodes:
        if node["id"] not in declared:
            lines.append(_declaration_for(node))

    body = "\n".join(lines) + "\n"
    return join_front_matter(with_legend(front_matter, model), body)
