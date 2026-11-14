"""Mermaid flowchart (packages/diagram-core/src/dsl/flowchart-parser.ts, flowchart-serializer.ts).

A line-by-line port: the same regular expressions (with JavaScript's `\\s` and `.` spelled out, since Python's
differ), tried in the same order, the same second passes for `class`, `style`, `click` and `linkStyle`, and the
same front matter. Parse returns {"model": ...} or {"errors": [...]}, never raises (bad YAML front matter
excepted, as in TypeScript).
"""

from __future__ import annotations

import re
from typing import Any

from canvas_api.diagram_core.containment_layout import compute_containment_layout
from canvas_api.diagram_core.front_matter import (
    apply_links,
    canvas_section,
    join_front_matter,
    read_legend,
    read_pinned,
    section,
    split_front_matter,
    strip_trailing_comment,
    with_legend,
    with_links,
    with_pinned,
)
from canvas_api.diagram_core.jsvalues import js_parse_float, js_parse_int, js_template, js_truthy
from canvas_api.diagram_core.mermaid_shape_data import (
    MAX_LINK_LENGTH,
    MERMAID_NAME,
    MERMAID_SHAPE_NAME,
    SHAPE_DATA_INNER_SOURCE,
    SHAPE_DATA_SOURCE,
    data_entries,
    format_shape_data,
    mermaid_shape_to_canvas,
    parse_shape_data,
)
from canvas_api.diagram_core.model import create_empty_diagram_model, is_allowed_link_href, url_protocol
from canvas_api.diagram_core.read_order import in_read_order
from canvas_api.github.jstext import JS_WHITESPACE, js_trim

_PLAIN_SUBGRAPH_ID = re.compile("^[A-Za-z0-9_]+\\Z")

__all__ = ["parse_flowchart", "serialize_flowchart"]

S = f"[{JS_WHITESPACE}]"  # JavaScript's \s
DOT = "[^\\n\\r\\u2028\\u2029]"  # JavaScript's .
ID = "[A-Za-z0-9_]+"

CLASS_SUFFIX_CAPTURE = f"(?::::({ID}(?:{S}*,{S}*{ID})*))?"


def _shape(open_: str, close: str) -> str:
    return f"^({ID}){open_}({DOT}+){close}{CLASS_SUFFIX_CAPTURE}$"


NODE_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("subroutine", re.compile(_shape(r"\[\[", r"\]\]"))),
    ("double-circle", re.compile(_shape(r"\(\(\(", r"\)\)\)"))),
    ("hexagon", re.compile(_shape(r"\{\{", r"\}\}"))),
    ("stadium", re.compile(_shape(r"\(\[", r"\]\)"))),
    ("cylinder", re.compile(_shape(r"\[\(", r"\)\]"))),
    ("parallelogram", re.compile(_shape(r"\[/", r"/\]"))),
    ("parallelogram-alt", re.compile(_shape(r"\[\\", r"\\\]"))),
    ("trapezoid", re.compile(_shape(r"\[/", r"\\\]"))),
    ("trapezoid-alt", re.compile(_shape(r"\[\\", r"/\]"))),
    ("asymmetric", re.compile(_shape(">", r"\]"))),
    ("circle", re.compile(_shape(r"\(\(", r"\)\)"))),
    ("diamond", re.compile(_shape(r"\{", r"\}"))),
    ("rounded-rectangle", re.compile(_shape(r"\(", r"\)"))),
    ("rectangle", re.compile(_shape(r"\[", r"\]"))),
]

_D = DOT
SHAPE_SUFFIX = (
    rf"\[\[{_D}+?\]\]|\(\(\({_D}+?\)\)\)|\{{\{{{_D}+?\}}\}}|\(\[{_D}+?\]\)|\[\({_D}+?\)\]|\[/{_D}+?/\]|"
    rf"\[\\{_D}+?\\\]|\[/{_D}+?\\\]|\[\\{_D}+?/\]|>{_D}+?\]|\(\({_D}+?\)\)|\{{{_D}+?\}}|\({_D}+?\)|\[{_D}+?\]"
)
CLASS_SUFFIX = f"(?::::{ID}(?:{S}*,{S}*{ID})*)?"
TOKEN = f"{ID}(?:(?:{SHAPE_SUFFIX})?{CLASS_SUFFIX}|{CLASS_SUFFIX}{SHAPE_DATA_SOURCE})"
#: Since Mermaid 12.3 an edge id may follow a shape with no space (`A[x]e1@--> B`); a bare id needs the space.
EDGE_ID = f"(?:(?:{S}+|(?<=[\\])}}]))({ID})@|{S}*)"
SHAPE_DATA_TOKEN = re.compile(f"^({ID})(?::::({ID}(?:{S}*,{S}*{ID})*))?@\\{{({SHAPE_DATA_INNER_SOURCE})\\}}$")

