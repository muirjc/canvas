"""canvas-p2g8.2: layout edits the AI chat's tools make -- moving, aligning, distributing and placing shapes and
groups relative to each other. Pure functions on a model (new model out, input untouched), like diagram_ops.

Positions are a shape's or group's top-left corner, as everywhere in the model; sizes are what the canvas and the
renderer draw (`node_size`, `container_size`), so "aligned" here is aligned on screen. Moving a group moves
everything inside it (`diagram_ops.move_container`). Sequence diagrams have no stored positions (their layout is
computed), so the tools that call these aren't offered there.
"""

from __future__ import annotations

from typing import Any, Literal

from canvas_api.diagram_core import diagram_ops
from canvas_api.diagram_core.sizes import node_size
from canvas_api.diagram_core.svg_render import container_size

__all__ = [
    "POSITIONED_FAMILIES",
    "Alignment",
    "Axis",
    "Side",
    "align_elements",
    "bounds_of",
    "distribute_elements",
    "find_element",
    "move_element",
    "place_relative",
]

Model = dict[str, Any]
Alignment = Literal["left", "center", "right", "top", "middle", "bottom"]
Axis = Literal["horizontal", "vertical"]
Side = Literal["above", "below", "left", "right"]
#: Families whose shapes have stored positions: not sequence, whose layout is computed from the message order.
POSITIONED_FAMILIES = frozenset({"flowchart", "c4", "architecture", "erd", "uml"})
#: The gap placeRelative leaves when none is given: about the space Auto Layout leaves between ranks.
DEFAULT_GAP = 60


def find_element(model: Model, element_id: str) -> tuple[Literal["node", "container"], dict[str, Any]] | None:
    """The shape or group with this id (a shape wins if both somehow share it)."""
    for node in model["nodes"]:
        if node.get("id") == element_id:
            return "node", node
    for container in model["containers"]:
        if container.get("id") == element_id:
            return "container", container
    return None


def bounds_of(model: Model, element_id: str) -> dict[str, float] | None:
    """{x, y, width, height} of a shape or group, as drawn; None if there's no such element."""
    found = find_element(model, element_id)
    if found is None:
        return None
    kind, element = found
    size = node_size(element) if kind == "node" else container_size(element)
    position = element.get("position") or {"x": 0, "y": 0}
    return {"x": position["x"], "y": position["y"], "width": size["width"], "height": size["height"]}


def move_element(model: Model, element_id: str, x: float, y: float) -> Model:
    """Puts an element's top-left corner at (x, y); a group takes its contents along."""
    found = find_element(model, element_id)
    if found is None:
        return model
    kind, _ = found
    if kind == "container":
        return diagram_ops.move_container(model, element_id, {"x": x, "y": y})
    return {
        **model,
        "nodes": [{**n, "position": {"x": x, "y": y}} if n.get("id") == element_id else n for n in model["nodes"]],
    }


def align_elements(model: Model, element_ids: list[str], alignment: Alignment) -> Model:
    """Lines elements up on one edge or centre line, at the outermost one: `left` moves every left edge to the
    leftmost, `center` every centre to the middle of the group's overall span, and so on."""
    boxes = [(element_id, b) for element_id in element_ids if (b := bounds_of(model, element_id)) is not None]
    if len(boxes) < 2:
        return model
    left = min(b["x"] for _, b in boxes)
    right = max(b["x"] + b["width"] for _, b in boxes)
    top = min(b["y"] for _, b in boxes)
    bottom = max(b["y"] + b["height"] for _, b in boxes)
    for element_id, b in boxes:
        x, y = b["x"], b["y"]
        if alignment == "left":
            x = left
        elif alignment == "right":
            x = right - b["width"]
        elif alignment == "center":
            x = (left + right) / 2 - b["width"] / 2
        elif alignment == "top":
            y = top
        elif alignment == "bottom":
            y = bottom - b["height"]
        else:  # middle
            y = (top + bottom) / 2 - b["height"] / 2
        model = move_element(model, element_id, x, y)
    return model


def distribute_elements(model: Model, element_ids: list[str], axis: Axis) -> Model:
    """Spaces elements evenly along an axis, keeping the first and last (in their current order along it) where
    they are: equal gaps between neighbours, whatever their sizes."""
    boxes = [(element_id, b) for element_id in element_ids if (b := bounds_of(model, element_id)) is not None]
    if len(boxes) < 3:
        return model
    start, length = ("x", "width") if axis == "horizontal" else ("y", "height")
    boxes.sort(key=lambda item: item[1][start])
    first, last = boxes[0][1], boxes[-1][1]
    span = last[start] + last[length] - first[start]
    gap = (span - sum(b[length] for _, b in boxes)) / (len(boxes) - 1)
    cursor = first[start]
    for element_id, b in boxes:
        x, y = (cursor, b["y"]) if axis == "horizontal" else (b["x"], cursor)
        model = move_element(model, element_id, x, y)
        cursor += b[length] + gap
    return model


def place_relative(model: Model, element_id: str, side: Side, anchor_id: str, gap: float = DEFAULT_GAP) -> Model:
    """Puts an element on one side of another, `gap` apart, centred on it across that side."""
    box = bounds_of(model, element_id)
    anchor = bounds_of(model, anchor_id)
    if box is None or anchor is None:
        return model
    if side in ("above", "below"):
        x = anchor["x"] + anchor["width"] / 2 - box["width"] / 2
        y = anchor["y"] - gap - box["height"] if side == "above" else anchor["y"] + anchor["height"] + gap
    else:
        y = anchor["y"] + anchor["height"] / 2 - box["height"] / 2
        x = anchor["x"] - gap - box["width"] if side == "left" else anchor["x"] + anchor["width"] + gap
    return move_element(model, element_id, x, y)
