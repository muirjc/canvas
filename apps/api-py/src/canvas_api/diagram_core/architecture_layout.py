"""Fresh-import layout for architecture-beta diagrams (packages/diagram-core/src/model/architecture-layout.ts,
jmuir-dtu.26): a small grid layout per group level, bottom-up, that honours edge anchor sides and `align`
rows/columns, then flows disconnected clusters left to right like the containment layout.

A line-by-line port: the same walk order, the same cell collisions, the same float arithmetic. Top level is
None (TypeScript's undefined).
"""

from __future__ import annotations

from typing import Any

from canvas_api.diagram_core.sizes import node_size

__all__ = ["compute_architecture_layout"]

PADDING = 20
HEADER_HEIGHT = 30
CELL_GAP = 60
CLUSTER_GAP = 60
MAX_ROW_WIDTH = 900
EMPTY_GROUP_MIN_SIZE: dict[str, float] = {"width": 160, "height": 100}

Direction = tuple[int, int]
SIDE: dict[str, Direction] = {"T": (0, -1), "B": (0, 1), "L": (-1, 0), "R": (1, 0)}
RIGHT: Direction = (1, 0)
DOWN: Direction = (0, 1)

# Walk order: anchored edges, then align, then edges with no anchors.
ANCHORED = 0
ALIGNED = 1
LOOSE = 2

Position = dict[str, float]
Size = dict[str, float]
Link = tuple[str, Direction, int]