#: canvas-sfz7: Mermaid's link tokens (its flow lexer's LINK rule, less the x/o ends), any length; the arrowed
#: form of each line before its open one, so `--->` is never read as `---` + `>`.
CONNECTOR_ALTERNATION = "<-{2,}>|<={2,}>|<-\\.+->|-\\.+->|-\\.+-|-{2,}>|-{3,}|={2,}>|={3,}|~{3,}"


def _read_connector(token: str) -> tuple[str | None, str | None, int]:
    """(lineStyle, arrow, Mermaid length) of a link token, as Mermaid's destructEndLink works them out."""
    both = token.startswith("<")
    line = token[1 if both else 0 : -1]
    dots = line.count(".")
    length = min(dots if dots > 0 else len(line) - 1, MAX_LINK_LENGTH)
    if token.startswith("~"):
        line_style: str | None = "invisible"
    elif "=" in line:
        line_style = "thick"
    else:
        line_style = "dotted" if dots > 0 else None
    arrow = "both" if both else None if token.endswith(">") else "none"
    return line_style, arrow, length


EDGE_WITH_PIPE_LABEL = re.compile(f"^({TOKEN}){EDGE_ID}({CONNECTOR_ALTERNATION}){S}*\\|({DOT}+?)\\|{S}*({TOKEN})$")
#: The opener can't start a longer link and the label can't hold a whole one (canvas-sfz7).
LABEL_TEXT = f"(?:(?!{CONNECTOR_ALTERNATION}){DOT})+?"
EDGE_INLINE_LABEL_SOLID = re.compile(
    f"^({TOKEN}){EDGE_ID}--(?![->]){S}*({LABEL_TEXT}){S}*(-{{2,}}>|-{{3,}}){S}*({TOKEN})$"
)
EDGE_INLINE_LABEL_DOTTED = re.compile(
    f"^({TOKEN}){EDGE_ID}-\\.(?![.-]){S}*({LABEL_TEXT}){S}*(\\.+->|\\.+-){S}*({TOKEN})$"
)
EDGE_INLINE_LABEL_THICK = re.compile(
    f"^({TOKEN}){EDGE_ID}==(?![=>]){S}*({LABEL_TEXT}){S}*(={{2,}}>|={{3,}}){S}*({TOKEN})$"
)
EDGE_FAN_OUT = re.compile(f"^({TOKEN}){S}*({CONNECTOR_ALTERNATION}){S}*({TOKEN}(?:{S}*&{S}*{TOKEN})+)$")
EDGE_NO_LABEL = re.compile(f"^({TOKEN}){EDGE_ID}({CONNECTOR_ALTERNATION}){S}*({TOKEN})$")
CHAIN_HOP = re.compile(f"^({TOKEN}){EDGE_ID}({CONNECTOR_ALTERNATION}){S}*")
BARE_TOKEN = re.compile(f"^({TOKEN})$")

SUBGRAPH_START = re.compile(f"^subgraph{S}+({ID})(?:{S}*\\[({DOT}+)\\])?$")
SUBGRAPH_END = re.compile("^end$")
SUBGRAPH_DIRECTION = re.compile(f"^direction{S}+(TD|LR|TB|RL|BT)$", re.IGNORECASE | re.ASCII)
BARE_ID = re.compile(f"^({ID}){CLASS_SUFFIX_CAPTURE}$")
HEADER = re.compile(f"^(?:flowchart|graph){S}+(TD|LR|TB|RL|BT)$", re.IGNORECASE | re.ASCII)
TITLE_PATTERN = re.compile(f"^title{S}+({DOT}+)$")
ACC_TITLE_PATTERN = re.compile(f"^accTitle{S}*:{S}*({DOT}+)$")
ACC_DESCR_PATTERN = re.compile(f"^accDescr{S}*:{S}*({DOT}+)$")
MERMAID_CONFIG_DIRECTIVE_PATTERN = re.compile(f"^%%\\{{{DOT}*\\}}%%$")
STYLE_DIRECTIVE = re.compile(f"^style{S}+({ID}){S}+({DOT}+)$")
LINK_STYLE_DIRECTIVE = re.compile(f"^linkStyle{S}+(default|\\d+(?:{S}*,{S}*\\d+)*){S}+({DOT}+)$")
CLASSDEF_DIRECTIVE = re.compile(f"^classDef{S}+({ID}){S}+({DOT}+?);?$")
CLASS_ASSIGN_DIRECTIVE = re.compile(f"^class{S}+((?:{ID})(?:{S}*,{S}*{ID})*){S}+({ID}){S}*;?$")
CLASS_SHORTHAND = re.compile(f"^({ID}):::({ID}(?:{S}*,{S}*{ID})*)$")
CLICK_HREF_DIRECTIVE = re.compile(f'^click{S}+({ID}){S}+href{S}+"([^"]*)"(?:{S}+"([^"]*)")?(?:{S}+(_blank))?{S}*;?$')
CLICK_CALL_DIRECTIVE = re.compile(f"^click{S}+({ID}){S}+call{S}+{DOT}*$")
_LINE_SPLIT = re.compile(r"\r?\n")
#: ASCII digits only, as JavaScript's \d.
_DIGITS = re.compile("[0-9]")

