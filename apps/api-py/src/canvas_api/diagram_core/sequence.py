"""Mermaid sequenceDiagram (packages/diagram-core/src/dsl/sequence.ts).

A line-by-line port: the same regular expressions (JavaScript's `\\s`, `.` and `\\d` spelled out), tried in the
same order. Positions are never read or written for this family: the renderer computes the layout from declaration
and message order (canvas-7vs.1), so every element gets a placeholder position. Styles do round-trip through the
front matter. Parse returns {"model": ...} or {"errors": [...]}, never raises (bad YAML front matter excepted, as
in TypeScript). As in flowchart.py, None in a model stands for JavaScript's `undefined`.
"""

from __future__ import annotations

import json
import re
from typing import Any

from canvas_api.diagram_core.front_matter import (
    apply_links,
    canvas_section,
    join_front_matter,
    section,
    split_front_matter,
    strip_trailing_comment,
    with_links,
)
from canvas_api.diagram_core.jsvalues import js_parse_float, js_truthy
from canvas_api.diagram_core.jsyaml import js_key_order
from canvas_api.diagram_core.mermaid_shape_data import data_entries, format_shape_data, parse_shape_data
from canvas_api.diagram_core.model import create_empty_diagram_model, is_allowed_link_href
from canvas_api.github.jstext import JS_WHITESPACE, js_len, js_number, js_trim

__all__ = ["parse_sequence", "serialize_sequence"]

S = f"[{JS_WHITESPACE}]"  # JavaScript's \s
DOT = "[^\\n\\r\\u2028\\u2029]"  # JavaScript's .
ID = "[A-Za-z0-9_]+"

#: canvas-lwa4: `participant API@{ "type": "database" }` (sequence.ts PARTICIPANT_DATA): the block is the
#: participant's `mermaidData`; its `type` sets the shape drawn, its `alias` the label unless an `as` alias other
#: than the id is given.
PARTICIPANT_DATA = f"(?:{S}*@\\{{([^{{}}]*)\\}})?"
PARTICIPANT_PATTERN = re.compile(f"^(participant|actor){S}+({ID}){PARTICIPANT_DATA}(?:{S}+as{S}+({DOT}+))?\\Z")
PARTICIPANT_TYPE_SHAPES = {
    "participant": "rectangle",
    "actor": "person",
    "boundary": "circle",
    "control": "circle",
    "entity": "circle",
    "database": "cylinder",
    "collections": "rectangle",
    "queue": "stadium",
}


def _participant_shape(node: dict[str, Any]) -> str:
    """The shape a participant is drawn as: its Mermaid type when it has one, else its keyword's."""
    data = node.get("mermaidData")
    participant_type = data.get("type") if isinstance(data, dict) else None
    if participant_type is not None:
        return (PARTICIPANT_TYPE_SHAPES.get(participant_type) if isinstance(participant_type, str) else None) or (
            "rectangle"
        )
    return "person" if node.get("role") == "actor" else "rectangle"


#: Each literal token is distinct, so the alternation order only matters as it does in JavaScript (same order).
#: canvas-8wxq: Mermaid 11.12's half arrows (sequence.ts HALF_ARROW_TOKENS); `--` for the dotted form.
HALF_ARROW_TOKENS = {
    "-|\\": "half-top",
    "-|/": "half-bottom",
    "/|-": "half-top-reverse",
    "\\|-": "half-bottom-reverse",
    "-\\\\": "stick-top",
    "-//": "stick-bottom",
    "//-": "stick-top-reverse",
    "\\\\-": "stick-bottom-reverse",
}


def _dotted(token: str) -> str:
    return f"-{token}" if token.startswith("-") else f"{token}-"


