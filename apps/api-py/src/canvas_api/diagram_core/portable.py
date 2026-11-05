"""Portable Mermaid for tools outside Canvas (packages/diagram-core/src/dsl/portable-mermaid.ts): the colours
kept in the canvas front matter added as plain Mermaid style lines, and optionally the canvas front matter
removed. Every family is native (canvas-1bty.15.2 ported the C4, ER and class parsers the style lines need)."""

from __future__ import annotations

import re
from typing import Any

from canvas_api.diagram_core import jsyaml
from canvas_api.diagram_core.detect import detect_dsl_family
from canvas_api.diagram_core.flowchart import parse_flowchart
from canvas_api.diagram_core.front_matter import _TRAILING, FRONT_MATTER_PATTERN
from canvas_api.diagram_core.jsvalues import js_truthy, to_js_json
from canvas_api.github.jstext import JS_WHITESPACE, js_number, js_trim

__all__ = ["NATIVE_PORTABLE_FAMILIES", "to_portable_mermaid"]

COMMENT = "%% Colours for Mermaid tools outside Canvas (added on export)."
#: Families with a native portable form: all of them (sequence and architecture get no style lines).
NATIVE_PORTABLE_FAMILIES = {"flowchart", "c4", "erd", "uml", "sequence", "architecture", "state", None}
_TRAILING_SPACE = re.compile(f"[{JS_WHITESPACE}]+\\Z")


def to_portable_mermaid(dsl: str, strip_front_matter: bool = False) -> str | None:
    """The portable text, or None when the family's style lines need a parser not ported yet."""
    family = detect_dsl_family(dsl)
    if family not in NATIVE_PORTABLE_FAMILIES:
        return None
    portable = _with_style_lines(_with_mermaid_forms(dsl, family), family)
    return _remove_canvas_front_matter(portable) if strip_front_matter else portable


def _with_mermaid_forms(dsl: str, family: str | None) -> str:
    """canvas-0t84: text real Mermaid refuses, rewritten for the export (the saved diagram is unchanged).
    Architecture: every connector needs a side on both ends; a missing side faces the other end."""
    if family == "c4":
        return _c4_forms(dsl)
    if family == "erd":
        return _erd_forms(dsl)
    if family == "uml":
        return _uml_forms(dsl)
    if family == "sequence":
        return _sequence_forms(dsl)
    if family == "flowchart":
        return _flowchart_forms(dsl)
    if family != "architecture":
        return dsl
    from canvas_api.diagram_core.architecture import parse_architecture, serialize_architecture

    result = parse_architecture(dsl)
    if "model" not in result:
        return dsl
    model = result["model"]
    # Ids of services that don't exist (a connector to one, an align row naming one) are left out too.
    ids = {node["id"] for node in model["nodes"]}
    # Mermaid names a connector after its ends (`a-b`) and refuses a second one with that name: keep the first.
    names: set[str] = set()
    edges = []
    for edge in model["edges"]:
        name = f"{edge['sourceId']}-{edge['targetId']}"
        if edge["sourceId"] in ids and edge["targetId"] in ids and name not in names:
            names.add(name)
            edges.append(edge)
    old_alignments = model.get("architectureAlignments") or []
    alignments = [
        {**alignment, "ids": [i for i in alignment["ids"] if i in ids]}
        for alignment in old_alignments
        if len([i for i in alignment["ids"] if i in ids]) >= 2
    ]
    unchanged = (
        len(edges) == len(model["edges"])
        and all(edge.get("sourceAnchor") and edge.get("targetAnchor") for edge in edges)
        and len(alignments) == len(old_alignments)
        and all(len(new["ids"]) == len(old["ids"]) for new, old in zip(alignments, old_alignments, strict=True))
    )
    if unchanged:
        return dsl
    rewritten = {**model, "edges": [_with_sides(model, edge) for edge in edges]}
    if model.get("architectureAlignments") is not None:
        rewritten["architectureAlignments"] = alignments
    return serialize_architecture(_defined(rewritten))


