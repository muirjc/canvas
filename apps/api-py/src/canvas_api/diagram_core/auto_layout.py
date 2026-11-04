"""Auto Layout (packages/diagram-core/src/model/auto-layout.ts, canvas-p2g8.1/.2): arranges a diagram with dagre,
inside every group as well as between them, bottom-up; architecture diagrams use their own hint-following layout.

A line-by-line port, so the answer is exactly the editor's Auto Layout button's: the same walk order, the same
edge de-duplication (by the `from->to` text, collisions included), the same unknown-endpoint behaviour (an edge to
an id nobody declared still adds an empty 0x0 node to the top level's dagre graph, as graphlib does), JavaScript's
Math.round. Top level is None (TypeScript's undefined).
"""

from __future__ import annotations

import math
from collections.abc import Callable
from typing import Any

from canvas_api.diagram_core.architecture_layout import compute_architecture_layout
from canvas_api.diagram_core.dagre import Graph, layout
from canvas_api.diagram_core.jsvalues import js_template
from canvas_api.diagram_core.sizes import node_size
from canvas_api.diagram_core.svg_render import container_size

__all__ = ["AUTO_LAYOUT_FAMILIES", "auto_layout", "auto_layout_uses_direction", "supports_auto_layout"]

Model = dict[str, Any]
Position = dict[str, float]
Size = dict[str, float]

DEFAULT_NODESEP = 50
DEFAULT_RANKSEP = 60
PADDING = 20
HEADER_HEIGHT = 30
ORIGIN: Position = {"x": 40, "y": 40}

#: The families Auto Layout arranges (sequence diagrams are laid out from their message order).
AUTO_LAYOUT_FAMILIES = ("flowchart", "c4", "erd", "uml", "architecture")
#: Families whose DSL has a `direction` the chosen layout direction is written back to.
FAMILIES_WITH_DIRECTION = frozenset({"flowchart", "erd", "uml"})


def auto_layout_uses_direction(family: str) -> bool:
    return family != "architecture"


def supports_auto_layout(family: str) -> bool:
    return family in AUTO_LAYOUT_FAMILIES


def _to_dagre_rankdir(direction: Any) -> str:
    return direction if direction in ("LR", "RL", "BT") else "TB"


def _dagre_key(item_id: Any) -> str:
    """canvas-1bty.15.9: `#`-prefixed, as TypeScript does (its graphlib keeps nodes in plain objects)."""
    return f"#{item_id if isinstance(item_id, str) else js_template(item_id)}"


def js_round(x: float) -> float:
    """Math.round: halves go up (towards +Infinity), unlike Python's round()."""
    if not math.isfinite(x):
        return x
    floor = math.floor(x)
    return float(floor + 1 if x - floor >= 0.5 else floor)