HALF_ARROW_ALTERNATIVES = [re.escape(t) for token in HALF_ARROW_TOKENS for t in (_dotted(token), token)]
ARROW_TOKEN = "|".join([*HALF_ARROW_ALTERNATIVES, r"<<-->>|<<->>|-->>|->>|--x|-x|--\)|-\)|-->|->"])
#: '+' activates the TARGET, '-' deactivates the SOURCE (Mermaid's sequenceDiagram.jison). canvas-8wxq: `()` on
#: either side of the arrow is a central connection.
MESSAGE_PATTERN = re.compile(f"^({ID}){S}*(\\(\\))?({ARROW_TOKEN})(\\(\\))?{S}*([+-])?{S}*({ID}){S}*:{S}*({DOT}+)\\Z")
NS = f"[^{JS_WHITESPACE}]"  # JavaScript's \S
#: canvas-8wxq: participant link menus.
LINK_PATTERN = re.compile(f"^link{S}+({ID}){S}*:{S}*({DOT}+?){S}*@{S}*({NS}+)\\Z")
LINKS_PATTERN = re.compile(f"^links{S}+({ID}){S}*:{S}*(\\{{{DOT}*\\}})\\Z")
_HAS_SPACE = re.compile(S)
_HAS_LINE_BREAK = re.compile("[\\r\\n]")
ARROW_TOKEN_TO_STYLE: dict[str, tuple[str, str]] = {  # token -> (lineStyle, arrow)
    **{
        t: (style, arrow)
        for token, arrow in HALF_ARROW_TOKENS.items()
        for t, style in ((token, "solid"), (_dotted(token), "dotted"))
    },
    "<<-->>": ("dotted", "both"),
    "<<->>": ("solid", "both"),
    "-->>": ("dotted", "target"),
    "->>": ("solid", "target"),
    "--x": ("dotted", "cross"),
    "-x": ("solid", "cross"),
    "--)": ("dotted", "open"),
    "-)": ("solid", "open"),
    "-->": ("dotted", "none"),
    "->": ("solid", "none"),
}
NOTE_PATTERN = re.compile(f"^Note{S}+(left of|right of|over){S}+([^:]+?){S}*:{S}*({DOT}*)\\Z")
BLOCK_START = re.compile(f"^(loop|alt|opt|par|critical|break|rect)(?:{S}+({DOT}+))?\\Z")
BRANCH_PATTERN = re.compile(f"^(else|and|option)(?:{S}+({DOT}+))?\\Z")
BLOCK_END = re.compile(r"^end\Z")
TOP_LEVEL_BLOCK_KEYWORDS = {"loop", "alt", "opt", "par", "critical", "break", "rect"}
NOTE_POSITION_TO_ROLE = {"left of": "note-left", "right of": "note-right", "over": "note-over"}
ACTIVATE_PATTERN = re.compile(f"^activate{S}+({ID})\\Z")
DEACTIVATE_PATTERN = re.compile(f"^deactivate{S}+({ID})\\Z")
CREATE_PATTERN = re.compile(f"^create{S}+(participant|actor){S}+({ID}){PARTICIPANT_DATA}(?:{S}+as{S}+({DOT}+))?\\Z")
DESTROY_PATTERN = re.compile(f"^destroy{S}+({ID})\\Z")
#: Only rgb()/rgba()/transparent are read as the box's color; a named color is part of the title.
BOX_START = re.compile(f"^box(?:{S}+(rgba?\\([^)]*\\)|transparent))?(?:{S}+({DOT}+))?\\Z")
#: canvas-lwa4: `autonumber <start>` too, and numbers as Mermaid's NUM token reads them (two decimals at most).
AUTONUMBER_NUM = "([0-9]+(?:\\.[0-9]{1,2})?|\\.[0-9]{1,2})"
AUTONUMBER_PATTERN = re.compile(f"^autonumber(?:{S}+(off)|{S}+{AUTONUMBER_NUM}(?:{S}+{AUTONUMBER_NUM})?)?\\Z")
TITLE_PATTERN = re.compile(f"^title{S}+({DOT}+)\\Z")
ACC_TITLE_PATTERN = re.compile(f"^accTitle{S}*:{S}*({DOT}+)\\Z")
ACC_DESCR_PATTERN = re.compile(f"^accDescr{S}*:{S}*({DOT}+)\\Z")
MERMAID_CONFIG_DIRECTIVE_PATTERN = re.compile(f"^%%\\{{{DOT}*\\}}%%\\Z")
_LINE_SPLIT = re.compile(r"\r?\n")
_BRACE = re.compile("[{}]")


def _placeholder() -> dict[str, float]:
    return {"x": 0, "y": 0}


