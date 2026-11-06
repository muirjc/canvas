"""Mermaid erDiagram (packages/diagram-core/src/dsl/erd.ts).

A line-by-line port: the same regular expressions (JavaScript's `\\s`, `\\S` and `.` spelled out, `\\Z` for `$`),
tried in the same order, the same second pass for `class` then `style`, and the same front matter. Parse returns
{"model": ...} or {"errors": [...]}, never raises (bad YAML front matter excepted, as in TypeScript).
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
    read_pinned,
    section,
    split_front_matter,
    strip_trailing_comment,
    with_legend,
    with_pinned,
)
from canvas_api.diagram_core.model import create_empty_diagram_model
from canvas_api.diagram_core.read_order import in_read_order
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

PLAIN_ID = re.compile(f"^{ID}\\Z")
#: canvas-lwa4: a relationship end may be a quoted subgraph id (erd.ts END).
END = f'({ID}|"[^"]+")'
RELATIONSHIP_PATTERN = re.compile(f"^{END}{S}+([|o}}{{.-]+){S}+{END}{S}*:{S}*({DOT}+)\\Z")
#: canvas-lwa4: Mermaid 11.17 subgraphs (erd.ts SUBGRAPH_START).
SUBGRAPH_START = re.compile(f'^subgraph{S}+({ID}|"[^"]+")(?:{S}*\\[([^\\]]*)\\])?\\Z')
SUBGRAPH_END = re.compile("^end\\Z")
_TITLE_WORD = re.compile(f'"[^"]*"|[^{JS_WHITESPACE}"]+')
#: erd.ts titleText; JavaScript's \w is ASCII, and its \u0080-\uFFFF takes both halves of an astral character.
_PLAIN_TITLE = re.compile("^[A-Za-z0-9_\\-*\u0080-\U0010ffff]+(?: [A-Za-z0-9_\\-*\u0080-\U0010ffff]+)*\\Z")


def _title_words(text: str) -> str:
    """A subgraph title as Mermaid joins it: its words (a quoted word without its quotes) with single spaces."""
    return " ".join(word.replace('"', "") for word in _TITLE_WORD.findall(text))


def _er_name(value: Any) -> str:
    """erd.ts erName: a subgraph or relationship-end id, quoted when it isn't a plain id."""
    text = _js_text(value)
    if PLAIN_ID.match(text) or not isinstance(value, str):
        return text
    return '"' + value.replace('"', "") + '"'


def _title_text(label: Any) -> str:
    text = _js_text(label)
    return text if _PLAIN_TITLE.match(text) else '"' + text.replace('"', "") + '"'


def _stored_number(meta: Any, key: str) -> Any:
    """A stored place or size number (erd.ts `stored`): None unless the front matter holds a number there."""
    value = meta.get(key) if isinstance(meta, dict) else None
    return value if isinstance(value, int | float) and not isinstance(value, bool) else None


DEFAULT_ER_SOURCE_CARDINALITY = "||"
DEFAULT_ER_TARGET_CARDINALITY = "o{"
DEFAULT_CARDINALITY = f"{DEFAULT_ER_SOURCE_CARDINALITY}--{DEFAULT_ER_TARGET_CARDINALITY}"
ER_SOURCE_CARDINALITY_TOKENS = ("||", "|o", "}|", "}o")
ER_TARGET_CARDINALITY_TOKENS = ("||", "o|", "|{", "o{")
DEFAULT_RELATIONSHIP_LABEL = "relates to"
ENTITY_BLOCK_START = re.compile(f"^({ID}){S}*\\{{\\Z")
BLOCK_END = re.compile("^\\}\\Z")
#: canvas-lwa4: a type or name may be in backticks, so it can hold spaces (erd.ts ATTRIBUTE_WORD).
ATTRIBUTE_WORD = f"(`[^`]+`|[^{JS_WHITESPACE}`]{NS}*)"
ATTRIBUTE_LINE = re.compile(f'^{ATTRIBUTE_WORD}{S}+{ATTRIBUTE_WORD}(?:{S}+([^"]*?))?{S}*(?:"([^"]*)")?\\Z')
_NEEDS_BACKTICKS = re.compile(f'[{JS_WHITESPACE}"]')


def _unquote_word(word: str) -> str:
    return word[1:-1] if word.startswith("`") else word


def _attribute_word(word: Any) -> str:
    """erd.ts attributeWord: in backticks when it holds whitespace or a double quote (and no backtick)."""
    if isinstance(word, str) and _NEEDS_BACKTICKS.search(word) and "`" not in word:
        return f"`{word}`"
    return _js_text(word)