def auto_layout(model: Model, direction: str | None = None, family: str = "flowchart") -> Model:
    """The model with new node positions and group positions/sizes (and, for flowchart/ERD/UML, the direction).
    The input isn't changed."""
    if not supports_auto_layout(family):
        return model
    if family == "architecture":
        return _architecture_auto_layout(model)

    resolved_direction = direction if direction is not None else model.get("direction")
    if resolved_direction is None:
        resolved_direction = "TD"

    def with_direction(m: Model) -> Model:
        return {**m, "direction": resolved_direction} if family in FAMILIES_WITH_DIRECTION else m

    nodes: list[dict[str, Any]] = model["nodes"]
    containers: list[dict[str, Any]] = model["containers"]
    if not nodes and not containers:
        return with_direction(model)

    # A container reference that doesn't exist (or a loop of groups) is treated as top level.
    container_ids = {c["id"] for c in containers}

    def known(item_id: Any) -> str | None:
        return item_id if item_id is not None and item_id in container_ids else None

    parent_of: dict[str, str | None] = {}
    for container in containers:
        parent_of[container["id"]] = known(container.get("parentContainerId"))
    for container in containers:
        seen = {container["id"]}
        level = parent_of.get(container["id"])
        while level is not None and level not in seen:
            seen.add(level)
            level = parent_of.get(level)
        if level is not None:
            parent_of[container["id"]] = None
    for node in nodes:
        parent_of[node["id"]] = known(node.get("containerId"))

    children_of: dict[str | None, list[str]] = {}
    for item_id, parent in parent_of.items():
        children_of.setdefault(parent, []).append(item_id)
    containers_by_id = {c["id"]: c for c in containers}
    nodes_by_id = {n["id"]: n for n in nodes}

    def at_level(item_id: Any, level: str | None) -> str | None:
        """The item at `level` that holds `item_id` (itself, or the ancestor group sitting directly in it). An id
        nobody declared counts as top level."""
        current = item_id
        seen: set[Any] = set()
        while current is not None and current not in seen:
            seen.add(current)
            if parent_of.get(current) == level:
                return str(current)
            current = parent_of.get(current)
        return None

    levels: dict[str | None, tuple[Size, dict[str, Position]]] = {}

    def group_size(container: dict[str, Any], inner: tuple[Size, dict[str, Position]]) -> Size:
        inner_size, inner_positions = inner
        if not inner_positions:
            return container_size(container)  # type: ignore[no-any-return]
        return {
            "width": inner_size["width"] + 2 * PADDING,
            "height": inner_size["height"] + 2 * PADDING + HEADER_HEIGHT,
        }

    def layout_level(level: str | None) -> tuple[Size, dict[str, Position]]:
        children = children_of.get(level, [])
        size_of: dict[str, Size] = {}
        for item_id in children:
            if item_id in containers_by_id:
                inner = layout_level(item_id)
                size_of[item_id] = group_size(containers_by_id[item_id], inner)
            else:
                size_of[item_id] = node_size(nodes_by_id[item_id])
        level_direction = containers_by_id[level].get("direction") if level is not None else None
        if level_direction is None:
            level_direction = resolved_direction

        rankdir = _to_dagre_rankdir(level_direction)

        # canvas-rqm6: C4's side hints. One along the layout's direction orients its connector for ranking; one
        # across it puts the two items side by side in a line (a row top-down, a column across), placed as one box.
        line_of = _build_lines(model, level, rankdir, at_level, size_of)
        across = "width" if rankdir in ("TB", "BT") else "height"
        line_sizes: dict[str, Size] = {}
        offsets: dict[str, float] = {}
        for line in {id(line): line for line in line_of.values()}.values():
            length: float = 0
            depth: float = 0
            for item_id in line:
                size = size_of[item_id]
                offsets[item_id] = length
                length += size[across] + DEFAULT_NODESEP
                depth = max(depth, size["height"] if across == "width" else size["width"])
            length -= DEFAULT_NODESEP
            line_sizes[line[0]] = (
                {"width": length, "height": depth} if across == "width" else {"width": depth, "height": length}
            )

        def rep_of(item_id: str) -> str:
            line = line_of.get(item_id)
            return line[0] if line is not None else item_id

        g = Graph()
        g.label = {
            "rankdir": rankdir,
            "nodesep": DEFAULT_NODESEP,
            "ranksep": DEFAULT_RANKSEP,
            "marginx": 0,
            "marginy": 0,
        }
        for item_id in children:
            if rep_of(item_id) != item_id:
                continue
            g.set_node(_dagre_key(item_id), dict(line_sizes.get(item_id) or size_of[item_id]))
        seen_edges: set[str] = set()

        def rank(source: str, target: str) -> None:
            a, b = rep_of(source), rep_of(target)
            if a == b:
                return
            key = f"{a}->{b}"
            if key in seen_edges:
                return
            seen_edges.add(key)
            g.set_edge(_dagre_key(a), _dagre_key(b))

        for edge in model["edges"]:
            # Only connectors whose ends both sit inside this level rank its items.
            source = at_level(edge.get("sourceId"), level)
            target = at_level(edge.get("targetId"), level)
            if not source or not target or source == target:
                continue
            if _hint_role(edge.get("layoutHint"), rankdir) == "backward":
                rank(target, source)
            else:
                rank(source, target)
        for hint in model.get("layoutHints") or []:
            source = at_level(hint.get("from"), level)
            target = at_level(hint.get("to"), level)
            if not source or not target or source == target or source not in size_of or target not in size_of:
                continue
            role = _hint_role(hint.get("direction"), rankdir)
            if role == "forward":
                rank(source, target)
            elif role == "backward":
                rank(target, source)
        if children:
            layout(g)

        positions: dict[str, Position] = {}
        min_x = min_y = math.inf
        max_x = max_y = -math.inf
        for item_id in children:
            size = size_of[item_id]
            rep = rep_of(item_id)
            box = line_sizes.get(rep) or size
            laid = g.node(_dagre_key(rep))
            x = (laid["x"] if laid.get("x") is not None else box["width"] / 2) - box["width"] / 2
            y = (laid["y"] if laid.get("y") is not None else box["height"] / 2) - box["height"] / 2
            if item_id in line_of:
                # A member of a line: its place along the line, centred across it.
                if across == "width":
                    x += offsets[item_id]
                    y += (box["height"] - size["height"]) / 2
                else:
                    x += (box["width"] - size["width"]) / 2
                    y += offsets[item_id]
            positions[item_id] = {"x": x, "y": y}
            min_x = min(min_x, x)
            min_y = min(min_y, y)
            max_x = max(max_x, x + size["width"])
            max_y = max(max_y, y + size["height"])
        # Normalise so the level's contents start at 0,0.
        for item_id, p in positions.items():
            positions[item_id] = {"x": p["x"] - min_x, "y": p["y"] - min_y}
        result: tuple[Size, dict[str, Position]] = (
            {"width": max_x - min_x, "height": max_y - min_y} if children else {"width": 0, "height": 0},
            positions,
        )
        levels[level] = result
        return result

    layout_level(None)

    # Top-down: each level's relative positions become absolute ones.
    node_positions: dict[str, Position] = {}
    container_positions: dict[str, Position] = {}
    container_sizes: dict[str, Size] = {}

    def place(level: str | None, origin: Position) -> None:
        laid_level = levels.get(level)
        if laid_level is None:
            return
        for item_id, relative in laid_level[1].items():
            absolute = {"x": js_round(origin["x"] + relative["x"]), "y": js_round(origin["y"] + relative["y"])}
            container = containers_by_id.get(item_id)
            if container is not None:
                container_positions[item_id] = absolute
                container_sizes[item_id] = group_size(container, levels[item_id])
                place(item_id, {"x": absolute["x"] + PADDING, "y": absolute["y"] + PADDING + HEADER_HEIGHT})
            else:
                node_positions[item_id] = absolute

    place(None, ORIGIN)
    return with_direction(_apply_positions(model, node_positions, container_positions, container_sizes))