def _note_size(text: str) -> dict[str, float]:
    return {"width": max(100, min(260, js_len(text) * 7 + 20)), "height": 50}


def _truthy(value: Any) -> bool:
    """JavaScript truthiness (an empty object or list is truthy there)."""
    if value is None or value is False:
        return False
    if isinstance(value, dict | list):
        return True
    if isinstance(value, float) and value != value:
        return False
    return bool(value)


def parse_sequence(dsl: str) -> dict[str, Any]:
    front_matter, body = split_front_matter(dsl)
    canvas = canvas_section(front_matter)
    styles = section(canvas, "styles")
    edge_styles = section(canvas, "edgeStyles")

    lines = _LINE_SPLIT.split(body)
    errors: list[dict[str, Any]] = []
    nodes_by_id: dict[str, dict[str, Any]] = {}
    containers_by_id: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    header_seen = False
    edge_counter = 0
    counters = {"container": 0, "order": 0}
    autonumber: dict[str, Any] | None = None
    title: str | None = None
    acc_title: str | None = None
    acc_descr: str | None = None
    config_directive: str | None = None
    # Open loop/alt/opt/par/critical/break/rect blocks; "child" is the latest else/and/option branch.
    block_stack: list[dict[str, Any]] = []
    open_box: dict[str, Any] | None = None

    def current_container_id() -> str | None:
        if not block_stack:
            return None
        top = block_stack[-1]
        child: str | None = top.get("child")
        return child if child is not None else top["id"]

    def next_order() -> int:
        order = counters["order"]
        counters["order"] += 1
        return order

    def ensure_participant(
        node_id: str,
        kind: str = "participant",
        alias: str | None = None,
        box_id: str | None = None,
        data: dict[str, Any] | None = None,
    ) -> None:
        node = nodes_by_id.get(node_id)
        if node is None:
            node = {
                "id": node_id,
                "label": alias if alias is not None else node_id,
                "shape": "person" if kind == "actor" else "rectangle",
                "role": kind,
                "position": _placeholder(),
                "containerId": box_id,
            }
            nodes_by_id[node_id] = node
        else:
            if alias is not None:
                node["label"] = alias
            if kind == "actor":
                node["role"] = "actor"
                node["shape"] = "person"
        if data is not None:
            node["mermaidData"] = data
            data_alias = data.get("alias")
            if (alias is None or alias == node_id) and isinstance(data_alias, str) and data_alias != "":
                node["label"] = data_alias
        if node.get("mermaidData") is not None:
            node["shape"] = _participant_shape(node)

    def read_participant_data(inner: str | None, line_number: int, content: str) -> tuple[bool, dict[str, Any] | None]:
        """(read, the participant's `@{ ... }` block or None without one); read is False when the block is malformed
        (the error is recorded)."""
        if inner is None:
            return True, None
        read = parse_shape_data(inner)
        if "error" in read:
            errors.append(
                {
                    "line": line_number,
                    "content": content,
                    "message": f"Could not read the participant's @{{ … }} block: {read['error']}",
                }
            )
            return False, None
        return True, _entries(read["entries"])

    def push_point_item(role: str, participant_id: str) -> None:
        counters["container"] += 1
        item_id = f"pt{counters['container']}"
        containers_by_id[item_id] = {
            "id": item_id,
            "label": "",
            "role": role,
            "attachedNodeIds": [participant_id],
            "position": _placeholder(),
            "parentContainerId": current_container_id(),
            "sequenceOrder": next_order(),
        }

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
            if line == "sequenceDiagram":
                header_seen = True
                continue
            errors.append({"line": i + 1, "content": raw_line, "message": 'Expected "sequenceDiagram" header line'})
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

        if open_box is not None:
            if BLOCK_END.match(line):
                open_box = None
                continue
            if m := PARTICIPANT_PATTERN.match(line):
                read, data = read_participant_data(m.group(3), i + 1, raw_line)
                if read:
                    ensure_participant(m.group(2), m.group(1), m.group(4), open_box["id"], data)
                continue
            errors.append(
                {
                    "line": i + 1,
                    "content": raw_line,
                    "message": f'Could not interpret line as a participant/actor inside a "box" block: "{line}"',
                }
            )
            continue

        if m := AUTONUMBER_PATTERN.match(line):
            off, start, step = m.group(1), m.group(2), m.group(3)
            autonumber = (
                None
                if off
                else {
                    "start": js_parse_float(start) if start else None,
                    "step": js_parse_float(step) if step else None,
                }
            )
            continue

        if m := BOX_START.match(line):
            color, box_title = m.group(1), m.group(2)
            counters["container"] += 1
            box_id = f"box{counters['container']}"
            containers_by_id[box_id] = {
                "id": box_id,
                "label": box_title if box_title is not None else "",
                "role": "box",
                "position": _placeholder(),
                "style": {"fillColor": color} if color else None,
            }
            open_box = {"id": box_id, "line": i + 1, "content": raw_line}
            continue

        if m := NOTE_PATTERN.match(line):
            position, participant_list, text = m.group(1), m.group(2), m.group(3)
            participant_ids = [js_trim(p) for p in participant_list.split(",")]
            for participant_id in participant_ids:
                ensure_participant(participant_id)
            counters["container"] += 1
            note_id = f"note{counters['container']}"
            containers_by_id[note_id] = {
                "id": note_id,
                "label": text,
                "role": NOTE_POSITION_TO_ROLE[position],
                "attachedNodeIds": participant_ids,
                "position": _placeholder(),
                "size": _note_size(text),
                "parentContainerId": current_container_id(),
                "sequenceOrder": next_order(),
            }
            continue

        if m := ACTIVATE_PATTERN.match(line):
            ensure_participant(m.group(1))
            push_point_item("activate", m.group(1))
            continue
        if m := DEACTIVATE_PATTERN.match(line):
            ensure_participant(m.group(1))
            push_point_item("deactivate", m.group(1))
            continue
        if m := CREATE_PATTERN.match(line):
            read, data = read_participant_data(m.group(3), i + 1, raw_line)
            if not read:
                continue
            ensure_participant(m.group(2), m.group(1), m.group(4), None, data)
            push_point_item("create", m.group(2))
            continue
        if m := DESTROY_PATTERN.match(line):
            ensure_participant(m.group(1))
            push_point_item("destroy", m.group(1))
            continue

        if m := BLOCK_START.match(line):
            keyword, arg = m.group(1), m.group(2)
            counters["container"] += 1
            block_id = f"block{counters['container']}"
            is_rect = keyword == "rect"
            containers_by_id[block_id] = {
                "id": block_id,
                "label": "" if is_rect else (arg if arg is not None else ""),
                "role": keyword,
                "position": _placeholder(),
                "parentContainerId": current_container_id(),
                "sequenceOrder": next_order(),
                "style": {"fillColor": arg} if is_rect and arg else None,
            }
            block_stack.append({"id": block_id, "keyword": keyword, "line": i + 1, "content": raw_line})
            continue

        branch = BRANCH_PATTERN.match(line)
        if branch and block_stack:
            keyword, label = branch.group(1), branch.group(2)
            parent = block_stack[-1]
            counters["container"] += 1
            block_id = f"block{counters['container']}"
            containers_by_id[block_id] = {
                "id": block_id,
                "label": label if label is not None else "",
                "role": keyword,
                "position": _placeholder(),
                "parentContainerId": parent["id"],
                "sequenceOrder": next_order(),
            }
            parent["child"] = block_id
            continue

        if BLOCK_END.match(line):
            if not block_stack:
                errors.append(
                    {
                        "line": i + 1,
                        "content": raw_line,
                        "message": '"end" with no matching loop/alt/opt/par/critical/break/rect/box block',
                    }
                )
            else:
                block_stack.pop()
            continue

        if m := PARTICIPANT_PATTERN.match(line):
            read, data = read_participant_data(m.group(3), i + 1, raw_line)
            if read:
                ensure_participant(m.group(2), m.group(1), m.group(4), None, data)
            continue

        if m := LINK_PATTERN.match(line):
            participant_id, link_label, href = m.groups()
            if not is_allowed_link_href(href):
                errors.append({"line": i + 1, "content": raw_line, "message": _refused_link(href)})
                continue
            ensure_participant(participant_id)
            node = nodes_by_id[participant_id]
            node["sequenceLinks"] = [*(node.get("sequenceLinks") or []), {"label": link_label, "href": href}]
            continue

        if m := LINKS_PATTERN.match(line):
            participant_id, raw_json = m.groups()
            entries = _json_entries(raw_json)
            if entries is None or any(not isinstance(href, str) for _, href in entries):
                errors.append(
                    {
                        "line": i + 1,
                        "content": raw_line,
                        "message": 'links needs a JSON object of "label": "url" pairs.',
                    }
                )
                continue
            refused = next((href for _, href in entries if not is_allowed_link_href(href)), None)
            if refused is not None:
                errors.append({"line": i + 1, "content": raw_line, "message": _refused_link(refused)})
                continue
            ensure_participant(participant_id)
            node = nodes_by_id[participant_id]
            node["sequenceLinks"] = [
                *(node.get("sequenceLinks") or []),
                *({"label": link_label, "href": href} for link_label, href in entries),
            ]
            continue

        if m := MESSAGE_PATTERN.match(line):
            source, central_source, arrow_token, central_target, sign, target, label = m.groups()
            ensure_participant(source)
            ensure_participant(target)
            edge_counter += 1
            line_style, arrow = ARROW_TOKEN_TO_STYLE[arrow_token]
            edges.append(
                {
                    "id": f"e{edge_counter}",
                    "sourceId": source,
                    "targetId": target,
                    "label": label,
                    "sequenceOrder": next_order(),
                    "containerId": current_container_id(),
                    "arrow": arrow,
                    "lineStyle": line_style,
                    **({"centralSource": True} if central_source else {}),
                    **({"centralTarget": True} if central_target else {}),
                }
            )
            if sign == "+":
                push_point_item("activate", target)
            elif sign == "-":
                push_point_item("deactivate", source)
            continue

        errors.append(
            {
                "line": i + 1,
                "content": raw_line,
                "message": f'Could not interpret line as a participant, message, or directive: "{line}"',
            }
        )

    for block in block_stack:
        errors.append(
            {
                "line": block["line"],
                "content": block["content"],
                "message": f"Unclosed '{block['keyword']}' block opened at line {block['line']}",
            }
        )
    if open_box is not None:
        errors.append(
            {
                "line": open_box["line"],
                "content": open_box["content"],
                "message": f"Unclosed 'box' block opened at line {open_box['line']}",
            }
        )

    if errors:
        return {"errors": errors}

    for node_id, node in nodes_by_id.items():
        if _truthy(styles.get(node_id)):
            node["style"] = styles[node_id]
    for edge in edges:
        if _truthy(edge_styles.get(edge["id"])):
            edge["style"] = edge_styles[edge["id"]]

    model = create_empty_diagram_model("sequence")
    model["nodes"] = list(nodes_by_id.values())
    model["edges"] = edges
    model["containers"] = list(containers_by_id.values())
    if autonumber is not None:
        model["sequenceAutonumber"] = autonumber
    model["title"] = title
    model["accTitle"] = acc_title
    model["accDescr"] = acc_descr
    model["mermaidConfigDirective"] = config_directive
    # canvas-8uh1.1: participants only -- a block's or note's id is made up by the parser.
    apply_links(front_matter, {"nodes": model["nodes"], "containers": []})
    return {"model": model}


