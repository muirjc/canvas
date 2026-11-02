"""Sequence-diagram lifeline/timeline geometry (packages/diagram-core/src/render/sequence-layout.ts, canvas-7vs.1):
every x/y comes from declaration and message order, never from stored positions. Shared by the SVG renderer.

The model is a JSON dict (an absent key or None is JavaScript's undefined). The result has TypeScript's
SequenceLayout shape with camelCase keys; each of its Maps is a dict keyed by id, in the Map's insertion order."""

from __future__ import annotations

from typing import Any

__all__ = ["SELF_MESSAGE_LOOP_WIDTH", "compute_sequence_layout"]

Obj = dict[str, Any]

LEFT_MARGIN = 40
HEADER_Y = 20
COLUMN_GAP = 40
ROW_HEIGHT = 50
MESSAGE_TOP_GAP = 40
BOTTOM_MARGIN = 40
RIGHT_MARGIN = 40
ACTIVATION_BAR_WIDTH = 10
ACTIVATION_LANE_STEP = 8
BLOCK_TOP_PAD = 24
BLOCK_BOTTOM_PAD = 16
BLOCK_SIDE_PAD = 20
SELF_MESSAGE_LOOP_WIDTH = 50
NOTE_SIDE_GAP = 10

# svg-renderer.ts's DEFAULT_NODE_SIZE: a participant is always a plain rectangle/person node, so `node.size ??
# DEFAULT_NODE_SIZE` is the only branch of nodeSize() that applies.
DEFAULT_HEADER_SIZE = {"width": 140, "height": 60}

TOP_LEVEL_BLOCK_ROLES = frozenset({"loop", "alt", "opt", "par", "critical", "break", "rect"})
DIVIDER_ROLES = frozenset({"else", "and", "option"})
NOTE_ROLES = frozenset({"note-left", "note-right", "note-over"})


def _empty_layout() -> Obj:
    return {
        "lifelines": {},
        "messages": {},
        "activations": {},
        "blocks": {},
        "notes": {},
        "boxes": {},
        "diagramWidth": 400,
        "diagramHeight": 300,
    }


def _order(item: Obj) -> Any:
    order = item.get("sequenceOrder")
    return 0 if order is None else order