def _hint_role(direction: Any, rankdir: str) -> str | None:
    """canvas-rqm6: what a side hint means in a layout running `rankdir`: "forward"/"backward" along it (the target
    ranks after or before the source), "after"/"before" across it (in a row or column). None for no side."""
    vertical = rankdir in ("TB", "BT")
    if direction == "down":
        return ("forward" if rankdir == "TB" else "backward") if vertical else "after"
    if direction == "up":
        return ("backward" if rankdir == "TB" else "forward") if vertical else "before"
    if direction == "right":
        return "after" if vertical else "forward" if rankdir == "LR" else "backward"
    if direction == "left":
        return "before" if vertical else "backward" if rankdir == "LR" else "forward"
    return None


def _build_lines(
    model: Model,
    level: str | None,
    rankdir: str,
    at_level: Callable[[Any, str | None], str | None],
    size_of: dict[str, Size],
) -> dict[str, list[str]]:
    """canvas-rqm6: the rows (or columns) a level's across-the-layout hints ask for: each item in one maps to the
    whole line, in order. Hints in order (connectors, then Lay_*); one joins two lines end to end, which keeps every
    hint already taken; one between two items already in a line is skipped."""
    line_of: dict[str, list[str]] = {}
    hints = [(e.get("sourceId"), e.get("targetId"), e.get("layoutHint")) for e in model["edges"]]
    hints += [(h.get("from"), h.get("to"), h.get("direction")) for h in model.get("layoutHints") or []]
    for source_id, target_id, direction in hints:
        role = _hint_role(direction, rankdir)
        if role not in ("after", "before"):
            continue
        source = at_level(source_id, level)
        target = at_level(target_id, level)
        if not source or not target or source == target or source not in size_of or target not in size_of:
            continue
        a = line_of.get(source) or [source]
        b = line_of.get(target) or [target]
        if a is b:
            continue
        joined = a + b if role == "after" else b + a
        for item_id in joined:
            line_of[item_id] = joined
    return line_of


def _architecture_auto_layout(model: Model) -> Model:
    node_positions, container_positions, container_sizes = compute_architecture_layout(
        model["nodes"],
        model["containers"],
        model["edges"],
        model.get("architectureAlignments") or [],
        ORIGIN["x"],
        ORIGIN["y"],
    )
    return _apply_positions(model, node_positions, container_positions, container_sizes)


def _apply_positions(
    model: Model,
    node_positions: dict[str, Position],
    container_positions: dict[str, Position],
    container_sizes: dict[str, Size],
) -> Model:
    def node_with(node: dict[str, Any]) -> dict[str, Any]:
        position = node_positions.get(node["id"])
        return {**node, "position": position} if position else node

    def container_with(container: dict[str, Any]) -> dict[str, Any]:
        position = container_positions.get(container["id"])
        size = container_sizes.get(container["id"])
        if not position and not size:
            return container
        return {
            **container,
            **({"position": position} if position else {}),
            **({"size": size} if size else {}),
        }

    return {
        **model,
        "nodes": [node_with(n) for n in model["nodes"]],
        "containers": [container_with(c) for c in model["containers"]],
    }