RECOGNIZED_KEYS = {"PK", "FK", "UK"}
ALIAS_BLOCK_START = re.compile(f"^({ID}){S}*\\[([^\\]]+)\\]{S}*\\{{\\Z")
ALIAS_PATTERN = re.compile(f"^({ID}){S}*\\[([^\\]]+)\\]\\Z")
BARE_ENTITY = re.compile(f"^({ID})\\Z")
# TD isn't Mermaid's here (only TB), but Auto Layout's top-down wrote it (canvas-rshf): read, written as TB.
DIRECTION_PATTERN = re.compile(f"^direction{S}+(TB|TD|BT|LR|RL)\\Z", _ASCII_I)
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
    container_meta = section(canvas, "containers")
    is_fresh_import = not positions and not container_meta
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
    # canvas-lwa4: subgraphs; membership is settled after reading (erd.ts).
    subgraphs_by_id: dict[str, dict[str, Any]] = {}
    subgraph_stack: list[dict[str, Any]] = []
    closed_subgraphs: list[tuple[str, list[str]]] = []
    declared_entities: dict[str, dict[str, Any]] = {}
    quoted_ends: list[dict[str, Any]] = []
    line_index = [0]

    def mention(entity_id: str) -> None:
        if subgraph_stack:
            subgraph_stack[-1]["mentions"].append(entity_id)

    def declare(entity_id: str) -> None:
        if entity_id not in declared_entities:
            declared_entities[entity_id] = {"line": line_index[0] + 1, "content": lines[line_index[0]]}
        mention(entity_id)

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
        line_index[0] = i
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
                    open_entity["id"],
                    {
                        "type": _unquote_word(attr_type),
                        "name": _unquote_word(name),
                        "keys": keys,
                        "comment": comment or None,
                    },
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

        if m := SUBGRAPH_START.match(line):
            raw_id, raw_title = m.group(1), m.group(2)
            subgraph_id = raw_id[1:-1] if raw_id.startswith('"') else raw_id
            if subgraph_id in subgraphs_by_id:
                errors.append(
                    {"line": i + 1, "content": raw_line, "message": f"Subgraph '{subgraph_id}' is declared twice"}
                )
            meta = container_meta.get(subgraph_id)
            x, y, width, height = (_stored_number(meta, key) for key in ("x", "y", "width", "height"))
            title_text = "" if raw_title is None else _title_words(raw_title)
            subgraphs_by_id[subgraph_id] = {
                "id": subgraph_id,
                "label": title_text or subgraph_id,
                "position": {"x": x, "y": y}
                if x is not None and y is not None
                else {"x": 0, "y": 0}
                if is_fresh_import
                else next_position(),
                "size": {"width": width, "height": height} if width is not None and height is not None else None,
                "parentContainerId": subgraph_stack[-1]["id"] if subgraph_stack else None,
            }
            subgraph_stack.append({"id": subgraph_id, "line": i + 1, "content": raw_line, "mentions": []})
            continue
        if subgraph_stack and SUBGRAPH_END.match(line):
            closed = subgraph_stack.pop()
            closed_subgraphs.append((closed["id"], closed["mentions"]))
            continue

        if m := DIRECTION_PATTERN.match(line):
            if subgraph_stack:
                subgraphs_by_id[subgraph_stack[-1]["id"]]["direction"] = m.group(1).upper()
            else:
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
            declare(m.group(1))
            open_entity = {"id": m.group(1), "line": i + 1, "content": raw_line}
            continue
        if m := ENTITY_BLOCK_START.match(line):
            ensure_entity(m.group(1))
            declare(m.group(1))
            open_entity = {"id": m.group(1), "line": i + 1, "content": raw_line}
            continue
        if m := CLASS_SHORTHAND.match(line):
            ensure_entity(m.group(1), m.group(2))
            declare(m.group(1))
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
            cardinality_token, raw_label = m.group(2), m.group(4)

            def end_name(raw: str, line_number: int = i + 1, content: str = raw_line) -> str:
                if not raw.startswith('"'):
                    ensure_entity(raw)
                    mention(raw)
                    return raw
                quoted_ends.append({"name": raw[1:-1], "line": line_number, "content": content})
                return raw[1:-1]

            source = end_name(m.group(1))
            target = end_name(m.group(3))
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
            declare(m.group(1))
            continue
        if m := BARE_ENTITY.match(line):
            ensure_entity(m.group(1))
            declare(m.group(1))
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
    for open_subgraph in subgraph_stack:
        errors.append(
            {
                "line": open_subgraph["line"],
                "content": open_subgraph["content"],
                "message": f"Unclosed subgraph '{open_subgraph['id']}' opened at line {open_subgraph['line']}",
            }
        )
    for quoted_end in quoted_ends:
        if quoted_end["name"] not in subgraphs_by_id:
            errors.append(
                {
                    "line": quoted_end["line"],
                    "content": quoted_end["content"],
                    "message": f'"{quoted_end["name"]}" is not a subgraph: only a subgraph\'s id may be quoted',
                }
            )
    for entity_id, where in declared_entities.items():
        if entity_id in subgraphs_by_id:
            errors.append({**where, "message": f"'{entity_id}' is both an entity and a subgraph"})

    if errors:
        return {"errors": errors}

    # A relationship end naming a subgraph is the subgraph, not an entity.
    for subgraph_id in subgraphs_by_id:
        nodes_by_id.pop(subgraph_id, None)
    for subgraph_id, mentions in closed_subgraphs:
        for entity_id in mentions:
            node = nodes_by_id.get(entity_id)
            if node is not None and node.get("containerId") is None:
                node["containerId"] = subgraph_id
    if is_fresh_import and subgraphs_by_id:
        all_nodes = list(nodes_by_id.values())
        all_containers = list(subgraphs_by_id.values())
        node_positions, container_positions, container_sizes = compute_containment_layout(all_nodes, all_containers)
        for node in all_nodes:
            node["position"] = node_positions.get(node["id"], node["position"])
        for container in all_containers:
            container["position"] = container_positions.get(container["id"], container["position"])
            container["size"] = container_sizes.get(container["id"])

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
            "containers": list(subgraphs_by_id.values()),
            "direction": direction,
            "title": title,
            "accTitle": acc_title,
            "accDescr": acc_descr,
            "mermaidConfigDirective": config_directive,
            "legend": read_legend(front_matter),
        }
    )
    if pinned := read_pinned(front_matter, model):
        model["pinned"] = pinned
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