def _defined(value: Any) -> Any:
    """A parsed model as TypeScript holds it: a None field is `undefined`, so it is left out (a serializer would
    write it as null). NaN and the rest are kept as they are."""
    if isinstance(value, dict):
        return {k: _defined(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_defined(v) for v in value]
    return value


def _without_empty_groups(model: dict[str, Any], is_group: Any) -> list[dict[str, Any]]:
    """Groups Mermaid can't draw empty, left out, and then any group they leave empty, and so on up."""
    containers: list[dict[str, Any]] = model["containers"]
    while True:
        kept = [
            c
            for c in containers
            if not is_group(c)
            or any(n.get("containerId") == c["id"] for n in model["nodes"])
            or any(child.get("parentContainerId") == c["id"] for child in containers)
        ]
        if len(kept) == len(containers):
            return containers
        containers = kept


def _c4_forms(dsl: str) -> str:
    """C4: `Lay_*` hints are C4-PlantUML's; an empty boundary doesn't parse."""
    from canvas_api.diagram_core.c4 import parse_c4, serialize_c4

    result = parse_c4(dsl)
    if "model" not in result:
        return dsl
    model = result["model"]
    containers = _without_empty_groups(model, lambda _c: True)
    if not (model.get("layoutHints") or []) and len(containers) == len(model["containers"]):
        return dsl
    rest = {k: v for k, v in model.items() if k != "layoutHints"}
    return serialize_c4(_defined({**rest, "containers": containers}))


def _quoted(text: str) -> str:
    """Text Mermaid reads inside double quotes, its own `"` written as the `#quot;` entity."""
    return '"' + text.replace('"', "#quot;") + '"'


def _erd_forms(dsl: str) -> str:
    """ER: relationship labels and aliases quoted (a bare one can't be one of Mermaid's ER keywords)."""
    from canvas_api.diagram_core.erd import DEFAULT_RELATIONSHIP_LABEL, parse_erd, serialize_erd

    result = parse_erd(dsl)
    if "model" not in result:
        return dsl
    model = result["model"]
    if not model["edges"] and all(node.get("label") == node["id"] for node in model["nodes"]):
        return dsl
    nodes = [
        node if node.get("label") == node["id"] else {**node, "label": _quoted(node["label"])}
        for node in model["nodes"]
    ]
    edges = []
    for edge in model["edges"]:
        label = edge.get("label")
        text = js_trim(label) if isinstance(label, str) else ""
        edges.append({**edge, "label": _quoted(text or DEFAULT_RELATIONSHIP_LABEL)})
    return serialize_erd(_defined({**model, "nodes": nodes, "edges": edges}))


def _uml_forms(dsl: str) -> str:
    """Class diagrams: `:` in a relationship label as `#58;`; empty namespaces and empty notes left out."""
    from canvas_api.diagram_core.uml import parse_uml, serialize_uml

    result = parse_uml(dsl)
    if "model" not in result:
        return dsl
    model = result["model"]
    changed = False
    edges = []
    for edge in model["edges"]:
        label = edge.get("label")
        if isinstance(label, str) and ":" in label:
            changed = True
            edge = {**edge, "label": label.replace(":", "#58;")}
        edges.append(edge)
    with_notes = [c for c in model["containers"] if c.get("role") != "note" or js_trim(c["label"]) != ""]
    containers = _without_empty_groups({**model, "containers": with_notes}, lambda c: c.get("role") == "namespace")
    if not changed and len(containers) == len(model["containers"]):
        return dsl
    return serialize_uml(_defined({**model, "edges": edges, "containers": containers}))


def _sequence_forms(dsl: str) -> str:
    """Sequence: a note over more than two participants spans the first to the last."""
    from canvas_api.diagram_core.sequence import parse_sequence, serialize_sequence

    result = parse_sequence(dsl)
    if "model" not in result:
        return dsl
    model = result["model"]
    order = {node["id"]: index for index, node in enumerate(model["nodes"])}
    changed = False
    containers = []
    for container in model["containers"]:
        ids = container.get("attachedNodeIds") or []
        if container.get("role") == "note-over" and len(ids) > 2:
            changed = True
            ordered = sorted(ids, key=lambda i: order.get(i, 0))
            container = {**container, "attachedNodeIds": [ordered[0], ordered[-1]]}
        containers.append(container)
    return serialize_sequence(_defined({**model, "containers": containers})) if changed else dsl


def _flowchart_forms(dsl: str) -> str:
    """Flowchart: the title moves to the front matter; `"` in a label is written `#quot;`."""
    from canvas_api.diagram_core.flowchart import serialize_flowchart

    result = parse_flowchart(dsl)
    if "model" not in result:
        return dsl
    model = result["model"]
    title = model.get("title")
    changed = bool(title)
    nodes = []
    for node in model["nodes"]:
        label = node.get("label")
        if isinstance(label, str) and '"' in label:
            changed = True
            node = {**node, "label": label.replace('"', "#quot;")}
        nodes.append(node)
    if not changed:
        return dsl
    text = serialize_flowchart(_defined({**model, "nodes": nodes, "title": None}))
    return _with_front_matter_title(text, title) if title else text


def _with_front_matter_title(text: str, title: str) -> str:
    match = FRONT_MATTER_PATTERN.match(text)
    parsed = jsyaml.load(match.group(1)) if match else None
    keys = parsed if isinstance(parsed, dict) else {}
    rest = {k: v for k, v in keys.items() if k != "title"}
    body = text[match.end() :] if match else text
    return f"---\n{jsyaml.dump({'title': title, **rest}).rstrip(_TRAILING)}\n---\n{body}"


_OPPOSITE = {"T": "B", "B": "T", "L": "R", "R": "L"}


def _end_center(model: dict[str, Any], node_id: str, is_group: Any) -> tuple[float, float] | None:
    from canvas_api.diagram_core.sizes import node_size
    from canvas_api.diagram_core.svg_render import container_size

    node = next((n for n in model["nodes"] if n["id"] == node_id), None)
    if node is None:
        return None
    group = None
    if is_group and node.get("containerId"):
        group = next((c for c in model["containers"] if c["id"] == node["containerId"]), None)
    if group is not None:
        size = container_size(group)
        return group["position"]["x"] + size["width"] / 2, group["position"]["y"] + size["height"] / 2
    size = node_size(node)
    return node["position"]["x"] + size["width"] / 2, node["position"]["y"] + size["height"] / 2


def _with_sides(model: dict[str, Any], edge: dict[str, Any]) -> dict[str, Any]:
    if edge.get("sourceAnchor") and edge.get("targetAnchor"):
        return edge
    start = _end_center(model, edge["sourceId"], edge.get("sourceIsGroup"))
    end = _end_center(model, edge["targetId"], edge.get("targetIsGroup"))
    if start is None or end is None:
        return edge
    if edge["sourceId"] == edge["targetId"] and (not edge.get("sourceIsGroup")) == (not edge.get("targetIsGroup")):
        source, target = "R", "T"  # a loop: out of the right, back in at the top
    else:
        dx, dy = end[0] - start[0], end[1] - start[1]
        source = ("R" if dx >= 0 else "L") if abs(dx) >= abs(dy) else ("B" if dy >= 0 else "T")
        target = _OPPOSITE[source]
    return {
        **edge,
        "sourceAnchor": edge.get("sourceAnchor") or source,
        "targetAnchor": edge.get("targetAnchor") or target,
    }


def _remove_canvas_front_matter(dsl: str) -> str:
    match = FRONT_MATTER_PATTERN.match(dsl)
    if not match:
        return dsl
    body = dsl[match.end() :]
    parsed = jsyaml.load(match.group(1))
    rest = {k: v for k, v in parsed.items() if k != "canvas"} if isinstance(parsed, dict) else {}
    if not rest:
        return body
    return f"---\n{jsyaml.dump(rest).rstrip(_TRAILING)}\n---\n{body}"


def _with_style_lines(dsl: str, family: str | None) -> str:
    # Imported here: the family modules import nothing from this one, but keeping them out of the module's
    # import time keeps `detect`-only callers light.
    from canvas_api.diagram_core.c4 import parse_c4
    from canvas_api.diagram_core.erd import parse_erd
    from canvas_api.diagram_core.state import parse_state
    from canvas_api.diagram_core.uml import parse_uml

    if family == "flowchart":
        lines = _flowchart_lines(parse_flowchart(dsl))
    elif family == "c4":
        lines = _c4_lines(parse_c4(dsl))
    elif family == "erd":
        lines = _node_style_lines(parse_erd(dsl), "")
    elif family == "uml":
        lines = _node_style_lines(parse_uml(dsl), "")
    elif family == "state":
        lines = _state_lines(parse_state(dsl))
    else:
        lines = []
    if not lines:
        return dsl
    # Flowcharts are written indented; the other families' serializers write flush left.
    indent = "  " if family in ("flowchart", "state") else ""
    trimmed = _TRAILING_SPACE.sub("", dsl)
    return f"{trimmed}\n{indent}{COMMENT}\n" + "\n".join(lines) + "\n"


def _state_lines(result: dict[str, Any]) -> list[str]:
    """canvas-bnnh: one classDef per distinct colouring, assigned to its states (not start/end points or composite
    states, which Mermaid's classes don't apply to)."""
    if "model" not in result:
        return []
    class_of: dict[str, str] = {}
    members: dict[str, list[str]] = {}
    for node in result["model"]["nodes"]:
        if node.get("role") in ("start", "end"):
            continue
        props = _style_props(node.get("style"))
        if not props:
            continue
        if props not in class_of:
            class_of[props] = f"canvasStyle{len(class_of) + 1}"
        members.setdefault(class_of[props], []).append(node["id"])
    out: list[str] = []
    for props, name in class_of.items():
        out.append(f"  classDef {name} {props}")
        out.append(f"  class {','.join(members[name])} {name}")
    return out


def _node_style_lines(result: dict[str, Any], indent: str) -> list[str]:
    """`style <id> ...` per coloured node: flowchart, ER and class diagrams share this grammar."""
    if "model" not in result:
        return []
    lines = []
    for node in result["model"]["nodes"]:
        props = _style_props(node.get("style"))
        if props:
            lines.append(f"{indent}style {node['id']} {props}")
    return lines


def _c4_lines(result: dict[str, Any]) -> list[str]:
    """C4's own macros carry only colours. UpdateRelStyle colours every rel between a pair, so it's written only
    when they all share one colour."""
    if "model" not in result:
        return []
    model = result["model"]
    lines = []
    for node in model["nodes"]:
        style = node.get("style") if isinstance(node.get("style"), dict) else {}
        args = [
            f'$bgColor="{style["fillColor"]}"' if js_truthy(style.get("fillColor")) else None,
            f'$borderColor="{style["strokeColor"]}"' if js_truthy(style.get("strokeColor")) else None,
        ]
        present = [a for a in args if a]
        if present:
            lines.append(f"UpdateElementStyle({node['id']}, {', '.join(present)})")
    by_pair: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for edge in model["edges"]:
        by_pair.setdefault((edge["sourceId"], edge["targetId"]), []).append(edge)
    for first, *rest in by_pair.values():
        colour = _stroke_color(first)
        if not js_truthy(colour) or any(_stroke_color(edge) != colour for edge in rest):
            continue
        lines.append(f'UpdateRelStyle({first["sourceId"]}, {first["targetId"]}, $lineColor="{colour}")')
    return lines


def _flowchart_lines(result: dict[str, Any]) -> list[str]:
    if "model" not in result:
        return []
    model = result["model"]
    lines = _node_style_lines(result, "  ")
    for index, edge in enumerate(model["edges"]):
        props = _style_props(edge.get("style"))
        if props:
            lines.append(f"  linkStyle {index} {props}")
    return lines


def _number_text(value: Any) -> str:
    """`${value}` for a number (NaN and infinities as JavaScript writes them)."""
    if isinstance(value, float):
        if value != value:
            return "NaN"
        if value in (float("inf"), float("-inf")):
            return "Infinity" if value > 0 else "-Infinity"
        return js_number(value)
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(to_js_json(value))


def _stroke_color(edge: dict[str, Any]) -> Any:
    style = edge.get("style")
    return style.get("strokeColor") if isinstance(style, dict) else None


def _style_props(style: Any) -> str | None:
    # A style that isn't an object (typed front matter can hold anything) has no colours, as in TypeScript.
    if not isinstance(style, dict):
        return None
    props = []
    if js_truthy(style.get("fillColor")):
        props.append(f"fill:{style['fillColor']}")
    if js_truthy(style.get("strokeColor")):
        props.append(f"stroke:{style['strokeColor']}")
    if style.get("strokeWidth") is not None:
        props.append(f"stroke-width:{_number_text(style['strokeWidth'])}px")
    if style.get("strokeDasharray"):
        props.append(f"stroke-dasharray:{str(style['strokeDasharray']).replace(',', ' ')}")
    return ",".join(props) if props else None
