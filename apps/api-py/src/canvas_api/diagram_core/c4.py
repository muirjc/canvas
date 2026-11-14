"""Mermaid C4 diagrams (packages/diagram-core/src/dsl/c4.ts): C4Context, C4Container, C4Component, C4Dynamic and
C4Deployment.

A line-by-line port: the same regular expressions (JavaScript's `\\s` and `.` spelled out), tried in the same
order, the same second pass for UpdateElementStyle/UpdateRelStyle, the same containment layout for a fresh import.
Parse returns {"model": ...} or {"errors": [...]}, never raises (bad YAML front matter excepted, as in TypeScript).
"""

from __future__ import annotations

import re
from typing import Any

from canvas_api.diagram_core.containment_layout import compute_containment_layout
from canvas_api.diagram_core.front_matter import (
    apply_frames,
    apply_links,
    canvas_section,
    join_front_matter,
    read_legend,
    read_pinned,
    section,
    split_front_matter,
    strip_trailing_comment,
    with_frames,
    with_legend,
    with_links,
    with_pinned,
)
from canvas_api.diagram_core.model import create_empty_diagram_model
from canvas_api.diagram_core.read_order import in_read_order
from canvas_api.github.jstext import JS_WHITESPACE, js_trim

__all__ = ["C4_BOUNDARY_ROLES", "C4_ELEMENT_ROLES", "C4_ROLE_SHAPES", "parse_c4", "serialize_c4"]

S = f"[{JS_WHITESPACE}]"  # JavaScript's \s
DOT = "[^\\n\\r\\u2028\\u2029]"  # JavaScript's .
ID = "[A-Za-z0-9_]+"

HEADER_TO_LEVEL = {
    "C4Context": "c4-context",
    "C4Container": "c4-container",
    "C4Component": "c4-component",
    "C4Dynamic": "c4-code",
    "C4Deployment": "c4-deployment",
}
LEVEL_TO_HEADER = {level: header for header, level in HEADER_TO_LEVEL.items()}

ELEMENT_KINDS = [
    "Person",
    "Person_Ext",
    "System",
    "System_Ext",
    "SystemDb",
    "SystemDb_Ext",
    "SystemQueue",
    "SystemQueue_Ext",
    "Container",
    "Container_Ext",
    "ContainerDb",
    "ContainerDb_Ext",
    "ContainerQueue",
    "ContainerQueue_Ext",
    "Component",
    "Component_Ext",
    "ComponentDb",
    "ComponentDb_Ext",
    "ComponentQueue",
    "ComponentQueue_Ext",
]

_TRAILING_ARGS = f'((?:{S}*,{S}*(?:"[^"]*"|\\$[A-Za-z]+{S}*={S}*"[^"]*"))*)'
ELEMENT_PATTERN = re.compile(f'^({"|".join(ELEMENT_KINDS)})\\({S}*({ID}){S}*,{S}*"([^"]*)"{_TRAILING_ARGS}{S}*\\)\\Z')
TRAILING_ARG = re.compile(f'{S}*,{S}*(?:"([^"]*)"|\\$([A-Za-z]+){S}*={S}*"([^"]*)")')

PERSON_SYSTEM_ARGS = ("descr", "sprite", "tags")
CONTAINER_COMPONENT_ARGS = ("techn", "descr", "sprite", "tags")
REL_ARGS = ("techn", "descr", "sprite", "tags")
DEPLOYMENT_NODE_ARGS = ("type", "descr", "sprite", "tags")
GENERIC_BOUNDARY_ARGS = ("type", "tags")
NAMED_BOUNDARY_ARGS = ("tags",)