CLICK_CALL_MESSAGE = (
    '"click <id> call ..." is not supported: executing a function named by diagram text is a security risk '
    '(code execution from untrusted, pasted-to-import content), not a parsing feature. Use "click <id> href '
    '\\"<url>\\"" instead.'
)


def _fix_digit_class(pattern: re.Pattern[str]) -> re.Pattern[str]:
    """Python's \\d also matches non-ASCII digits; JavaScript's doesn't."""
    return re.compile(pattern.pattern.replace("\\d", "[0-9]"), pattern.flags)


LINK_STYLE_DIRECTIVE = _fix_digit_class(LINK_STYLE_DIRECTIVE)


def _split_props(props_raw: str) -> list[tuple[str, str | None]]:
    out = []
    for prop in props_raw.split(","):
        parts = [js_trim(p) for p in prop.split(":")]
        out.append((parts[0], parts[1] if len(parts) > 1 else None))
    return out


def parse_style_props(props_raw: str) -> dict[str, Any]:
    """`fill:#f00,stroke:#000,stroke-width:2px,stroke-dasharray:5 5` -> NodeStyle (other properties ignored).
    A missing value stays undefined; a property given twice takes the last value."""
    style: dict[str, Any] = {}
    for key, value in _split_props(props_raw):
        if key == "fill":
            _set(style, "fillColor", value)
        elif key == "stroke":
            _set(style, "strokeColor", value)
        elif key == "stroke-width":
            style["strokeWidth"] = js_parse_float(value if value is not None else "undefined")
        elif key == "stroke-dasharray":
            _set(style, "strokeDasharray", value)
    return style


def _set(style: dict[str, Any], key: str, value: str | None) -> None:
    """`style[key] = value`; None stands for undefined (it still replaces an earlier value)."""
    style[key] = value


def _merge(base: dict[str, Any] | None, patch: dict[str, Any]) -> dict[str, Any]:
    """`{ ...base, ...patch }` where a patch value of undefined (None) still overwrites."""
    return {**(base or {}), **patch}


def _match_node_token(token: str) -> tuple[str, str, str, bool, str | None, str | None] | None:
    """(id, label, shape, explicit, class, shape data); explicit = the token gave a shape and text (canvas-ltfa)."""
    with_data = SHAPE_DATA_TOKEN.match(token)
    if with_data:
        return with_data.group(1), with_data.group(1), "rectangle", False, with_data.group(2), with_data.group(3)
    for shape, regex in NODE_PATTERNS:
        match = regex.match(token)
        if match:
            return match.group(1), match.group(2), shape, True, match.group(3), None
    bare = BARE_ID.match(token)
    if bare:
        return bare.group(1), bare.group(1), "rectangle", False, bare.group(2), None
    return None


def _try_parse_chain(line: str) -> list[tuple[str, str | None, str, str]] | None:
    hops: list[tuple[str, str | None, str]] = []
    remaining = line
    while True:
        match = CHAIN_HOP.match(remaining)
        if not match:
            break
        hops.append((match.group(1), match.group(2), match.group(3)))
        remaining = remaining[match.end() :]
    if len(hops) < 2:
        return None
    final = BARE_TOKEN.match(remaining)
    if not final:
        return None
    tokens = [h[0] for h in hops] + [final.group(1)]
    return [(tokens[i], hop[1], hop[2], tokens[i + 1]) for i, hop in enumerate(hops)]


def _first_class(class_names: str) -> str:
    return js_trim(class_names.split(",")[0])


