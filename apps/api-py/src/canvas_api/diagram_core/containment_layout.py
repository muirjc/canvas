"""Auto-layout for a freshly imported diagram with nested groups (packages/diagram-core/src/model/
containment-layout.ts, canvas-m0g): bottom-up sizing, top-down placement, rows wrapped at 900px; every group's
box encloses its children at every depth."""

from __future__ import annotations

from typing import Any

from canvas_api.diagram_core.sizes import node_size

__all__ = ["compute_containment_layout"]

PADDING = 20
HEADER_HEIGHT = 30
SIBLING_GAP = 40
MAX_ROW_WIDTH = 900
EMPTY_CONTAINER_MIN_SIZE = {"width": 160, "height": 100}

Size = dict[str, float]


def compute_containment_layout(
    nodes: list[dict[str, Any]], containers: list[dict[str, Any]], origin_x: float = 40, origin_y: float = 40
) -> tuple[dict[str, dict[str, float]], dict[str, dict[str, float]], dict[str, Size]]:
    """(node positions, container positions, container sizes), by id."""
    node_positions: dict[str, dict[str, float]] = {}
    container_positions: dict[str, dict[str, float]] = {}
    container_sizes: dict[str, Size] = {}

    child_containers: dict[str | None, list[dict[str, Any]]] = {}
    for container in containers:
        child_containers.setdefault(container.get("parentContainerId"), []).append(container)
    child_nodes: dict[str | None, list[dict[str, Any]]] = {}
    for node in nodes:
        child_nodes.setdefault(node.get("containerId"), []).append(node)
    node_index: dict[str, int] = {}
    for i, node in enumerate(nodes):
        node_index.setdefault(node["id"], i)

    def layout(container_id: str | None, at_x: float, at_y: float) -> Size:
        kids = child_containers.get(container_id, [])
        kid_nodes = child_nodes.get(container_id, [])
        is_root = container_id is None
        header_height = 0 if is_root else HEADER_HEIGHT
        kid_index: dict[str, int] = {}
        for i, c in enumerate(kids):
            kid_index.setdefault(c["id"], i)
        items: list[tuple[int, str, bool, Size]] = []
        for c in kids:
            items.append((kid_index[c["id"]], c["id"], True, {"width": 0, "height": 0}))
        for n in kid_nodes:
            items.append((node_index[n["id"]], n["id"], False, node_size(n)))
        # Array.prototype.sort is stable: equal indexes keep containers before nodes, as listed.
        items.sort(key=lambda item: item[0])

        inset_x = 0 if is_root else PADDING
        inset_y = 0 if is_root else header_height + PADDING
        cursor_x = at_x + inset_x
        cursor_y = at_y + inset_y
        row_height: float = 0
        max_right = cursor_x
        for _, item_id, is_container, item_size in items:
            size = layout(item_id, cursor_x, cursor_y) if is_container else item_size
            if is_container:
                container_positions[item_id] = {"x": cursor_x, "y": cursor_y}
                container_sizes[item_id] = size
            else:
                node_positions[item_id] = {"x": cursor_x, "y": cursor_y}
            cursor_x += size["width"] + SIBLING_GAP
            row_height = max(row_height, size["height"])
            max_right = max(max_right, cursor_x - SIBLING_GAP)
            if cursor_x - at_x > MAX_ROW_WIDTH:
                cursor_x = at_x + inset_x
                cursor_y += row_height + SIBLING_GAP
                row_height = 0
        if not is_root and not items:
            return dict(EMPTY_CONTAINER_MIN_SIZE)
        content_bottom = cursor_y + row_height
        return {"width": max_right - at_x + PADDING, "height": content_bottom - at_y + PADDING}

    layout(None, origin_x, origin_y)
    return node_positions, container_positions, container_sizes