REL_KINDS = [
    "Rel",
    "BiRel",
    "Rel_Back",
    "Rel_U",
    "Rel_D",
    "Rel_L",
    "Rel_R",
    "Rel_Up",
    "Rel_Down",
    "Rel_Left",
    "Rel_Right",
]
REL_PATTERN = re.compile(
    f'^({"|".join(REL_KINDS)})\\({S}*({ID}){S}*,{S}*({ID}){S}*,{S}*"([^"]*)"{_TRAILING_ARGS}{S}*\\)\\Z'
)
DEPLOYMENT_NODE_KINDS = ["Deployment_Node", "Node_L", "Node_R", "Node"]
BOUNDARY_START = re.compile(
    f"^(Boundary|System_Boundary|Container_Boundary|Enterprise_Boundary|{'|'.join(DEPLOYMENT_NODE_KINDS)})"
    f'\\({S}*({ID}){S}*,{S}*"([^"]*)"{_TRAILING_ARGS}{S}*\\){S}*\\{{\\Z'
)
BOUNDARY_KEYWORD_TO_ROLE = {
    "Boundary": "boundary",
    "System_Boundary": "system-boundary",
    "Container_Boundary": "container-boundary",
    "Enterprise_Boundary": "enterprise-boundary",
    "Deployment_Node": "deployment-node",
    "Node": "deployment-node",
    "Node_L": "deployment-node",
    "Node_R": "deployment-node",
}
C4_BOUNDARY_ROLES = ("boundary", "system-boundary", "container-boundary", "enterprise-boundary", "deployment-node")
ROLE_TO_BOUNDARY_KEYWORD = {
    "boundary": "Boundary",
    "system-boundary": "System_Boundary",
    "container-boundary": "Container_Boundary",
    "enterprise-boundary": "Enterprise_Boundary",
    "deployment-node": "Deployment_Node",
}
BOUNDARY_END = re.compile("^\\}\\Z")
TITLE_PATTERN = re.compile(f"^title{S}+({DOT}+)\\Z")
ACC_TITLE_PATTERN = re.compile(f"^accTitle{S}*:{S}*({DOT}+)\\Z")
ACC_DESCR_PATTERN = re.compile(f"^accDescr{S}*:{S}*({DOT}+)\\Z")
MERMAID_CONFIG_DIRECTIVE_PATTERN = re.compile(f"^%%\\{{{DOT}*\\}}%%\\Z")

UPDATE_ELEMENT_STYLE = re.compile(f"^UpdateElementStyle\\({S}*({ID}){S}*,{S}*({DOT}+)\\)\\Z")
UPDATE_REL_STYLE = re.compile(f"^UpdateRelStyle\\({S}*({ID}){S}*,{S}*({ID}){S}*,{S}*({DOT}+)\\)\\Z")
UPDATE_LAYOUT_CONFIG = re.compile(f"^UpdateLayoutConfig\\({DOT}*\\)\\Z")
LAY_HINT = re.compile(f"^Lay_([UDLR])\\({S}*({ID}){S}*,{S}*({ID}){S}*\\)\\Z")
#: canvas-rqm6: the side each directional Rel_*/Lay_* names (the macro's suffix), and back.
HINT_DIRECTIONS = {
    "U": "up",
    "Up": "up",
    "D": "down",
    "Down": "down",
    "L": "left",
    "Left": "left",
    "R": "right",
    "Right": "right",
}
HINT_SUFFIX = {"up": "U", "down": "D", "left": "L", "right": "R"}


def _hint_suffix(direction: Any) -> str | None:
    return HINT_SUFFIX.get(direction) if isinstance(direction, str) else None


ELEMENT_TO_ROLE = {kind: kind.split("_")[0].removesuffix("Db").removesuffix("Queue").lower() for kind in ELEMENT_KINDS}
C4_ELEMENT_ROLES = ("person", "system", "container", "component")
C4_TYPE_LABELS = {"person": "Person", "system": "Software System", "container": "Container", "component": "Component"}


def _shape_for(kind: str) -> str:
    base = kind.removesuffix("_Ext")
    if base == "Person":
        return "person"
    if base.endswith("Db"):
        return "cylinder"
    if base.endswith("Queue"):
        return "stadium"
    return "rectangle" if base == "System" else "rounded-rectangle"


ELEMENT_TO_SHAPE = {kind: _shape_for(kind) for kind in ELEMENT_KINDS}


def _role_shapes() -> dict[str, tuple[str, ...]]:
    by_role: dict[str, list[str]] = {}
    for keyword, role in ELEMENT_TO_ROLE.items():
        shapes = by_role.setdefault(role, [])
        if ELEMENT_TO_SHAPE[keyword] not in shapes:
            shapes.append(ELEMENT_TO_SHAPE[keyword])
    return {role: tuple(shapes) for role, shapes in by_role.items()}