# --- serialize ------------------------------------------------------------------------------------------------

NOTE_ROLE_TO_KEYWORD = {"note-left": "Note left of", "note-right": "Note right of", "note-over": "Note over"}


def _central(on: Any) -> str:
    return "()" if js_truthy(on) else ""


def _refused_link(href: str) -> str:
    return f'Link "{href}" is not allowed: only http(s) URLs or relative paths.'


def _reject_constant(name: str) -> Any:
    raise ValueError(name)  # JSON.parse has no NaN or Infinity


def _json_entries(text: str) -> list[tuple[str, Any]] | None:
    """Object.entries(JSON.parse(text)) for an object (integer-like keys first, as JavaScript orders them); None
    when it isn't valid JSON or isn't an object."""
    try:
        parsed = json.loads(text, parse_constant=_reject_constant)
    except ValueError:
        return None
    if not isinstance(parsed, dict):
        return None
    return [(key, parsed[key]) for key in js_key_order(list(parsed))]


ARROW_STYLE_TO_TOKEN = {f"{arrow}|{line_style}": token for token, (line_style, arrow) in ARROW_TOKEN_TO_STYLE.items()}


def _t(value: Any) -> str:
    """A value in a template literal: `${value}`."""
    if value is None:
        return "undefined"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        return js_number(value)
    if isinstance(value, list):
        return ",".join("" if v is None else _t(v) for v in value)
    if isinstance(value, dict):
        return "[object Object]"
    return str(value)