def compute_sequence_layout(model: Obj) -> Obj:
    nodes: list[Obj] = model.get("nodes") or []
    edges: list[Obj] = model.get("edges") or []
    containers: list[Obj] = model.get("containers") or []
    if not nodes and not edges and not containers:
        return _empty_layout()

    # Lifelines: one column per participant, in declaration order.
    lifelines: dict[str, Obj] = {}
    cursor_x: Any = LEFT_MARGIN
    max_header_height: Any = 0
    for node in nodes:
        size = node.get("size")
        if size is None:
            size = DEFAULT_HEADER_SIZE
        max_header_height = max(max_header_height, size["height"])
        lifelines[node["id"]] = {
            "headerX": cursor_x,
            "headerY": HEADER_Y,
            "headerWidth": size["width"],
            "headerHeight": size["height"],
            "x": cursor_x + size["width"] / 2,
            "top": 0,
            "bottom": 0,
        }
        cursor_x += size["width"] + COLUMN_GAP
    diagram_width = cursor_x - COLUMN_GAP + RIGHT_MARGIN if nodes else 400
    lifeline_top = HEADER_Y + max_header_height
    message_top = lifeline_top + MESSAGE_TOP_GAP

    def row_y(order: Any) -> Any:
        return message_top + order * ROW_HEIGHT

    # Messages (self-messages included): position purely from sequenceOrder.
    messages: dict[str, Obj] = {}
    max_order: Any = -1
    for edge in edges:
        order = _order(edge)
        max_order = max(max_order, order)
        messages[edge["id"]] = {"y": row_y(order), "isSelfMessage": edge.get("sourceId") == edge.get("targetId")}

    containers_by_id = {c["id"]: c for c in containers}
    children_by_parent: dict[str, list[Obj]] = {}
    for container in containers:
        parent = container.get("parentContainerId")
        if parent is None:
            continue
        children_by_parent.setdefault(parent, []).append(container)
    edges_by_container: dict[Any, list[Obj]] = {}
    for edge in edges:
        edges_by_container.setdefault(edge.get("containerId"), []).append(edge)

    for container in containers:
        if container.get("sequenceOrder") is not None:
            max_order = max(max_order, container["sequenceOrder"])
    diagram_height = message_top + (max_order + 1) * ROW_HEIGHT + BOTTOM_MARGIN

    for each in lifelines.values():
        each["top"] = lifeline_top
        each["bottom"] = diagram_height - BOTTOM_MARGIN / 2

    # Activation bars: the Nth `activate` of a participant pairs with the Nth following `deactivate` (a stack).
    activations: dict[str, Obj] = {}
    open_by_participant: dict[str, list[tuple[str, Any]]] = {}
    activation_like = sorted(
        (c for c in containers if c.get("role") in ("activate", "deactivate")), key=_order
    )  # stable, like Array.prototype.sort
    for container in activation_like:
        attached = container.get("attachedNodeIds") or []
        participant_id = attached[0] if attached else None
        if not participant_id:
            continue
        order = _order(container)
        if container.get("role") == "activate":
            open_by_participant.setdefault(participant_id, []).append((container["id"], order))
        else:
            # A deactivate with nothing open leaves the map alone (TypeScript only sets on activate), which
            # keeps the leftover pass below in the same participant order.
            stack = open_by_participant.get(participant_id, [])
            opening = stack.pop() if stack else None
            lifeline = lifelines.get(participant_id)
            if opening is not None and lifeline is not None:
                lane_offset = len(stack)
                activations[opening[0]] = {
                    "participantId": participant_id,
                    "x": lifeline["x"] + lane_offset * ACTIVATION_LANE_STEP,
                    "yStart": row_y(opening[1]),
                    "yEnd": row_y(order),
                    "laneOffset": lane_offset,
                    "width": ACTIVATION_BAR_WIDTH,
                }
    # An `activate` left open runs to the diagram's bottom margin.
    for participant_id, stack in open_by_participant.items():
        lifeline = lifelines.get(participant_id)
        if lifeline is None:
            continue
        for index, (opening_id, opening_order) in enumerate(stack):
            activations[opening_id] = {
                "participantId": participant_id,
                "x": lifeline["x"] + index * ACTIVATION_LANE_STEP,
                "yStart": row_y(opening_order),
                "yEnd": lifeline["bottom"],
                "laneOffset": index,
                "width": ACTIVATION_BAR_WIDTH,
            }

    def descendant_container_ids(root_id: str) -> list[str]:
        result = {root_id: None}
        stack = [root_id]
        while stack:
            current = stack.pop()
            for child in children_by_parent.get(current, []):
                if child["id"] not in result:
                    result[child["id"]] = None
                    stack.append(child["id"])
        return list(result)

    def lifeline_xs(ids: Any) -> list[Any]:
        return [lifelines[i]["x"] for i in ids if i in lifelines]

    # Blocks (loop/alt/opt/par/critical/break/rect) and their else/and/option dividers.
    blocks: dict[str, Obj] = {}
    for block in containers:
        if not block.get("role") or block["role"] not in TOP_LEVEL_BLOCK_ROLES:
            continue
        min_order = _order(block)
        max_child_order = _order(block)
        participant_ids: dict[Any, None] = {}
        for descendant_id in descendant_container_ids(block["id"]):
            descendant = containers_by_id[descendant_id]
            if descendant.get("sequenceOrder") is not None:
                max_child_order = max(max_child_order, descendant["sequenceOrder"])
            for participant_id in descendant.get("attachedNodeIds") or []:
                participant_ids[participant_id] = None
            for edge in edges_by_container.get(descendant_id, []):
                max_child_order = max(max_child_order, _order(edge))
                participant_ids[edge.get("sourceId")] = None
                participant_ids[edge.get("targetId")] = None
        xs = lifeline_xs(participant_ids)
        left = min(xs) - BLOCK_SIDE_PAD if xs else LEFT_MARGIN
        right = max(xs) + BLOCK_SIDE_PAD if xs else diagram_width - RIGHT_MARGIN
        top = row_y(min_order) - BLOCK_TOP_PAD
        bottom = row_y(max_child_order) + BLOCK_BOTTOM_PAD
        blocks[block["id"]] = {"x": left, "y": top, "width": right - left, "height": bottom - top, "isDivider": False}
        for child in children_by_parent.get(block["id"], []):
            if child.get("role") and child["role"] in DIVIDER_ROLES:
                blocks[child["id"]] = {
                    "x": left,
                    "y": row_y(_order(child)) - BLOCK_TOP_PAD / 2,
                    "width": right - left,
                    "height": 0,
                    "isDivider": True,
                }

    # Notes: position only; their size is what the parser computed.
    notes: dict[str, Obj] = {}
    for container in containers:
        role = container.get("role")
        if not role or role not in NOTE_ROLES:
            continue
        xs = lifeline_xs(container.get("attachedNodeIds") or [])
        y = row_y(_order(container)) - ROW_HEIGHT / 4
        size = container.get("size") or {}
        width = size.get("width")
        if width is None:
            width = 0
        if role == "note-over":
            left = min(xs) if xs else LEFT_MARGIN
            right = max(xs) if xs else LEFT_MARGIN
            notes[container["id"]] = {"x": (left + right) / 2 - width / 2, "y": y}
            continue
        anchor_x = xs[0] if xs else LEFT_MARGIN
        if role == "note-left":
            notes[container["id"]] = {"x": anchor_x - width - NOTE_SIDE_GAP, "y": y}
        else:
            notes[container["id"]] = {"x": anchor_x + NOTE_SIDE_GAP, "y": y}

    # Box groupings: full diagram height, spanning their member participants' lifelines.
    boxes: dict[str, Obj] = {}
    for container in containers:
        if container.get("role") != "box":
            continue
        member_xs = lifeline_xs(n["id"] for n in nodes if n.get("containerId") == container["id"])
        left = min(member_xs) - BLOCK_SIDE_PAD if member_xs else LEFT_MARGIN
        right = max(member_xs) + BLOCK_SIDE_PAD if member_xs else diagram_width - RIGHT_MARGIN
        boxes[container["id"]] = {
            "x": left,
            "y": HEADER_Y - 10,
            "width": right - left,
            "height": diagram_height - HEADER_Y + 10,
        }

    return {
        "lifelines": lifelines,
        "messages": messages,
        "activations": activations,
        "blocks": blocks,
        "notes": notes,
        "boxes": boxes,
        "diagramWidth": diagram_width,
        "diagramHeight": diagram_height,
    }