#: canvas-syd: every shape each C4 role can be drawn as, in the macros' order (C4_ROLE_SHAPES in dsl/c4.ts).
C4_ROLE_SHAPES = _role_shapes()

NAMED_MACRO_ARG = re.compile(f'^\\$([A-Za-z0-9_]+){S}*={S}*"([^"]*)"\\Z')
POSITIONAL_MACRO_ARG = re.compile('^"([^"]*)"\\Z')
_LINE_SPLIT = re.compile(r"\r?\n")


def _has_technology(kind: str) -> bool:
    return kind.startswith(("Container", "Component"))


def _boundary_arg_order(role: str | None) -> tuple[str, ...]:
    if role == "deployment-node":
        return DEPLOYMENT_NODE_ARGS
    if role == "boundary":
        return GENERIC_BOUNDARY_ARGS
    return NAMED_BOUNDARY_ARGS


def _trailing_args(raw: str, order: tuple[str, ...]) -> dict[str, str]:
    """An element's/relationship's arguments after its label, by name; a named `$name="..."` wins over a
    positional one; empty values count as absent."""
    args: dict[str, str] = {}
    position = 0
    for match in TRAILING_ARG.finditer(raw):
        positional, name, value = match.group(1), match.group(2), match.group(3)
        if name is not None:
            if value:
                args[name] = value
        else:
            key = order[position] if position < len(order) else None
            position += 1
            if key and positional and key not in args:
                args[key] = positional
    return args


def _tags(raw: str | None) -> list[str]:
    return [tag for tag in (js_trim(t) for t in (raw or "").split(",")) if tag]


def _split_macro_args(args_raw: str) -> list[str]:
    parts: list[str] = []
    current = ""
    in_quotes = False
    for ch in args_raw:
        if ch == '"':
            in_quotes = not in_quotes
        if ch == "," and not in_quotes:
            parts.append(js_trim(current))
            current = ""
        else:
            current += ch
    if js_trim(current):
        parts.append(js_trim(current))
    return parts