def _first_attached(container: dict[str, Any]) -> str:
    """`container.attachedNodeIds?.[0] ?? ''`."""
    attached = container.get("attachedNodeIds")
    if not attached:
        return ""
    first = attached[0]
    return "" if first is None else _t(first)


def _participant_keyword(node: dict[str, Any] | None) -> str:
    return "actor" if node is not None and node.get("role") == "actor" else "participant"


def _participant_declaration(node: dict[str, Any]) -> str:
    """sequence.ts participantDeclaration: the keyword, the id, the `@{ ... }` block (its alias dropped when the label
    is back to the id) and `as <label>` when the label differs from what the declaration shows without it."""
    data = node.get("mermaidData")
    data_alias = data.get("alias") if isinstance(data, dict) else None
    entries = [(k, v) for k, v in data_entries(data) if not (isinstance(v, str) and _BRACE.search(v))]
    if node.get("label") == node.get("id"):
        entries = [(k, v) for k, v in entries if k != "alias"]
    has_alias = isinstance(data_alias, str) and data_alias != "" and any(k == "alias" for k, _ in entries)
    shown = data_alias if has_alias else node.get("id")
    block = format_shape_data(entries) if entries else ""
    as_part = f" as {_t(node.get('label'))}" if node.get("label") != shown else ""
    return f"{_participant_keyword(node)} {_t(node.get('id'))}{block}{as_part}"