def parse_flowchart(dsl: str) -> dict[str, Any]:
    front_matter, body = split_front_matter(dsl)
    canvas = canvas_section(front_matter)
    positions = section(canvas, "positions")
    container_meta = section(canvas, "containers")
    styles = section(canvas, "styles")
    edge_styles = section(canvas, "edgeStyles")
    icons = section(canvas, "icons")
    is_fresh_import = not positions and not container_meta
    placeholder = {"x": 0, "y": 0}
    auto = [0]

    def next_auto_position() -> dict[str, float]:
        k = auto[0]
        auto[0] += 1
        return {"x": (k % 5) * 180 + 40, "y": (k // 5) * 120 + 40}

    lines = _LINE_SPLIT.split(body)
    errors: list[dict[str, Any]] = []
    nodes_by_id: dict[str, dict[str, Any]] = {}
    containers_by_id: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    edges_by_mermaid_id: dict[str, dict[str, Any]] = {}
    current: dict[str, Any] = {"index": 0, "text": ""}  # the line being read, for errors found at an edge's ends
    container_stack: list[str] = []
    style_directives: list[tuple[str, str]] = []
    link_style_directives: list[tuple[list[int] | None, str]] = []
    class_defs: dict[str, dict[str, Any]] = {}
    class_assignments: list[tuple[list[str], str]] = []
    link_directives: list[tuple[str, dict[str, Any]]] = []
    diagram_type_seen = False
    direction: str | None = None
    edge_counter = 0
    title = acc_title = acc_descr = config_directive = None

    def current_container() -> str | None:
        return container_stack[-1] if container_stack else None

    def ensure_node(node_id: str, label: str, shape: str, explicit: bool = False) -> dict[str, Any]:
        """canvas-ltfa: an explicit mention (a shape and text) updates a node already seen; the last one wins."""
        node = nodes_by_id.get(node_id)
        if node is None:
            node = {
                "id": node_id,
                "label": label,
                "shape": "icon" if shape == "rectangle" and icons.get(node_id) else shape,
                "position": positions[node_id]
                if positions.get(node_id) is not None
                else (placeholder if is_fresh_import else next_auto_position()),
                "style": styles.get(node_id),
                "icon": icons.get(node_id),
                "containerId": current_container(),
            }
            nodes_by_id[node_id] = node
        else:
            if node.get("containerId") is None:
                node["containerId"] = current_container()
            if explicit:
                node["label"] = label
                node["shape"] = "icon" if shape == "rectangle" and icons.get(node_id) else shape
        return node

    def apply_shape_data(node: dict[str, Any], inner: str) -> None:
        parsed = parse_shape_data(inner)
        error = parsed.get("error")
        for key, value in parsed.get("entries", []):
            if key == "shape":
                if not isinstance(value, str) or not MERMAID_NAME.match(value):
                    error = f'"{js_template(value)}" is not a shape name'
                    break
                node["mermaidShape"] = value
                node["shape"] = mermaid_shape_to_canvas(value, js_truthy(icons.get(node["id"])))
            elif key == "label":
                node["label"] = js_template(value)
            elif key == "img" and (not isinstance(value, str) or not is_allowed_link_href(value)):
                error = '"img" must be an http(s) or relative address'
                break
            else:
                node["mermaidData"] = {**(node.get("mermaidData") or {}), key: value}
        if error:
            message = f"In {node['id']}@{{ … }}: {error}."
            errors.append({"line": current["index"] + 1, "content": current["text"], "message": message})

    def resolve_endpoint(token: str) -> str:
        parsed = _match_node_token(token)
        if parsed is None:
            return token
        node_id, label, shape, explicit, class_name, data = parsed
        node = ensure_node(node_id, label, shape, explicit)
        if data is not None:
            apply_shape_data(node, data)
        if class_name:
            class_assignments.append(([node_id], _first_class(class_name)))
        return node_id

    def push_edge(
        source: str, connector: str, target: str, label: str | None = None, mermaid_id: str | None = None
    ) -> None:
        nonlocal edge_counter
        line_style, arrow, length = _read_connector(connector)
        edge_counter += 1
        edge_id = f"e{edge_counter}"
        edge: dict[str, Any] = {
            "id": edge_id,
            "sourceId": resolve_endpoint(source),
            "targetId": resolve_endpoint(target),
            "label": label,
            "style": edge_styles.get(edge_id),
            "arrow": arrow,
            "lineStyle": line_style,
        }
        if length > 1:
            edge["mermaidLength"] = length
        if mermaid_id is not None:
            if mermaid_id in edges_by_mermaid_id:
                errors.append(
                    {
                        "line": current["index"] + 1,
                        "content": current["text"],
                        "message": f'Edge id "{mermaid_id}" is used twice.',
                    }
                )
            edge["mermaidId"] = mermaid_id
            edges_by_mermaid_id[mermaid_id] = edge
        edges.append(edge)

    for i, raw_line in enumerate(lines):
        current["index"], current["text"] = i, raw_line
        line = js_trim(raw_line)
        if not line:
            continue
        if MERMAID_CONFIG_DIRECTIVE_PATTERN.match(line):
            config_directive = line
            continue
        line = strip_trailing_comment(line)
        if not line:
            continue

        if not diagram_type_seen:
            header = HEADER.match(line)
            if header:
                diagram_type_seen = True
                direction = header.group(1).upper()
                continue
            errors.append(
                {"line": i + 1, "content": raw_line, "message": 'Expected a "flowchart <direction>" header line'}
            )
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

        if m := SUBGRAPH_START.match(line):
            sub_id, sub_label = m.group(1), m.group(2)
            meta = container_meta.get(sub_id)
            container: dict[str, Any] = {
                "id": sub_id,
                "label": sub_label if sub_label is not None else sub_id,
                "position": {"x": meta.get("x"), "y": meta.get("y")}
                if isinstance(meta, dict)
                else (placeholder if is_fresh_import else next_auto_position()),
                "size": {"width": meta["width"], "height": meta["height"]}
                if isinstance(meta, dict) and meta.get("width") is not None and meta.get("height") is not None
                else None,
                "parentContainerId": current_container(),
            }
            containers_by_id[sub_id] = container
            container_stack.append(sub_id)
            continue
        if SUBGRAPH_END.match(line):
            if not container_stack:
                errors.append({"line": i + 1, "content": raw_line, "message": '"end" with no matching "subgraph"'})
            else:
                container_stack.pop()
            continue

        if container_stack and (m := SUBGRAPH_DIRECTION.match(line)):
            containers_by_id[container_stack[-1]]["direction"] = m.group(1).upper()
            continue

        if m := STYLE_DIRECTIVE.match(line):
            style_directives.append((m.group(1), m.group(2)))
            continue
        if m := LINK_STYLE_DIRECTIVE.match(line):
            spec = m.group(1)
            indices = None if spec == "default" else [int(js_parse_int(js_trim(n))) for n in spec.split(",")]
            link_style_directives.append((indices, m.group(2)))
            continue
        if m := CLASSDEF_DIRECTIVE.match(line):
            class_defs[m.group(1)] = parse_style_props(m.group(2))
            continue
        if m := CLASS_ASSIGN_DIRECTIVE.match(line):
            class_assignments.append(([js_trim(x) for x in m.group(1).split(",")], m.group(2)))
            continue
        if m := CLASS_SHORTHAND.match(line):
            ensure_node(m.group(1), m.group(1), "rectangle")
            class_assignments.append(([m.group(1)], _first_class(m.group(2))))
            continue

        if CLICK_CALL_DIRECTIVE.match(line):
            errors.append({"line": i + 1, "content": raw_line, "message": CLICK_CALL_MESSAGE})
            continue
        if m := CLICK_HREF_DIRECTIVE.match(line):
            node_id, href, tooltip, target = m.group(1), m.group(2), m.group(3), m.group(4)
            if not is_allowed_link_href(href):
                scheme = url_protocol(href) or "(unknown)"
                errors.append(
                    {
                        "line": i + 1,
                        "content": raw_line,
                        "message": f'click href must use "http://", "https://", or a relative path -- "{scheme}:" is '
                        "not an allowed scheme.",
                    }
                )
                continue
            link: dict[str, Any] = {"href": href}
            if tooltip is not None:
                link["tooltip"] = tooltip
            if target == "_blank":
                link["target"] = "_blank"
            link_directives.append((node_id, link))
            continue

        if m := EDGE_WITH_PIPE_LABEL.match(line):
            push_edge(m.group(1), m.group(3), m.group(5), m.group(4), m.group(2))
            continue
        chain = _try_parse_chain(line)
        if chain:
            for source, mermaid_id, connector, target in chain:
                push_edge(source, connector, target, None, mermaid_id)
            continue
        if m := EDGE_FAN_OUT.match(line):
            for target in (js_trim(t) for t in m.group(3).split("&")):
                push_edge(m.group(1), m.group(2), target)
            continue
        if m := EDGE_INLINE_LABEL_SOLID.match(line):
            push_edge(m.group(1), m.group(4), m.group(5), m.group(3), m.group(2))
            continue
        if m := EDGE_INLINE_LABEL_DOTTED.match(line):
            push_edge(m.group(1), "-" + m.group(4), m.group(5), m.group(3), m.group(2))
            continue
        if m := EDGE_INLINE_LABEL_THICK.match(line):
            push_edge(m.group(1), m.group(4), m.group(5), m.group(3), m.group(2))
            continue
        if m := EDGE_NO_LABEL.match(line):
            push_edge(m.group(1), m.group(3), m.group(4), None, m.group(2))
            continue

        if m := SHAPE_DATA_TOKEN.match(line):
            data_id, class_names, inner = m.group(1), m.group(2), m.group(3)
            # canvas-lwa4: a closed subgraph's options first, as in Mermaid (flowchart-parser.ts).
            subgraph = containers_by_id.get(data_id) if class_names is None and data_id not in container_stack else None
            edge = edges_by_mermaid_id.get(data_id) if class_names is None and subgraph is None else None
            if subgraph is not None:
                parsed = parse_shape_data(inner)
                if "error" in parsed:
                    errors.append(
                        {"line": i + 1, "content": raw_line, "message": f"In {data_id}@{{ … }}: {parsed['error']}."}
                    )
                else:
                    for key, value in parsed["entries"]:
                        subgraph["mermaidData"] = {**(subgraph.get("mermaidData") or {}), key: value}
            elif edge is not None:
                parsed = parse_shape_data(inner)
                if "error" in parsed:
                    errors.append(
                        {"line": i + 1, "content": raw_line, "message": f"In {data_id}@{{ … }}: {parsed['error']}."}
                    )
                else:
                    for key, value in parsed["entries"]:
                        edge["mermaidData"] = {**(edge.get("mermaidData") or {}), key: value}
            elif data_id in containers_by_id:
                errors.append(
                    {
                        "line": i + 1,
                        "content": raw_line,
                        "message": f"Subgraph options ({data_id}@{{ … }}) go after the subgraph's end, "
                        "without a class.",
                    }
                )
            else:
                apply_shape_data(ensure_node(data_id, data_id, "rectangle"), inner)
                if class_names:
                    class_assignments.append(([data_id], _first_class(class_names)))
            continue

        matched = False
        for shape, regex in NODE_PATTERNS:
            m = regex.match(line)
            if m:
                ensure_node(m.group(1), m.group(2), shape, True)
                if m.group(3):
                    class_assignments.append(([m.group(1)], _first_class(m.group(3))))
                matched = True
                break
        if matched:
            continue
        if m := BARE_ID.match(line):
            ensure_node(m.group(1), m.group(1), "rectangle")
            continue

        errors.append(
            {
                "line": i + 1,
                "content": raw_line,
                "message": f'Could not interpret line as a node, edge, or subgraph: "{line}"',
            }
        )

    for edge in edges:
        if edge["sourceId"] not in nodes_by_id:
            ensure_node(edge["sourceId"], edge["sourceId"], "rectangle")
        if edge["targetId"] not in nodes_by_id:
            ensure_node(edge["targetId"], edge["targetId"], "rectangle")

    for node_ids, class_name in class_assignments:
        class_style = class_defs.get(class_name)
        for node_id in node_ids:
            node = nodes_by_id.get(node_id)
            if node is None:
                continue
            if node.get("role") is None:
                node["role"] = class_name
            if class_style is not None:  # an empty classDef ({}) is truthy in JavaScript
                node["style"] = _merge(node.get("style"), class_style)

    for node_id, props_raw in style_directives:
        node = nodes_by_id.get(node_id)
        if node is not None:
            node["style"] = _merge(node.get("style"), parse_style_props(props_raw))

    for node_id, link in link_directives:
        node = nodes_by_id.get(node_id)
        if node is not None:
            node["link"] = link

    for indices, props_raw in link_style_directives:
        targets = edges if indices is None else [edges[k] for k in indices if 0 <= k < len(edges)]
        for edge in targets:
            edge["style"] = _merge(edge.get("style"), parse_style_props(props_raw))

    if errors:
        return {"errors": errors}

    # canvas-pc76: a node named like a subgraph is that subgraph, as in Mermaid (flowchart-parser.ts).
    def is_within(container_id: Any, ancestor_id: str) -> bool:
        seen: set[Any] = set()
        current = container_id
        while current is not None and current not in seen:
            if current == ancestor_id:
                return True
            seen.add(current)
            parent = containers_by_id.get(current)
            current = parent.get("parentContainerId") if parent is not None else None
        return False

    for container_id, container in containers_by_id.items():
        node = nodes_by_id.pop(container_id, None)
        if node is None:
            continue
        parent_id = node.get("containerId")
        if (
            container.get("parentContainerId") is None
            and parent_id is not None
            and parent_id in containers_by_id
            and not is_within(parent_id, container_id)
        ):
            container["parentContainerId"] = parent_id

    if is_fresh_import:
        all_nodes = list(nodes_by_id.values())
        all_containers = list(containers_by_id.values())
        node_positions, container_positions, container_sizes = compute_containment_layout(all_nodes, all_containers)
        for node in all_nodes:
            node["position"] = node_positions.get(node["id"], node["position"])
        for container in all_containers:
            container["position"] = container_positions.get(container["id"], container["position"])
            container["size"] = container_sizes.get(container["id"])

    model = create_empty_diagram_model("flowchart")
    model.update(
        {
            "direction": direction,
            "title": title,
            "accTitle": acc_title,
            "accDescr": acc_descr,
            "mermaidConfigDirective": config_directive,
            "nodes": list(nodes_by_id.values()),
            "containers": list(containers_by_id.values()),
            "edges": edges,
            "legend": read_legend(front_matter),
        }
    )
    if pinned := read_pinned(front_matter, model):
        model["pinned"] = pinned
    apply_links(front_matter, model)
    return {"model": model}


# --- serializing -----------------------------------------------------------------------------------

SHAPE_DELIMITERS = {
    "rectangle": ("[", "]"),
    "rounded-rectangle": ("(", ")"),
    "circle": ("((", "))"),
    "diamond": ("{", "}"),
    "cylinder": ("[(", ")]"),
    "person": ("[", "]"),
    "icon": ("[", "]"),
    "stadium": ("([", "])"),
    "subroutine": ("[[", "]]"),
    "double-circle": ("(((", ")))"),
    "hexagon": ("{{", "}}"),
    "parallelogram": ("[/", "/]"),
    "parallelogram-alt": ("[\\", "\\]"),
    "trapezoid": ("[/", "\\]"),
    "trapezoid-alt": ("[\\", "/]"),
    "asymmetric": (">", "]"),
    # canvas-bnnh: state-diagram shapes have no flowchart form; the nearest one keeps the node.
    "state-start": ("((", "))"),
    "state-end": ("(((", ")))"),
    "fork-bar": ("[", "]"),
}
_CLASS_TOKEN = re.compile("^[A-Za-z0-9_]+$")
_UNSAFE_LINK_TEXT = re.compile('["\\r\\n]')


def _js_text(value: Any) -> str:
    """A value in a template literal: `${value}` (undefined as "undefined")."""
    if value is None:
        return "undefined"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _shape_data(node: dict[str, Any]) -> str | None:
    extra = [
        (key, value)
        for key, value in data_entries(node.get("mermaidData"), ("shape", "label"))
        if key != "img" or (isinstance(value, str) and is_allowed_link_href(value))
    ]
    mermaid_shape = node.get("mermaidShape")
    named = mermaid_shape if isinstance(mermaid_shape, str) and MERMAID_NAME.match(mermaid_shape) else None
    if named is None and not extra:
        return None
    entries: list[tuple[str, Any]] = []
    if named is not None and mermaid_shape_to_canvas(named, js_truthy(node.get("icon"))) == node["shape"]:
        entries.append(("shape", named))
    elif named is not None or node["shape"] != "rectangle":
        entries.append(("shape", MERMAID_SHAPE_NAME.get(node["shape"], "rect")))
    if node.get("label") != node["id"]:
        entries.append(("label", node.get("label")))
    return format_shape_data(entries + extra)


def _serialize_node(node: dict[str, Any]) -> str:
    role = node.get("role")
    kind_suffix = f":::{role}" if role and _CLASS_TOKEN.match(role) else ""
    data = _shape_data(node)
    if data is not None:
        return f"  {node['id']}{kind_suffix}{data}"
    open_, close = SHAPE_DELIMITERS[node["shape"]]
    return f"  {node['id']}{open_}{_js_text(node.get('label'))}{close}{kind_suffix}"


def _serialize_click_href(node: dict[str, Any]) -> str | None:
    link = node.get("link")
    if not link:
        return None
    href, tooltip, target = link.get("href"), link.get("tooltip"), link.get("target")
    if not isinstance(href, str) or not is_allowed_link_href(href):
        return None
    if _UNSAFE_LINK_TEXT.search(href) or (tooltip is not None and _UNSAFE_LINK_TEXT.search(tooltip)):
        return None
    tooltip_part = f' "{tooltip}"' if tooltip is not None else ""
    target_part = " _blank" if target == "_blank" else ""
    return f'click {node["id"]} href "{href}"{tooltip_part}{target_part}'


def _link_length(value: Any) -> int:
    is_number = isinstance(value, int | float) and not isinstance(value, bool)
    return int(value) if is_number and float(value).is_integer() and 1 <= value <= MAX_LINK_LENGTH else 1


def _connector_for(edge: dict[str, Any]) -> str:
    length = _link_length(edge.get("mermaidLength"))
    if edge.get("lineStyle") == "invisible":
        return "~" * (length + 2)
    arrow = edge["arrow"] if edge.get("arrow") in ("none", "both") else "target"
    start = "<" if arrow == "both" else ""
    if edge.get("lineStyle") == "dotted":
        return f"-{'.' * length}-" if arrow == "none" else f"{start}-{'.' * length}->"
    dash = "=" if edge.get("lineStyle") == "thick" else "-"
    return dash * (length + 2) if arrow == "none" else f"{start}{dash * (length + 1)}>"


_EDGE_ID = re.compile("^[A-Za-z0-9_]+\\Z")


def _edge_ids(edges: list[dict[str, Any]]) -> list[str | None]:
    used: set[str] = set()
    out: list[str | None] = []
    for edge in edges:
        mermaid_id = edge.get("mermaidId")
        if not isinstance(mermaid_id, str) or not _EDGE_ID.match(mermaid_id) or mermaid_id in used:
            out.append(None)
            continue
        used.add(mermaid_id)
        out.append(mermaid_id)
    return out


def _serialize_edge(edge: dict[str, Any], mermaid_id: str | None) -> str:
    connector = (f"{mermaid_id}@" if mermaid_id is not None else "") + _connector_for(edge)
    label = edge.get("label")
    if label:
        return f"  {edge['sourceId']} {connector}|{label}| {edge['targetId']}"
    return f"  {edge['sourceId']} {connector} {edge['targetId']}"


def _serialize_container(container: dict[str, Any], model: dict[str, Any], emitted: set[str]) -> list[str]:
    lines = [f"subgraph {container['id']} [{_js_text(container.get('label'))}]"]
    if container.get("direction"):
        lines.append(f"  direction {container['direction']}")
    for node in model["nodes"]:
        if node.get("containerId") == container["id"]:
            lines.append(_serialize_node(node))
            emitted.add(node["id"])
    for child in model["containers"]:
        if child.get("parentContainerId") == container["id"]:
            lines.extend(f"  {line}" for line in _serialize_container(child, model, emitted))
    lines.append("end")
    return lines


def _entries(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Object.fromEntries: a later duplicate key replaces the value but keeps the first position."""
    out: dict[str, Any] = {}
    for key, value in pairs:
        out[str(key)] = value
    return out


def serialize_flowchart(model: dict[str, Any]) -> str:
    """The model as Mermaid text, in the order reading it back gives (canvas-ra0g: see read_order)."""
    return _write_flowchart(in_read_order(model, parse_flowchart, _write_flowchart))


def _write_flowchart(model: dict[str, Any]) -> str:
    containers = model.get("containers") or []
    nodes = model.get("nodes") or []
    edges = model.get("edges") or []
    front_matter = {
        "canvas": {
            "positions": _entries([(n["id"], n.get("position")) for n in nodes]),
            "containers": _entries(
                [
                    (
                        c["id"],
                        {
                            "x": c["position"]["x"],
                            "y": c["position"]["y"],
                            "width": c["size"]["width"],
                            "height": c["size"]["height"],
                        },
                    )
                    for c in containers
                    if c.get("size")
                ]
            ),
            "styles": _entries([(n["id"], n["style"]) for n in nodes if n.get("style") is not None]),
            "edgeStyles": _entries([(e["id"], e["style"]) for e in edges if e.get("style") is not None]),
            "icons": _entries([(n["id"], n["icon"]) for n in nodes if n.get("icon")]),
        }
    }
    body_lines = [f"flowchart {model.get('direction') or 'TD'}"]
    if model.get("title"):
        body_lines.append(f"title {model['title']}")
    if model.get("mermaidConfigDirective"):
        body_lines.insert(0, model["mermaidConfigDirective"])
    if model.get("accTitle"):
        body_lines.append(f"accTitle: {model['accTitle']}")
    if model.get("accDescr"):
        body_lines.append(f"accDescr: {model['accDescr']}")
    emitted: set[str] = set()
    for container in containers:
        if not container.get("parentContainerId"):
            body_lines.extend(_serialize_container(container, {"nodes": nodes, "containers": containers}, emitted))
    for node in nodes:
        if node["id"] not in emitted:
            body_lines.append(_serialize_node(node))
    ids = _edge_ids(edges)
    for edge, mermaid_id in zip(edges, ids, strict=True):
        body_lines.append(_serialize_edge(edge, mermaid_id))
    for edge, mermaid_id in zip(edges, ids, strict=True):
        entries = data_entries(edge.get("mermaidData"))
        if mermaid_id is not None and entries:
            body_lines.append(f"  {mermaid_id}{format_shape_data(entries)}")
    # canvas-lwa4: a subgraph's options, after every subgraph has been declared.
    for container in model.get("containers") or []:
        entries = data_entries(container.get("mermaidData"))
        container_id = container.get("id")
        if entries and isinstance(container_id, str) and _PLAIN_SUBGRAPH_ID.match(container_id):
            body_lines.append(f"  {container_id}{format_shape_data(entries)}")
    for node in nodes:
        click = _serialize_click_href(node)
        if click:
            body_lines.append(click)
    body = "\n".join(body_lines) + "\n"
    return join_front_matter(with_links(with_pinned(with_legend(front_matter, model), model), model), body)
