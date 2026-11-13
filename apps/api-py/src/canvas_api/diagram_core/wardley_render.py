"""Drawing a Wardley map (packages/diagram-core/src/render/wardley-render.ts, canvas-4h1j), byte for byte."""

from __future__ import annotations

import math
from typing import Any

from canvas_api.diagram_core.jsvalues import js_template, js_truthy
from canvas_api.diagram_core.wardley import wardley_frame, wardley_pipeline_box, wardley_point
from canvas_api.github.jstext import js_len

__all__ = ["compute_wardley_layout", "is_wardley_map_node", "render_wardley_svg"]

Model = dict[str, Any]

NODE_RADIUS = 6
SQUARE = NODE_RADIUS * 1.6
LABEL_OFFSET = 8
AXIS_FONT = 12
LABEL_FONT = 10
DEFAULT_STAGES = ["Genesis", "Custom Built", "Product", "Commodity"]
COS_30 = 0.8660254037844387
SIN_30 = 0.49999999999999994
SQRT_2 = 1.4142135623730951
TEXT = "#222"
STROKE = "#000"
EVOLVE = "#dc3545"
FONT_FAMILY = "system-ui, -apple-system, &quot;Segoe UI&quot;, Roboto, sans-serif"
AVG_CHAR_WIDTH_RATIO = 0.56
MAP_ROLES = {"anchor", "component", "pipeline-component"}


def _t(value: Any) -> str:
    return js_template(value)