def _serialize_container(container: dict[str, Any], model: dict[str, Any], indent: str) -> list[str]:
    role = container.get("role")
    if role in ("activate", "deactivate"):
        return [f"{indent}{role} {_first_attached(container)}"]
    if role == "create":
        participant_id = _first_attached(container)
        node = next((n for n in model["nodes"] if n.get("id") == participant_id), None)
        declaration = _participant_declaration(node) if node is not None else f"participant {participant_id}"
        return [f"{indent}create {declaration}"]
    if role == "destroy":
        return [f"{indent}destroy {_first_attached(container)}"]
    note_keyword = NOTE_ROLE_TO_KEYWORD.get(role) if _truthy(role) and isinstance(role, str) else None
    if note_keyword:
        participants = ", ".join("" if p is None else _t(p) for p in (container.get("attachedNodeIds") or []))
        return [f"{indent}{note_keyword} {participants}: {_t(container.get('label'))}"]
    if role == "rect":
        style = container.get("style") or {}
        color = style.get("fillColor")
        lines = [f"{indent}rect {_t(color) if color is not None else 'rgb(0, 0, 0)'}"]
        lines.extend(_emit_scope(container.get("id"), model, f"{indent}  "))
        lines.append(f"{indent}end")
        return lines
    label = f" {_t(container.get('label'))}" if _truthy(container.get("label")) else ""
    lines = [f"{indent}{_t(role)}{label}"]
    lines.extend(_emit_scope(container.get("id"), model, f"{indent}  "))
    if _truthy(role) and role in TOP_LEVEL_BLOCK_KEYWORDS:
        lines.append(f"{indent}end")
    return lines