def compute_architecture_layout(
    nodes: list[dict[str, Any]],
    containers: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    alignments: list[dict[str, Any]] | None = None,
    origin_x: float = 40,
    origin_y: float = 40,
) -> tuple[dict[str, Position], dict[str, Position], dict[str, Size]]:
    """(node positions, container positions, container sizes), by id."""
    alignments = alignments or []
    group_ids = {group["id"] for group in containers}

    def known(level_id: Any) -> str | None:
        return level_id if level_id is not None and level_id in group_ids else None

    parent_of: dict[str, str | None] = {}
    for group in containers:
        parent_of[group["id"]] = known(group.get("parentContainerId"))
    for node in nodes:
        parent_of[node["id"]] = known(node.get("containerId"))
    for group in containers:
        seen = {group["id"]}
        level = parent_of.get(group["id"])
        while level is not None and level not in seen:
            seen.add(level)
            level = parent_of.get(level)
        if level is not None:
            parent_of[group["id"]] = None

    def ancestry(item_id: str) -> list[str | None]:
        chain: list[str | None] = []
        level = parent_of.get(item_id)
        while level is not None:
            chain.append(level)
            level = parent_of.get(level)
        chain.append(None)
        return chain

    def representative_in(item_id: str, level: str | None) -> str:
        current = item_id
        while parent_of.get(current) != level:
            current = parent_of[current] or ""
        return current

    links_by_level: dict[str | None, dict[str, list[Link]]] = {}

    def add_link(level: str | None, from_: str, to: str, direction: Direction, strength: int) -> None:
        level_links = links_by_level.setdefault(level, {})
        level_links.setdefault(from_, []).append((to, direction, strength))
        level_links.setdefault(to, []).append((from_, (-direction[0], -direction[1]), strength))

    for edge in edges:
        source, target = edge["sourceId"], edge["targetId"]
        if source not in parent_of or target not in parent_of or source == target:
            continue
        target_chain = set(ancestry(target))
        level = next((candidate for candidate in ancestry(source) if candidate in target_chain), None)
        from_ = representative_in(source, level)
        to = representative_in(target, level)
        if from_ == to:
            continue
        # A source anchor names the side facing the target; a target anchor the side facing the source.
        direction = RIGHT
        strength = LOOSE
        if edge.get("sourceAnchor"):
            direction = SIDE[edge["sourceAnchor"]]
            strength = ANCHORED
        elif edge.get("targetAnchor"):
            side = SIDE[edge["targetAnchor"]]
            direction = (-side[0], -side[1])
            strength = ANCHORED
        add_link(level, from_, to, direction, strength)

    for alignment in alignments:
        direction = RIGHT if alignment["axis"] == "row" else DOWN
        ids = [i for i in alignment["ids"] if i in parent_of]
        for i in range(1, len(ids)):
            # Mermaid only aligns siblings; ids from different levels are skipped rather than lifted.
            if parent_of.get(ids[i]) != parent_of.get(ids[i - 1]):
                continue
            add_link(parent_of.get(ids[i]), ids[i - 1], ids[i], direction, ALIGNED)

    children_of: dict[str | None, list[tuple[str, bool]]] = {}
    # Declaration order, groups first.
    for item in [(g["id"], True) for g in containers] + [(n["id"], False) for n in nodes]:
        children_of.setdefault(parent_of.get(item[0]), []).append(item)
    nodes_by_id = {node["id"]: node for node in nodes}

    local_offsets: dict[str, Position] = {}
    group_sizes: dict[str, Size] = {}

    def layout_level(level: str | None) -> Size:
        items = children_of.get(level, [])
        sizes: dict[str, Size] = {}
        for item_id, is_group in items:
            if is_group:
                inner = layout_level(item_id)
                size = (
                    EMPTY_GROUP_MIN_SIZE
                    if inner["width"] == 0
                    else {
                        "width": inner["width"] + PADDING * 2,
                        "height": inner["height"] + HEADER_HEIGHT + PADDING * 2,
                    }
                )
                group_sizes[item_id] = size
                sizes[item_id] = size
            else:
                sizes[item_id] = node_size(nodes_by_id[item_id])

        links = links_by_level.get(level, {})
        cell: dict[str, tuple[int, int]] = {}
        clusters: list[list[str]] = []

        for seed_id, _ in items:
            if seed_id in cell:
                continue
            occupied: dict[tuple[int, int], str] = {}

            def place(
                item_id: str, col: int, row: int, direction: Direction, occupied: dict[tuple[int, int], str] = occupied
            ) -> None:
                while (col, row) in occupied:
                    col += direction[0]
                    row += direction[1]
                cell[item_id] = (col, row)
                occupied[(col, row)] = item_id

            members = [seed_id]
            place(seed_id, 0, 0, RIGHT)
            # Breadth-first, each strength tier drained before weaker links are followed.
            for strength in (ANCHORED, ALIGNED, LOOSE):
                queue = list(members)
                while queue:
                    item_id = queue.pop(0)
                    here = cell[item_id]
                    for to, direction, link_strength in links.get(item_id, []):
                        if link_strength > strength or to in cell:
                            continue
                        place(to, here[0] + direction[0], here[1] + direction[1], direction)
                        members.append(to)
                        queue.append(to)
            clusters.append(members)

        cursor_x: float = 0
        cursor_y: float = 0
        row_height: float = 0
        max_right: float = 0
        max_bottom: float = 0
        for members in clusters:
            min_col = min(cell[i][0] for i in members)
            min_row = min(cell[i][1] for i in members)
            col_widths: dict[int, float] = {}
            row_heights: dict[int, float] = {}
            for item_id in members:
                col, row = cell[item_id]
                size = sizes[item_id]
                col_widths[col - min_col] = max(col_widths.get(col - min_col, 0), size["width"])
                row_heights[row - min_row] = max(row_heights.get(row - min_row, 0), size["height"])
            col_count = max(col_widths) + 1
            row_count = max(row_heights) + 1
            col_x: list[float] = []
            row_y: list[float] = []
            x: float = 0
            for c in range(col_count):
                col_x.append(x)
                x += col_widths.get(c, 0) + CELL_GAP
            y: float = 0
            for r in range(row_count):
                row_y.append(y)
                y += row_heights.get(r, 0) + CELL_GAP
            block_width = x - CELL_GAP
            block_height = y - CELL_GAP

            if cursor_x > 0 and cursor_x + block_width > MAX_ROW_WIDTH:
                cursor_x = 0
                cursor_y += row_height + CLUSTER_GAP
                row_height = 0
            for item_id in members:
                col, row = cell[item_id]
                size = sizes[item_id]
                c, r = col - min_col, row - min_row
                local_offsets[item_id] = {
                    "x": cursor_x + col_x[c] + (col_widths.get(c, 0) - size["width"]) / 2,
                    "y": cursor_y + row_y[r] + (row_heights.get(r, 0) - size["height"]) / 2,
                }
            max_right = max(max_right, cursor_x + block_width)
            max_bottom = max(max_bottom, cursor_y + block_height)
            row_height = max(row_height, block_height)
            cursor_x += block_width + CLUSTER_GAP
        return {"width": max_right, "height": max_bottom}

    layout_level(None)

    node_positions: dict[str, Position] = {}
    container_positions: dict[str, Position] = {}
    container_sizes: dict[str, Size] = {}

    def place_level(level: str | None, content_x: float, content_y: float) -> None:
        for item_id, is_group in children_of.get(level, []):
            offset = local_offsets.get(item_id)
            if offset is None:
                continue
            position = {"x": content_x + offset["x"], "y": content_y + offset["y"]}
            if is_group:
                container_positions[item_id] = position
                container_sizes[item_id] = group_sizes.get(item_id, EMPTY_GROUP_MIN_SIZE)
                place_level(item_id, position["x"] + PADDING, position["y"] + HEADER_HEIGHT + PADDING)
            else:
                node_positions[item_id] = position

    place_level(None, origin_x, origin_y)
    return node_positions, container_positions, container_sizes