def _escape(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def _js_round(x: float) -> float:
    if not math.isfinite(x):
        return x
    floor = math.floor(x)
    return float(floor + 1 if x - floor >= 0.5 else floor)


def is_wardley_map_node(node: dict[str, Any]) -> bool:
    role = node.get("role")
    return role is None or role in MAP_ROLES


def _wardley(node: dict[str, Any]) -> dict[str, Any]:
    data = node.get("wardley")
    return data if isinstance(data, dict) else {}


def compute_wardley_layout(model: Model) -> dict[str, Any]:
    frame = wardley_frame(model)
    points: dict[str, dict[str, float]] = {}
    for node in model["nodes"]:
        if is_wardley_map_node(node):
            points[node["id"]] = {"x": node["position"]["x"], "y": node["position"]["y"]}
    parents: set[str] = set()
    pipelines: list[dict[str, Any]] = []
    for container in model["containers"]:
        if container.get("role") != "pipeline":
            continue
        box = wardley_pipeline_box(model, container, frame)
        if box is None:
            continue
        children = [n["id"] for n in model["nodes"] if n.get("containerId") == container["id"]]
        pipelines.append(
            {
                "id": container["id"],
                "box": {"x": box["x"], "y": box["y"], "width": box["width"], "height": box["height"]},
                "children": children,
            }
        )
        attached = container.get("attachedNodeIds") or []
        parent_id = attached[0] if attached else None
        if parent_id is not None and parent_id in points:
            parents.add(parent_id)
            points[parent_id] = box["parent"]
    settings = model.get("wardley")
    written = settings.get("stages") if isinstance(settings, dict) else None
    if written and len(written) >= 2:
        labels = [f"{s['name']} / {s['secondName']}" if s.get("secondName") else s["name"] for s in written]
    else:
        labels = DEFAULT_STAGES
    boundaries = (
        [s["boundary"] for s in written]
        if written and len(written) >= 2 and all(s.get("boundary") is not None for s in written)
        else None
    )
    stages = []
    for index, label in enumerate(labels):
        if boundaries:
            stages.append(
                {"label": label, "start": 0 if index == 0 else boundaries[index - 1], "end": boundaries[index]}
            )
        else:
            width = 1.0 / len(labels)
            stages.append({"label": label, "start": index * width, "end": (index + 1) * width})
    return {"frame": frame, "points": points, "pipelineParents": parents, "pipelines": pipelines, "stages": stages}


def _degrees(dy: float, dx: float) -> float:
    angle = (math.atan2(dy, dx) * 180) / math.pi
    if angle > 90 or angle < -90:
        angle += 180
    return _js_round(angle * 100) / 100


def _render_link(edge: dict[str, Any], layout: dict[str, Any]) -> str:
    points = layout["points"]
    source = points.get(edge["sourceId"])
    target = points.get(edge["targetId"])
    if source is None or target is None:
        return ""
    dx = target["x"] - source["x"]
    dy = target["y"] - source["y"]
    distance = math.sqrt(dx * dx + dy * dy)
    if distance == 0:
        return ""
    parents = layout["pipelineParents"]
    source_radius = SQUARE / SQRT_2 if edge["sourceId"] in parents else NODE_RADIUS
    target_radius = SQUARE / SQRT_2 if edge["targetId"] in parents else NODE_RADIUS
    raw = edge.get("wardley")
    data: dict[str, Any] = raw if isinstance(raw, dict) else {}
    flow_arrow = data.get("flowArrow") if isinstance(data.get("flowArrow"), dict) else None
    flow = data.get("fromPort")
    if flow is None:
        flow = data.get("toPort")
    if flow is None and flow_arrow is not None:
        flow = flow_arrow.get("flow")
    end = ' marker-end="url(#wardley-flow-end)"' if flow in ("+>", "+<>") else ""
    start = ' marker-start="url(#wardley-flow-start)"' if flow in ("+<", "+<>") else ""
    dash = ' stroke-dasharray="6 6"' if edge.get("lineStyle") == "dotted" else ""
    x1 = source["x"] + (dx / distance) * source_radius
    y1 = source["y"] + (dy / distance) * source_radius
    x2 = target["x"] + (-dx / distance) * target_radius
    y2 = target["y"] + (-dy / distance) * target_radius
    parts = [
        f'<line class="wardley-link" data-id="{_escape(edge["id"])}" x1="{_t(x1)}" y1="{_t(y1)}" x2="{_t(x2)}"'
        f' y2="{_t(y2)}" stroke="{STROKE}" stroke-width="1"{dash}{end}{start} />'
    ]
    label = (flow_arrow.get("label") if flow_arrow is not None else None) or edge.get("label")
    if label:
        x = (source["x"] + target["x"]) / 2 + (dy / distance) * 8
        y = (source["y"] + target["y"]) / 2 + (-dx / distance) * 8
        parts.append(
            f'<text x="{_t(x)}" y="{_t(y)}" fill="{TEXT}" font-size="{LABEL_FONT}" text-anchor="middle"'
            f' dominant-baseline="middle" transform="rotate({_t(_degrees(dy, dx))} {_t(x)} {_t(y)})">'
            f"{_escape(label)}</text>"
        )
    return "".join(parts)


def _render_evolve(node: dict[str, Any], layout: dict[str, Any]) -> str:
    origin = layout["points"].get(node["id"])
    evolve = _wardley(node).get("evolve")
    if origin is None or evolve is None:
        return ""
    target_x = wardley_point(layout["frame"], {"visibility": 0, "evolution": evolve})["x"]
    dx = target_x - origin["x"]
    distance = math.sqrt(dx * dx)
    shorten = NODE_RADIUS + 2
    x2 = target_x - (dx / distance) * shorten if distance > shorten else target_x
    return (
        f'<line class="wardley-evolve" x1="{_t(origin["x"])}" y1="{_t(origin["y"])}"'
        f' x2="{_t(x2)}" y2="{_t(origin["y"])}"'
        f' stroke="{EVOLVE}" stroke-width="1" stroke-dasharray="4 4" marker-end="url(#wardley-evolve-arrow)" />'
    )


def _render_map_node(node: dict[str, Any], layout: dict[str, Any]) -> str:
    point = layout["points"].get(node["id"])
    if point is None:
        return ""
    x, y = point["x"], point["y"]
    data = _wardley(node)
    offset = data.get("labelOffset") if js_truthy(data.get("labelOffset")) else None
    parts = [f'<g class="wardley-node" data-id="{_escape(node["id"])}">']
    if node.get("role") == "anchor":
        lx = x + offset["x"] if offset is not None else x
        ly = y + offset["y"] if offset is not None else y - 3
        parts.append(
            f'<text x="{_t(lx)}" y="{_t(ly)}" fill="#000" font-size="{LABEL_FONT}" font-weight="bold"'
            f' text-anchor="middle" dominant-baseline="middle">{_escape(node["label"])}</text>'
        )
        parts.append("</g>")
        return "".join(parts)
    strategy = data.get("strategy") or None
    is_parent = node["id"] in layout["pipelineParents"]
    ring = {"outsource": "#666", "buy": "#ccc", "build": "#eee", "market": "white"}
    if strategy:
        parts.append(
            f'<circle cx="{_t(x)}" cy="{_t(y)}" r="{NODE_RADIUS * 2}" fill="{ring.get(strategy, "undefined")}"'
            f' stroke="{STROKE}" stroke-width="1" />'
        )
    if not is_parent and strategy != "market":
        parts.append(
            f'<circle cx="{_t(x)}" cy="{_t(y)}" r="{NODE_RADIUS}" fill="#fff" stroke="{STROKE}" stroke-width="1" />'
        )
    if strategy == "market":
        r = NODE_RADIUS * 1.2
        corners = [(x, y - r), (x - r * COS_30, y + r * SIN_30), (x + r * COS_30, y + r * SIN_30)]
        for i in range(3):
            x1, y1 = corners[i]
            x2, y2 = corners[(i + 1) % 3]
            parts.append(
                f'<line x1="{_t(x1)}" y1="{_t(y1)}" x2="{_t(x2)}" y2="{_t(y2)}" stroke="{STROKE}" stroke-width="1" />'
            )
        for cx, cy in corners:
            parts.append(
                f'<circle cx="{_t(cx)}" cy="{_t(cy)}" r="{_t(NODE_RADIUS * 0.7)}" fill="white" stroke="{STROKE}"'
                ' stroke-width="2" />'
            )
    if is_parent:
        parts.append(
            f'<rect x="{_t(x - SQUARE / 2)}" y="{_t(y - SQUARE / 2)}" width="{_t(SQUARE)}" height="{_t(SQUARE)}"'
            f' fill="#fff" stroke="{STROKE}" stroke-width="1" />'
        )
    if js_truthy(data.get("inertia")):
        off = SQUARE / 2 + 15 if is_parent else NODE_RADIUS + 15
        if strategy:
            off += NODE_RADIUS + 10
        half = (SQUARE if is_parent else NODE_RADIUS * 2) / 2
        parts.append(
            f'<line x1="{_t(x + off)}" y1="{_t(y - half)}" x2="{_t(x + off)}" y2="{_t(y + half)}" stroke="{STROKE}"'
            ' stroke-width="6" />'
        )
    default_x = LABEL_OFFSET + 10 if strategy else LABEL_OFFSET
    default_y = -LABEL_OFFSET - 10 if strategy else -LABEL_OFFSET
    lx = x + (offset["x"] if offset is not None and offset.get("x") is not None else default_x)
    ly = y + (offset["y"] if offset is not None and offset.get("y") is not None else default_y)
    parts.append(
        f'<text x="{_t(lx)}" y="{_t(ly)}" fill="{TEXT}" font-size="{LABEL_FONT}" text-anchor="start">'
        f"{_escape(node['label'])}</text>"
    )
    parts.append("</g>")
    return "".join(parts)


def _render_annotations(model: Model, frame: dict[str, float]) -> str:
    annotations = [n for n in model["nodes"] if n.get("role") == "annotation"]
    if not annotations:
        return ""
    parts = ['<g class="wardley-annotations">']
    for node in annotations:
        x, y = node["position"]["x"], node["position"]["y"]
        number = _wardley(node).get("number")
        parts.append(
            f'<g class="wardley-annotation" data-id="{_escape(node["id"])}"><circle cx="{_t(x)}" cy="{_t(y)}" r="10"'
            f' fill="white" stroke="{STROKE}" stroke-width="1.5" /><text x="{_t(x)}" y="{_t(y)}" text-anchor="middle"'
            f' dominant-baseline="central" font-size="10" fill="{TEXT}" font-weight="bold">'
            f"{'' if number is None else _t(number)}</text></g>"
        )
    settings = model.get("wardley")
    box = settings.get("annotationsBox") if isinstance(settings, dict) else None

    def number_of(n: dict[str, Any]) -> float:
        value = _wardley(n).get("number")
        return 0 if value is None else value

    labelled = [(n, index) for index, n in enumerate(a for a in annotations if a.get("label"))]
    labelled.sort(key=lambda pair: (number_of(pair[0]), pair[1]))
    listed = [
        f"{'' if _wardley(n).get('number') is None else _t(_wardley(n)['number'])}. {n['label']}" for n, _ in labelled
    ]
    if js_truthy(box) and listed:
        padding = 10
        line_height = 16
        font_size = 11
        start = wardley_point(frame, box)  # type: ignore[arg-type]  # js_truthy(box) above
        text_width = max(js_len(t) * font_size * AVG_CHAR_WIDTH_RATIO for t in listed)
        width = text_width + padding * 2 + 105
        height = len(listed) * line_height + padding * 2 + font_size / 2
        bx = max(frame["padding"], min(start["x"], frame["width"] - frame["padding"] - width))
        by = max(frame["padding"], min(start["y"], frame["height"] - frame["padding"] - height))
        parts.append(
            f'<g class="wardley-annotations-box"><rect x="{_t(bx)}" y="{_t(by)}" width="{_t(width)}"'
            f' height="{_t(height)}" fill="white" stroke="{STROKE}" stroke-width="1.5" rx="4" ry="4" />'
        )
        for index, text in enumerate(listed):
            parts.append(
                f'<text x="{_t(bx + padding)}" y="{_t(by + padding + (index + 1) * line_height)}"'
                f' font-size="{font_size}" fill="{TEXT}" text-anchor="start" dominant-baseline="middle">'
                f"{_escape(text)}</text>"
            )
        parts.append("</g>")
    parts.append("</g>")
    return "".join(parts)


def _render_accelerator(node: dict[str, Any]) -> str:
    x, y = node["position"]["x"], node["position"]["y"]
    w, h, head = 60, 30, 20
    if node.get("role") == "accelerator":
        points = [
            ("M", x, y - h / 2), ("L", x + w - head, y - h / 2), ("L", x + w - head, y - h / 2 - 8), ("L", x + w, y),
            ("L", x + w - head, y + h / 2 + 8), ("L", x + w - head, y + h / 2), ("L", x, y + h / 2),
        ]  # fmt: skip
    else:
        points = [
            ("M", x + w, y - h / 2), ("L", x + head, y - h / 2), ("L", x + head, y - h / 2 - 8), ("L", x, y),
            ("L", x + head, y + h / 2 + 8), ("L", x + head, y + h / 2), ("L", x + w, y + h / 2),
        ]  # fmt: skip
    d = " ".join(f"{op} {_t(px)} {_t(py)}" for op, px, py in points) + " Z"
    return (
        f'<g class="wardley-{node.get("role")}" data-id="{_escape(node["id"])}"><path d="{d}" fill="white"'
        f' stroke="{STROKE}" stroke-width="1" /><text x="{_t(x + w / 2)}" y="{_t(y + h / 2 + 15)}"'
        f' text-anchor="middle" font-size="10" fill="{TEXT}" font-weight="bold">{_escape(node["label"])}</text></g>'
    )


def render_wardley_svg(model: Model) -> str:
    layout = compute_wardley_layout(model)
    frame = layout["frame"]
    width, height, padding = frame["width"], frame["height"], frame["padding"]
    chart_width, chart_height = frame["chartWidth"], frame["chartHeight"]
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{_t(width)}" height="{_t(height)}"'
        f' viewBox="0 0 {_t(width)} {_t(height)}">',
        "<defs>",
        '<marker id="wardley-evolve-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6"'
        f' orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="{EVOLVE}" stroke="none" /></marker>',
        '<marker id="wardley-flow-end" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5"'
        f' orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="{STROKE}" stroke="none" /></marker>',
        '<marker id="wardley-flow-start" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="5" markerHeight="5"'
        f' orient="auto"><path d="M 10 0 L 0 5 L 10 10 z" fill="{STROKE}" stroke="none" /></marker>',
        "</defs>",
        f'<g class="wardley-map" font-family="{FONT_FAMILY}">',
    ]
    if model.get("title"):
        parts.append(
            f'<text class="wardley-title" x="{_t(width / 2)}" y="{_t(padding / 2)}" fill="{TEXT}"'
            f' font-size="{_t(AXIS_FONT * 1.05)}" font-weight="bold" text-anchor="middle" dominant-baseline="middle">'
            f"{_escape(model['title'])}</text>"
        )
    mid_y = padding + chart_height / 2
    parts.extend(
        [
            '<g class="wardley-axes">',
            f'<line x1="{_t(padding)}" x2="{_t(width - padding)}"'
            f' y1="{_t(height - padding)}" y2="{_t(height - padding)}"'
            f' stroke="{STROKE}" stroke-width="1" />',
            f'<line x1="{_t(padding)}" x2="{_t(padding)}" y1="{_t(padding)}" y2="{_t(height - padding)}"'
            f' stroke="{STROKE}" stroke-width="1" />',
            f'<text x="{_t(padding + chart_width / 2)}" y="{_t(height - padding / 4)}" fill="{TEXT}"'
            f' font-size="{AXIS_FONT}" font-weight="bold" text-anchor="middle">Evolution</text>',
            f'<text x="{_t(padding / 3)}" y="{_t(mid_y)}" fill="{TEXT}" font-size="{AXIS_FONT}" font-weight="bold"'
            f' text-anchor="middle" transform="rotate(-90 {_t(padding / 3)} {_t(mid_y)})">Visibility</text>',
            "</g>",
            '<g class="wardley-stages">',
        ]
    )
    for index, stage in enumerate(layout["stages"]):
        start_x = padding + stage["start"] * chart_width
        end_x = padding + stage["end"] * chart_width
        if index > 0:
            parts.append(
                f'<line x1="{_t(start_x)}" x2="{_t(start_x)}" y1="{_t(padding)}" y2="{_t(height - padding)}"'
                ' stroke="#000" stroke-width="1" stroke-dasharray="5 5" opacity="0.8" />'
            )
        parts.append(
            f'<text x="{_t((start_x + end_x) / 2)}" y="{_t(height - padding / 1.5)}" fill="{TEXT}"'
            f' font-size="{AXIS_FONT - 2}" text-anchor="middle">{_escape(stage["label"])}</text>'
        )
    parts.append("</g>")

    if layout["pipelines"]:
        parts.append('<g class="wardley-pipelines">')
        by_id = {n["id"]: n for n in model["nodes"]}
        for pipeline in layout["pipelines"]:
            ordered = sorted(
                ((by_id[i], index) for index, i in enumerate(pipeline["children"])),
                key=lambda pair: (pair[0]["position"]["x"], pair[1]),
            )
            positions = [n["position"] for n, _ in ordered]
            for i in range(len(positions) - 1):
                a, b = positions[i], positions[i + 1]
                parts.append(
                    f'<line x1="{_t(a["x"])}" y1="{_t(a["y"])}" x2="{_t(b["x"])}" y2="{_t(b["y"])}" stroke="{STROKE}"'
                    ' stroke-width="1" stroke-dasharray="4 4" />'
                )
            box = pipeline["box"]
            parts.append(
                f'<rect class="wardley-pipeline" data-id="{_escape(pipeline["id"])}"'
                f' x="{_t(box["x"])}" y="{_t(box["y"])}"'
                f' width="{_t(box["width"])}" height="{_t(box["height"])}" fill="none" stroke="{STROKE}"'
                ' stroke-width="1.5" rx="4" ry="4" />'
            )
        parts.append("</g>")

    children_of: dict[str, set[str]] = {}
    for container in model["containers"]:
        attached = container.get("attachedNodeIds") or []
        parent = attached[0] if attached else None
        if container.get("role") == "pipeline" and parent is not None:
            children_of[parent] = {n["id"] for n in model["nodes"] if n.get("containerId") == container["id"]}
    parts.append('<g class="wardley-links">')
    for edge in model["edges"]:
        if edge["sourceId"] in children_of.get(edge["targetId"], set()):
            continue
        parts.append(_render_link(edge, layout))
    parts.extend(["</g>", '<g class="wardley-trends">'])
    parts.extend(_render_evolve(n, layout) for n in model["nodes"] if is_wardley_map_node(n))
    parts.extend(["</g>", '<g class="wardley-nodes">'])
    parts.extend(_render_map_node(n, layout) for n in model["nodes"] if is_wardley_map_node(n))
    parts.append("</g>")
    parts.append(_render_annotations(model, frame))
    notes = [n for n in model["nodes"] if n.get("role") == "note"]
    if notes:
        parts.append('<g class="wardley-notes">')
        for note in notes:
            parts.append(
                f'<text data-id="{_escape(note["id"])}" x="{_t(note["position"]["x"])}" y="{_t(note["position"]["y"])}"'
                f' text-anchor="start" font-size="11" fill="{TEXT}" font-weight="bold">{_escape(note["label"])}</text>'
            )
        parts.append("</g>")
    accelerators = [n for n in model["nodes"] if n.get("role") in ("accelerator", "deaccelerator")]
    if accelerators:
        parts.append('<g class="wardley-accelerators">')
        parts.extend(_render_accelerator(n) for n in accelerators)
        parts.append("</g>")
    parts.extend(["</g>", "</svg>"])
    return "".join(parts)