def _emit_scope(container_id: Any, model: dict[str, Any], indent: str) -> list[str]:
    items: list[tuple[Any, list[str]]] = []
    for edge in model.get("edges") or []:
        if edge.get("containerId") == container_id:
            arrow = edge.get("arrow")
            line_style = edge.get("lineStyle")
            arrow_text = _t(arrow) if arrow is not None else "target"
            key = f"{arrow_text}|{_t(line_style) if line_style is not None else 'solid'}"
            token = ARROW_STYLE_TO_TOKEN.get(key, "->>")
            label = edge.get("label")
            order = edge.get("sequenceOrder")
            items.append(
                (
                    order if order is not None else 0,
                    [
                        f"{indent}{_t(edge.get('sourceId'))}{_central(edge.get('centralSource'))}{token}"
                        f"{_central(edge.get('centralTarget'))}{_t(edge.get('targetId'))}: "
                        f"{_t(label) if label is not None else ''}"
                    ],
                )
            )
    for container in model.get("containers") or []:
        if container.get("parentContainerId") == container_id and container.get("role") != "box":
            order = container.get("sequenceOrder")
            items.append((order if order is not None else 0, _serialize_container(container, model, indent)))
    items.sort(key=lambda item: item[0])  # stable, as Array.prototype.sort
    return [line for _, item_lines in items for line in item_lines]


def serialize_sequence(model: dict[str, Any]) -> str:
    nodes: list[dict[str, Any]] = model.get("nodes") or []
    edges: list[dict[str, Any]] = model.get("edges") or []
    containers: list[dict[str, Any]] = model.get("containers") or []
    model = {**model, "nodes": nodes, "edges": edges, "containers": containers}
    front_matter = {
        "canvas": {
            "styles": _entries([(n["id"], n["style"]) for n in nodes if _truthy(n.get("style"))]),
            "edgeStyles": _entries([(e["id"], e["style"]) for e in edges if _truthy(e.get("style"))]),
        }
    }

    lines = ["sequenceDiagram"]
    if _truthy(model.get("title")):
        lines.append(f"title {_t(model['title'])}")
    if _truthy(model.get("mermaidConfigDirective")):
        lines.insert(0, _t(model["mermaidConfigDirective"]))
    if _truthy(model.get("accTitle")):
        lines.append(f"accTitle: {_t(model['accTitle'])}")
    if _truthy(model.get("accDescr")):
        lines.append(f"accDescr: {_t(model['accDescr'])}")
    autonumber = model.get("sequenceAutonumber")
    if _truthy(autonumber):
        start = autonumber.get("start") if isinstance(autonumber, dict) else None
        step = autonumber.get("step") if isinstance(autonumber, dict) else None
        if start is not None:
            lines.append(f"autonumber {_t(start)} {_t(step)}" if step is not None else f"autonumber {_t(start)}")
        else:
            lines.append(f"autonumber 1 {_t(step)}" if step is not None else "autonumber")

    boxes = [c for c in containers if c.get("role") == "box"]
    box_ids = [b.get("id") for b in boxes]
    boxed_node_ids = {n.get("id") for n in nodes if n.get("containerId") in box_ids}
    created_node_ids = {
        node_id for c in containers if c.get("role") == "create" for node_id in (c.get("attachedNodeIds") or [])
    }
    for box in boxes:
        style = box.get("style") or {}
        color_part = f" {_t(style.get('fillColor'))}" if _truthy(style.get("fillColor")) else ""
        title_part = f" {_t(box.get('label'))}" if _truthy(box.get("label")) else ""
        lines.append(f"box{color_part}{title_part}")
        for node in nodes:
            if node.get("containerId") == box.get("id"):
                lines.append(f"  {_participant_declaration(node)}")
        lines.append("end")
    for node in nodes:
        if node.get("id") in boxed_node_ids or node.get("id") in created_node_ids:
            continue
        lines.append(_participant_declaration(node))
    # canvas-8wxq: participant link menus, one `link` line per entry.
    for node in nodes:
        for link in node.get("sequenceLinks") or []:
            href, link_label = link.get("href"), link.get("label")
            if (
                isinstance(href, str)
                and is_allowed_link_href(href)
                and not _HAS_SPACE.search(href)
                and not _HAS_LINE_BREAK.search(_t(link_label))
            ):
                lines.append(f"link {_t(node.get('id'))}: {_t(link_label)} @ {href}")
    lines.extend(_emit_scope(None, model, ""))

    return join_front_matter(
        with_links(front_matter, {"nodes": model["nodes"], "containers": []}), "\n".join(lines) + "\n"
    )


def _entries(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Object.fromEntries: a later duplicate key replaces the value but keeps the first position."""
    out: dict[str, Any] = {}
    for key, value in pairs:
        out[str(key)] = value
    return out