def _container_meta(container: dict[str, Any]) -> dict[str, Any]:
    position = container["position"]
    size = container.get("size")
    if size:
        return {"x": position["x"], "y": position["y"], "width": size["width"], "height": size["height"]}
    return {"x": position["x"], "y": position["y"]}


def _declaration_for(node: dict[str, Any]) -> str:
    label = node.get("label")
    return f"{node['id']}[{_js_text(label)}]" if label != node["id"] else str(node["id"])


def serialize_erd(model: dict[str, Any]) -> str:
    """The model as Mermaid text, in the order reading it back gives (canvas-ra0g: see read_order)."""
    return _write_erd(in_read_order(model, parse_erd, _write_erd))


def _write_erd(model: dict[str, Any]) -> str:
    nodes = model.get("nodes") or []
    edges = model.get("edges") or []
    containers = model.get("containers") or []
    canvas: dict[str, Any] = {
        "positions": _entries([(n["id"], n.get("position")) for n in nodes]),
        "styles": _entries([(n["id"], n["style"]) for n in nodes if _js_truthy(n.get("style"))]),
    }
    if containers:
        canvas["containers"] = _entries([(c["id"], _container_meta(c)) for c in containers])
    front_matter = {"canvas": canvas}

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
        lines.append("direction " + ("TB" if model["direction"] == "TD" else str(model["direction"])))

    declared: set[str] = set()

    def attribute_block(node: dict[str, Any], indent: str) -> list[str]:
        out = [f"{indent}{_declaration_for(node)} {{"]
        for attribute in node.get("attributes") or []:
            keys = attribute.get("keys") or []
            keys_part = f" {', '.join(keys)}" if len(keys) > 0 else ""
            comment_part = f' "{attribute["comment"]}"' if _js_truthy(attribute.get("comment")) else ""
            words = f"{_attribute_word(attribute.get('type'))} {_attribute_word(attribute.get('name'))}"
            out.append(f"{indent}  {words}{keys_part}{comment_part}")
        out.append(f"{indent}}}")
        return out

    # canvas-lwa4: subgraph blocks first, each declaring its own entities (erd.ts writeSubgraph).
    container_ids = {c["id"] for c in containers}
    written: set[Any] = set()

    def write_subgraph(container: dict[str, Any], indent: str) -> None:
        if container["id"] in written:
            return
        written.add(container["id"])
        label = container.get("label")
        title = f" [{_title_text(label)}]" if _js_truthy(label) and label != container["id"] else ""
        lines.append(f"{indent}subgraph {_er_name(container['id'])}{title}")
        sub_direction = container.get("direction")
        if _js_truthy(sub_direction):
            lines.append(f"{indent}  direction " + ("TB" if sub_direction == "TD" else _js_text(sub_direction)))
        for node in nodes:
            if node.get("containerId") != container["id"] or node["id"] in declared:
                continue
            if node.get("attributes") or node.get("label") != node["id"]:
                lines.extend(attribute_block(node, f"{indent}  "))
            else:
                lines.append(f"{indent}  {node['id']}")
            declared.add(node["id"])
        for child in containers:
            if child.get("parentContainerId") == container["id"]:
                write_subgraph(child, f"{indent}  ")
        lines.append(f"{indent}end")

    for container in containers:
        parent = container.get("parentContainerId")
        if parent is None or parent not in container_ids:
            write_subgraph(container, "")
    for container in containers:
        write_subgraph(container, "")

    for node in nodes:
        if node["id"] not in declared and node.get("attributes"):
            lines.extend(attribute_block(node, ""))
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
        lines.append(f"{_er_name(edge['sourceId'])} {cardinality_token} {_er_name(edge['targetId'])} : {label_text}")
        declared.add(edge["sourceId"])
        declared.add(edge["targetId"])
    for node in nodes:
        if node["id"] not in declared:
            lines.append(_declaration_for(node))

    body = "\n".join(lines) + "\n"
    return join_front_matter(with_pinned(with_legend(front_matter, model), model), body)