def _resolve_macro_args(args_raw: str, positional_names: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for index, part in enumerate(_split_macro_args(args_raw)):
        named = NAMED_MACRO_ARG.match(part)
        if named:
            result[named.group(1)] = named.group(2)
            continue
        positional = POSITIONAL_MACRO_ARG.match(part)
        if positional and index < len(positional_names):
            result[positional_names[index]] = positional.group(1)
    return result


def _spread(value: Any) -> dict[str, Any]:
    """`{ ...value }` for whatever the front matter held."""
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        return {str(i): ch for i, ch in enumerate(value)}
    if isinstance(value, list):
        return {str(i): v for i, v in enumerate(value)}
    return {}


def parse_c4(dsl: str) -> dict[str, Any]:
    front_matter, body = split_front_matter(dsl)
    canvas = canvas_section(front_matter)
    positions = section(canvas, "positions")
    styles = section(canvas, "styles")
    edge_styles = section(canvas, "edgeStyles")
    container_meta = section(canvas, "containers")
    is_fresh_import = not positions and not container_meta
    placeholder = {"x": 0, "y": 0}
    auto = [0]

    def next_auto_position() -> dict[str, float]:
        k = auto[0]
        auto[0] += 1
        return {"x": (k % 5) * 200 + 40, "y": (k // 5) * 140 + 40}

    lines = _LINE_SPLIT.split(body)
    errors: list[dict[str, Any]] = []
    nodes_by_id: dict[str, dict[str, Any]] = {}
    containers_by_id: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    container_stack: list[str] = []
    level: str | None = None
    edge_counter = 0
    pending_element_styles: list[tuple[str, str | None, str | None]] = []
    pending_rel_styles: list[tuple[str, str, str | None]] = []
    layout_hints: list[dict[str, Any]] = []
    title = acc_title = acc_descr = config_directive = None

    def current_container() -> str | None:
        return container_stack[-1] if container_stack else None

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

        if not level:
            if line in HEADER_TO_LEVEL:
                level = HEADER_TO_LEVEL[line]
                continue
            errors.append(
                {
                    "line": i + 1,
                    "content": raw_line,
                    "message": "Expected a C4 header (C4Context/C4Container/C4Component/C4Dynamic/C4Deployment)",
                }
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

        if m := ELEMENT_PATTERN.match(line):
            kind, node_id, label, raw_args = m.group(1), m.group(2), m.group(3), m.group(4)
            args = _trailing_args(raw_args, CONTAINER_COMPONENT_ARGS if _has_technology(kind) else PERSON_SYSTEM_ARGS)
            tags = _tags(args.get("tags"))
            role = ELEMENT_TO_ROLE[kind]
            node: dict[str, Any] = {
                "id": node_id,
                "label": label,
                "shape": ELEMENT_TO_SHAPE[kind],
                "role": role,
                "c4TypeLabel": C4_TYPE_LABELS[role],
            }
            if kind.endswith("_Ext"):
                node["external"] = True
            node["position"] = (
                positions[node_id]
                if positions.get(node_id) is not None
                else (placeholder if is_fresh_import else next_auto_position())
            )
            node["style"] = styles.get(node_id)
            node["containerId"] = current_container()
            if args.get("descr"):
                node["description"] = args["descr"]
            if args.get("techn") and _has_technology(kind):
                node["technology"] = args["techn"]
            if tags:
                node["tags"] = tags
            # Map.set on an existing key replaces the value but keeps its place.
            nodes_by_id[node_id] = node
            continue

        if m := REL_PATTERN.match(line):
            kind, source, target, label, raw_args = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)
            rel_args = _trailing_args(raw_args, REL_ARGS)
            edge_counter += 1
            is_back = kind == "Rel_Back"
            edge_id = f"e{edge_counter}"
            edge: dict[str, Any] = {
                "id": edge_id,
                "sourceId": target if is_back else source,
                "targetId": source if is_back else target,
                "label": label,
                "arrow": "both" if kind == "BiRel" else None,
                "style": edge_styles.get(edge_id),
            }
            if rel_args.get("techn"):
                edge["technology"] = rel_args["techn"]
            if rel_args.get("descr"):
                edge["description"] = rel_args["descr"]
            if kind.startswith("Rel_") and kind[4:] in HINT_DIRECTIONS:
                edge["layoutHint"] = HINT_DIRECTIONS[kind[4:]]
            edges.append(edge)
            continue

        if m := UPDATE_ELEMENT_STYLE.match(line):
            margs = _resolve_macro_args(m.group(2), ["bgColor", "fontColor", "borderColor"])
            pending_element_styles.append((m.group(1), margs.get("bgColor"), margs.get("borderColor")))
            continue

        if m := UPDATE_REL_STYLE.match(line):
            margs = _resolve_macro_args(m.group(3), ["textColor", "lineColor", "offsetX", "offsetY"])
            pending_rel_styles.append((m.group(1), m.group(2), margs.get("lineColor")))
            continue

        if UPDATE_LAYOUT_CONFIG.match(line):
            continue

        if m := LAY_HINT.match(line):
            layout_hints.append({"from": m.group(2), "to": m.group(3), "direction": HINT_DIRECTIONS[m.group(1)]})
            continue

        if m := BOUNDARY_START.match(line):
            keyword, container_id, label, raw_args = m.group(1), m.group(2), m.group(3), m.group(4)
            meta = container_meta.get(container_id)
            role = BOUNDARY_KEYWORD_TO_ROLE[keyword]
            args = _trailing_args(raw_args, _boundary_arg_order(role))
            tags = _tags(args.get("tags"))
            container: dict[str, Any] = {"id": container_id, "label": label, "role": role}
            if args.get("type"):
                container["boundaryType"] = args["type"]
            if args.get("descr"):
                container["description"] = args["descr"]
            if tags:
                container["tags"] = tags
            container["position"] = (
                {"x": meta.get("x"), "y": meta.get("y")}
                if isinstance(meta, dict)
                else (placeholder if is_fresh_import else next_auto_position())
            )
            container["size"] = (
                {"width": meta["width"], "height": meta["height"]}
                if isinstance(meta, dict) and meta.get("width") is not None and meta.get("height") is not None
                else None
            )
            container["parentContainerId"] = current_container()
            containers_by_id[container_id] = container
            container_stack.append(container_id)
            continue
        if BOUNDARY_END.match(line):
            if not container_stack:
                errors.append({"line": i + 1, "content": raw_line, "message": '"}" with no matching boundary'})
            else:
                container_stack.pop()
            continue

        errors.append(
            {
                "line": i + 1,
                "content": raw_line,
                "message": f'Could not interpret line as a C4 element, relationship, or boundary: "{line}"',
            }
        )

    if errors:
        return {"errors": errors}

    for node_id, bg_color, border_color in pending_element_styles:
        styled = nodes_by_id.get(node_id)
        if styled is None:
            continue
        style = _spread(styled.get("style"))
        if bg_color:
            style["fillColor"] = bg_color
        if border_color:
            style["strokeColor"] = border_color
        styled["style"] = style
    for source, target, line_color in pending_rel_styles:
        if not line_color:
            continue
        for edge in edges:
            if edge["sourceId"] == source and edge["targetId"] == target:
                edge["style"] = {**_spread(edge.get("style")), "strokeColor": line_color}

    if is_fresh_import:
        all_nodes = list(nodes_by_id.values())
        all_containers = list(containers_by_id.values())
        node_positions, container_positions, container_sizes = compute_containment_layout(all_nodes, all_containers)
        for n in all_nodes:
            n["position"] = node_positions.get(n["id"], n["position"])
        for c in all_containers:
            c["position"] = container_positions.get(c["id"], c["position"])
            c["size"] = container_sizes.get(c["id"])

    model = create_empty_diagram_model(level or "c4-context")
    model.update(
        {
            "nodes": list(nodes_by_id.values()),
            "containers": list(containers_by_id.values()),
            "edges": edges,
            "title": title,
            "accTitle": acc_title,
            "accDescr": acc_descr,
            "mermaidConfigDirective": config_directive,
            "legend": read_legend(front_matter),
        }
    )
    if layout_hints:
        model["layoutHints"] = layout_hints
    if pinned := read_pinned(front_matter, model):
        model["pinned"] = pinned
    apply_links(front_matter, model)
    apply_frames(front_matter, model)
    return {"model": model}


# --- serializing -----------------------------------------------------------------------------------


def _js_text(value: Any) -> str:
    """A value in a template literal: `${value}`."""
    if value is None:
        return "undefined"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _truthy(value: Any) -> bool:
    """JavaScript truthiness: an empty object or array is truthy, NaN is not."""
    if isinstance(value, dict | list):
        return True
    if isinstance(value, float) and value != value:
        return False
    return bool(value)


def _js_join(values: list[Any]) -> str:
    """Array.prototype.join(','): null and undefined become empty."""
    return ",".join("" if v is None else _js_text(v) for v in values)


def _optional_args(values: list[Any]) -> str:
    last = len(values) - 1
    while last >= 0 and not _truthy(values[last]):
        last -= 1
    return "".join(f', "{"" if v is None else _js_text(v)}"' for v in values[: last + 1])


def _base_element_kind_for(node: dict[str, Any]) -> str:
    role, shape = node.get("role"), node.get("shape")
    if role == "person":
        return "Person"
    for r, base in (("system", "System"), ("container", "Container"), ("component", "Component")):
        if role == r:
            if shape == "cylinder":
                return f"{base}Db"
            if shape == "stadium":
                return f"{base}Queue"
            return base
    return "System"


def _element_kind_for(node: dict[str, Any]) -> str:
    base = _base_element_kind_for(node)
    return f"{base}_Ext" if _truthy(node.get("external")) else base


def _tags_arg(tags: Any) -> str:
    return f', $tags="{_js_join(tags)}"' if tags and len(tags) > 0 else ""


def _element_line(node: dict[str, Any]) -> str:
    kind = _element_kind_for(node)
    args = (
        _optional_args([node.get("technology"), node.get("description")])
        if _has_technology(kind)
        else _optional_args([node.get("description")])
    )
    return f'{kind}({_js_text(node.get("id"))}, "{_js_text(node.get("label"))}"{args}{_tags_arg(node.get("tags"))})'


def _entries(pairs: list[tuple[Any, Any]]) -> dict[str, Any]:
    """Object.fromEntries: a later duplicate key replaces the value but keeps the first position."""
    out: dict[str, Any] = {}
    for key, value in pairs:
        out[_js_text(key)] = value
    return out


def serialize_c4(model: dict[str, Any]) -> str:
    """The model as Mermaid text, in the order reading it back gives (canvas-ra0g: see read_order)."""
    return _write_c4(in_read_order(model, parse_c4, _write_c4))


def _write_c4(model: dict[str, Any]) -> str:
    nodes = model.get("nodes") or []
    edges = model.get("edges") or []
    containers = model.get("containers") or []
    front_matter = {
        "canvas": {
            "positions": _entries([(n["id"], n.get("position")) for n in nodes]),
            "styles": _entries([(n["id"], n["style"]) for n in nodes if _truthy(n.get("style"))]),
            "edgeStyles": _entries([(e["id"], e["style"]) for e in edges if _truthy(e.get("style"))]),
            "containers": _entries(
                [
                    (
                        c["id"],
                        {
                            "x": c["position"]["x"],
                            "y": c["position"]["y"],
                            "width": c["size"]["width"],
                            "height": c["size"]["height"],
                        }
                        if _truthy(c.get("size"))
                        else {"x": c["position"]["x"], "y": c["position"]["y"]},
                    )
                    for c in containers
                ]
            ),
        }
    }

    type_id = model.get("diagramTypeId")
    header = (LEVEL_TO_HEADER.get(type_id) if isinstance(type_id, str) else None) or "C4Context"
    lines = [header]
    if model.get("title"):
        lines.append(f"title {_js_text(model['title'])}")
    if model.get("mermaidConfigDirective"):
        lines.insert(0, _js_text(model["mermaidConfigDirective"]))
    if model.get("accTitle"):
        lines.append(f"accTitle: {_js_text(model['accTitle'])}")
    if model.get("accDescr"):
        lines.append(f"accDescr: {_js_text(model['accDescr'])}")
    emitted: set[Any] = set()
    default_keyword = "Deployment_Node" if model.get("diagramTypeId") == "c4-deployment" else "System_Boundary"

    def emit_container(container: dict[str, Any]) -> list[str]:
        role = container.get("role")
        keyword = (role and ROLE_TO_BOUNDARY_KEYWORD.get(role)) or default_keyword
        keyword_role = BOUNDARY_KEYWORD_TO_ROLE.get(keyword)
        if keyword_role == "deployment-node":
            positional = _optional_args([container.get("boundaryType"), container.get("description")])
        elif keyword_role == "boundary":
            positional = _optional_args([container.get("boundaryType")])
        else:
            positional = ""
        tags = _tags_arg(container.get("tags"))
        out = [f'{keyword}({_js_text(container.get("id"))}, "{_js_text(container.get("label"))}"{positional}{tags}) {{']
        for node in nodes:
            if node.get("containerId") == container.get("id"):
                out.append(f"  {_element_line(node)}")
                emitted.add(node.get("id"))
        for child in containers:
            if child.get("parentContainerId") == container.get("id"):
                out.extend(emit_container(child))
        out.append("}")
        return out

    for container in containers:
        if not _truthy(container.get("parentContainerId")):
            lines.extend(emit_container(container))
    for node in nodes:
        if node.get("id") not in emitted:
            lines.append(_element_line(node))
    for edge in edges:
        # canvas-rqm6: a layout hint comes back as Rel_U/D/L/R; BiRel has no directional form.
        suffix = _hint_suffix(edge.get("layoutHint"))
        kind = "BiRel" if edge.get("arrow") == "both" else f"Rel_{suffix}" if suffix else "Rel"
        label = edge.get("label")
        lines.append(
            f"{kind}({_js_text(edge.get('sourceId'))}, {_js_text(edge.get('targetId'))}, "
            f'"{"" if label is None else _js_text(label)}"'
            f"{_optional_args([edge.get('technology'), edge.get('description')])})"
        )

    for hint in model.get("layoutHints") or []:
        if suffix := _hint_suffix(hint.get("direction")):
            lines.append(f"Lay_{suffix}({_js_text(hint.get('from'))}, {_js_text(hint.get('to'))})")

    return join_front_matter(
        with_frames(with_links(with_pinned(with_legend(front_matter, model), model), model), model),
        "\n".join(lines) + "\n",
    )
