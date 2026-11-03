"""Port of diagram-core's model/diagram-ops.ts: the pure edits the canvas and the AI tools make to a model.

Every function takes a model (a dict, as a parser builds it) and returns a new one; the input is never changed.
Conventions, as in the parsers: None in a model is JavaScript's undefined (to_js_json leaves it out). Where
TypeScript writes a field that may be undefined (`label: input.label`), Python writes None, so the key keeps its
place and a later edit puts the value where TypeScript has it. In an input, an absent key and None are both
undefined (tool inputs are checked JSON, never null). In a patch, an absent key leaves the field alone and None
(JSON null) clears it, exactly as in TypeScript.

New elements get ids from `generate_id`, a module-level function so tests can supply the ids TypeScript generated.
"""

from __future__ import annotations

import random
import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from canvas_api.diagram_core.jsvalues import js_template, js_truthy
from canvas_api.diagram_core.model import is_allowed_link_href

__all__ = [
    "add_container",
    "add_edge",
    "add_node",
    "add_point_marker_container",
    "assign_edge_to_container",
    "assign_node_to_container",
    "generate_id",
    "ids_from",
    "move_container",
    "remove_container",
    "remove_container_parent",
    "remove_edge",
    "remove_edge_from_container",
    "remove_node",
    "remove_node_from_container",
    "resize_container",
    "set_container_direction",
    "set_container_parent",
    "set_container_role",
    "set_node_link",
    "set_sequence_autonumber",
    "update_class_members",
    "update_container_label",
    "update_edge_architecture_modifiers",
    "update_edge_arrow_style",
    "update_edge_er_cardinality",
    "update_edge_label",
    "update_edge_relation_kind",
    "update_edge_style",
    "update_entity_attributes",
    "update_node_label",
    "update_node_role",
    "update_node_stereotype",
    "update_node_style",
]

Obj = dict[str, Any]
_ABSENT = object()
_BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def _base36(number: int) -> str:
    digits = ""
    while True:
        number, rest = divmod(number, 36)
        digits = _BASE36[rest] + digits
        if number == 0:
            return digits


#: Ids to hand out before generating any, for this request only (`ids_from`).
_SUPPLIED_IDS: ContextVar[Iterator[str] | None] = ContextVar("supplied_ids", default=None)


def generate_id(prefix: str) -> str:
    """`${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`: milliseconds in base 36,
    then six random base-36 digits -- or the next supplied id (see `ids_from`)."""
    supplied = _SUPPLIED_IDS.get()
    if supplied is not None:
        next_id = next(supplied, None)
        if next_id is not None:
            return next_id
    return prefix + _base36(int(time.time() * 1000)) + "".join(random.choices(_BASE36, k=6))  # noqa: S311 (an id, not a secret)


@contextmanager
def ids_from(ids: list[str]) -> Iterator[None]:
    """New elements take these ids, in order, before any random one: so an edit repeated natively in shadow mode
    can produce exactly what the bridge did. Per context (request), not global."""
    token = _SUPPLIED_IDS.set(iter(ids))
    try:
        yield
    finally:
        _SUPPLIED_IDS.reset(token)


def _copy_given(target: Obj, source: Obj, keys: tuple[str, ...]) -> Obj:
    """`{ key: source.key }` for each key: None when absent (undefined, but the key keeps its place)."""
    for key in keys:
        target[key] = source.get(key)
    return target


def _has(items: list[Obj], item_id: Any) -> bool:
    return any(item.get("id") == item_id for item in items)


def _without(item: Obj, key: str) -> Obj:
    """`const { key: _drop, ...rest } = item`."""
    return {k: v for k, v in item.items() if k != key}


def _merge_patch(item: Obj, patch: Obj, keys: tuple[str, ...]) -> Obj:
    """Only the keys present in `patch` change: null clears one, a value sets it."""
    merged = dict(item)
    for key in keys:
        value = patch.get(key, _ABSENT)
        if value is _ABSENT:
            continue
        if value is None:
            merged.pop(key, None)
        else:
            merged[key] = value
    return merged


def _map_items(model: Obj, collection: str, item_id: Any, change: Any) -> Obj:
    return {**model, collection: [change(item) if item.get("id") == item_id else item for item in model[collection]]}


def add_node(model: Obj, node_input: Obj) -> Obj:
    """Appends a node on the "Add Shape" grid; the label defaults to "New Node"."""
    index = len(model["nodes"])
    label = node_input.get("label")
    node: Obj = {"id": generate_id("n"), "label": "New Node" if label is None else label}
    _copy_given(node, node_input, ("shape",))
    node["position"] = {"x": 40 + (index % 5) * 160, "y": 40 + (index // 5) * 120}
    return {**model, "nodes": [*model["nodes"], node]}


def add_edge(model: Obj, edge_input: Obj) -> Obj:
    """Appends an edge; its endpoints aren't checked (a parser makes implicit nodes the same way)."""
    edge: Obj = {"id": generate_id("e")}
    _copy_given(
        edge, edge_input, ("sourceId", "targetId", "label", "arrow", "erSourceCardinality", "erTargetCardinality")
    )
    return {**model, "edges": [*model["edges"], edge]}


def remove_node(model: Obj, node_id: str) -> Obj:
    """Removes a node, its edges, and its container when the node was the container's last member."""
    target = next((n for n in model["nodes"] if n.get("id") == node_id), None)
    if target is None:
        return model
    nodes = [n for n in model["nodes"] if n.get("id") != node_id]
    edges = [e for e in model["edges"] if e.get("sourceId") != node_id and e.get("targetId") != node_id]
    container_id = target.get("containerId")
    containers = model["containers"]
    if js_truthy(container_id) and not any(n.get("containerId") == container_id for n in nodes):
        containers = [c for c in containers if c.get("id") != container_id]
    return {**model, "nodes": nodes, "edges": edges, "containers": containers}


def remove_edge(model: Obj, edge_id: str) -> Obj:
    if not _has(model["edges"], edge_id):
        return model
    return {**model, "edges": [e for e in model["edges"] if e.get("id") != edge_id]}


def update_node_label(model: Obj, node_id: str, label: str) -> Obj:
    if label == "":
        raise ValueError("updateNodeLabel: shape labels must be non-empty")
    return _map_items(model, "nodes", node_id, lambda n: {**n, "label": label})


def _has_quote_or_line_break(value: Any) -> bool:
    # /["\r\n]/.test(value) reads null as the text "null".
    return isinstance(value, str) and any(ch in value for ch in '"\r\n')


def set_node_link(model: Obj, node_id: str, link: Obj | None) -> Obj:
    """Sets a node's `click href` link, or clears it with None. Refuses an href the link check rejects, and a
    quote or line break in href/tooltip (the DSL directive can't escape them)."""
    if not _has(model["nodes"], node_id):
        return model
    if link is not None:
        href: Any = link.get("href")
        if not is_allowed_link_href(href):
            raise ValueError(
                f'setNodeLink: href must use "http://", "https://", or a relative path (got "{js_template(href)}").'
            )
        if _has_quote_or_line_break(href) or ("tooltip" in link and _has_quote_or_line_break(link["tooltip"])):
            raise ValueError(
                'setNodeLink: href/tooltip cannot contain a double-quote or a line break -- the DSL "click href" '
                "directive has no escape syntax for either."
            )
    return _map_items(model, "nodes", node_id, lambda n: _without(n, "link") if link is None else {**n, "link": link})


def update_edge_label(model: Obj, edge_id: str, label: str) -> Obj:
    """An empty label clears it."""
    return _map_items(model, "edges", edge_id, lambda e: {**e, "label": label})


_STYLE_KEYS = ("fillColor", "strokeColor", "strokeWidth", "strokeDasharray", "fontFamily", "fontSize")


def _merge_style(existing: Obj | None, patch: Obj) -> Obj:
    return _merge_patch(existing or {}, patch, _STYLE_KEYS)


def update_node_style(model: Obj, node_id: str, patch: Obj) -> Obj:
    """Merges a StylePatch onto the node's style (absent: untouched, null: cleared). No-op for an unknown id."""
    if not _has(model["nodes"], node_id):
        return model
    return _map_items(model, "nodes", node_id, lambda n: {**n, "style": _merge_style(n.get("style"), patch)})


def update_edge_style(model: Obj, edge_id: str, patch: Obj) -> Obj:
    if not _has(model["edges"], edge_id):
        return model
    return _map_items(model, "edges", edge_id, lambda e: {**e, "style": _merge_style(e.get("style"), patch)})


def update_node_role(model: Obj, node_id: str, role: str | None) -> Obj:
    """Sets a node's role (None, undefined, from standard-ops for a kind without one). No-op for an unknown id."""
    if not _has(model["nodes"], node_id):
        return model
    return _map_items(model, "nodes", node_id, lambda n: {**n, "role": role})


def update_entity_attributes(model: Obj, node_id: str, attributes: list[Obj]) -> Obj:
    if not _has(model["nodes"], node_id):
        return model
    return _map_items(model, "nodes", node_id, lambda n: {**n, "attributes": attributes})


def update_class_members(model: Obj, node_id: str, members: list[Obj]) -> Obj:
    if not _has(model["nodes"], node_id):
        return model
    return _map_items(model, "nodes", node_id, lambda n: {**n, "members": members})


def update_node_stereotype(model: Obj, node_id: str, stereotype: str) -> Obj:
    """An empty stereotype clears it."""
    if not _has(model["nodes"], node_id):
        return model
    value = stereotype if js_truthy(stereotype) else None
    return _map_items(model, "nodes", node_id, lambda n: {**n, "umlStereotype": value})


def _patch_edge(model: Obj, edge_id: str, patch: Obj, keys: tuple[str, ...]) -> Obj:
    if not _has(model["edges"], edge_id):
        return model
    return _map_items(model, "edges", edge_id, lambda e: _merge_patch(e, patch, keys))


def update_edge_relation_kind(model: Obj, edge_id: str, patch: Obj) -> Obj:
    return _patch_edge(model, edge_id, patch, ("umlRelationKind", "sourceCardinality", "targetCardinality"))


def update_edge_er_cardinality(model: Obj, edge_id: str, patch: Obj) -> Obj:
    return _patch_edge(model, edge_id, patch, ("erSourceCardinality", "erTargetCardinality"))


def update_edge_arrow_style(model: Obj, edge_id: str, patch: Obj) -> Obj:
    return _patch_edge(model, edge_id, patch, ("arrow", "lineStyle"))


def update_edge_architecture_modifiers(model: Obj, edge_id: str, patch: Obj) -> Obj:
    return _patch_edge(model, edge_id, patch, ("sourceIsGroup", "targetIsGroup", "sourceAnchor", "targetAnchor"))


def add_point_marker_container(model: Obj, marker_input: Obj) -> Obj:
    """Appends a sequence activate/deactivate marker, by default after the last item on the timeline (containers
    and messages alike)."""
    index = len(model["containers"])
    # A None order is undefined here, as everywhere in a parsed model.
    orders = [item.get("sequenceOrder") for item in [*model["containers"], *model["edges"]]]
    max_order = -1
    for order in orders:
        if order is not None and order > max_order:
            max_order = order
    container: Obj = {"id": generate_id("pt"), "label": ""}
    _copy_given(container, marker_input, ("role",))
    container["attachedNodeIds"] = [marker_input.get("attachedNodeId")]
    container["position"] = {"x": 40 + (index % 3) * 360, "y": 40 + (index // 3) * 260}
    order = marker_input.get("sequenceOrder")
    container["sequenceOrder"] = max_order + 1 if order is None else order
    return {**model, "containers": [*model["containers"], container]}


def add_container(model: Obj, container_input: Obj) -> Obj:
    """Appends a container; it always has a size (300x200 by default), and it creates no membership."""
    index = len(model["containers"])
    label = container_input.get("label")
    position = container_input.get("position")
    size = container_input.get("size")
    container: Obj = {
        "id": generate_id("grp"),
        "label": "Container" if label is None else label,
        "position": {"x": 40 + (index % 3) * 360, "y": 40 + (index // 3) * 260} if position is None else position,
        "size": {"width": 300, "height": 200} if size is None else size,
    }
    _copy_given(container, container_input, ("role", "parentContainerId", "attachedNodeIds", "sequenceOrder", "style"))
    return {**model, "containers": [*model["containers"], container]}


def set_container_role(model: Obj, container_id: str, role: str) -> Obj:
    if not _has(model["containers"], container_id):
        return model
    return _map_items(model, "containers", container_id, lambda c: {**c, "role": role})


def set_container_direction(model: Obj, container_id: str, direction: str | None) -> Obj:
    """Sets a subgraph's direction; None (undefined) clears it."""
    if not _has(model["containers"], container_id):
        return model
    if direction is None:
        return _map_items(model, "containers", container_id, lambda c: _without(c, "direction"))
    return _map_items(model, "containers", container_id, lambda c: {**c, "direction": direction})


def set_container_parent(model: Obj, container_id: str, parent_container_id: str) -> Obj:
    """Nests a container in another. No-op when either is missing, or when it would nest a container inside
    itself or one of its own descendants."""
    if container_id == parent_container_id:
        return model
    containers = model["containers"]
    if not _has(containers, container_id) or not _has(containers, parent_container_id):
        return model
    ancestor: Any = parent_container_id
    seen: list[Any] = []
    while ancestor is not _ABSENT:
        if ancestor == container_id:
            return model
        # A cycle already in the data stops the walk rather than looping forever.
        if ancestor in seen:
            break
        seen.append(ancestor)
        found = next((c for c in containers if c.get("id") == ancestor), None)
        ancestor = _ABSENT if found is None else found.get("parentContainerId", _ABSENT)
    return _map_items(model, "containers", container_id, lambda c: {**c, "parentContainerId": parent_container_id})


def remove_container_parent(model: Obj, container_id: str) -> Obj:
    if not _has(model["containers"], container_id):
        return model
    return _map_items(model, "containers", container_id, lambda c: _without(c, "parentContainerId"))


def assign_edge_to_container(model: Obj, edge_id: str, container_id: str) -> Obj:
    if not _has(model["edges"], edge_id) or not _has(model["containers"], container_id):
        return model
    return _map_items(model, "edges", edge_id, lambda e: {**e, "containerId": container_id})


def remove_edge_from_container(model: Obj, edge_id: str) -> Obj:
    if not _has(model["edges"], edge_id):
        return model
    return _map_items(model, "edges", edge_id, lambda e: _without(e, "containerId"))


def update_container_label(model: Obj, container_id: str, label: str) -> Obj:
    if label == "":
        raise ValueError("updateContainerLabel: container labels must be non-empty")
    return _map_items(model, "containers", container_id, lambda c: {**c, "label": label})


def move_container(model: Obj, container_id: str, position: Obj) -> Obj:
    """Moves a container with everything in it, nested containers and their members included."""
    container = next((c for c in model["containers"] if c.get("id") == container_id), None)
    if container is None:
        return model
    dx = position["x"] - container["position"]["x"]
    dy = position["y"] - container["position"]["y"]
    if dx == 0 and dy == 0:
        return model
    moved = [container_id]
    grew = True
    while grew:
        grew = False
        for c in model["containers"]:
            parent = c.get("parentContainerId")
            if js_truthy(parent) and parent in moved and c.get("id") not in moved:
                moved.append(c.get("id"))
                grew = True
    return {
        **model,
        "containers": [
            {**c, "position": {"x": c["position"]["x"] + dx, "y": c["position"]["y"] + dy}}
            if c.get("id") in moved
            else c
            for c in model["containers"]
        ],
        "nodes": [
            {**n, "position": {"x": n["position"]["x"] + dx, "y": n["position"]["y"] + dy}}
            if js_truthy(n.get("containerId")) and n.get("containerId") in moved
            else n
            for n in model["nodes"]
        ],
    }


def resize_container(model: Obj, container_id: str, size: Obj) -> Obj:
    """Changes only the size: members neither move nor leave."""
    if not _has(model["containers"], container_id):
        return model
    return _map_items(model, "containers", container_id, lambda c: {**c, "size": size})


def assign_node_to_container(model: Obj, node_id: str, container_id: str) -> Obj:
    if not _has(model["nodes"], node_id) or not _has(model["containers"], container_id):
        return model
    return _map_items(model, "nodes", node_id, lambda n: {**n, "containerId": container_id})


def remove_node_from_container(model: Obj, node_id: str) -> Obj:
    if not _has(model["nodes"], node_id):
        return model
    return _map_items(model, "nodes", node_id, lambda n: _without(n, "containerId"))


def remove_container(model: Obj, container_id: str) -> Obj:
    """Removes a container and releases its contents: members and messages leave it, child containers move to
    the top level. Nothing else is deleted."""
    if not _has(model["containers"], container_id):
        return model

    def release(item: Obj, key: str) -> Obj:
        return _without(item, key) if item.get(key, _ABSENT) == container_id else item

    return {
        **model,
        "containers": [release(c, "parentContainerId") for c in model["containers"] if c.get("id") != container_id],
        "nodes": [release(n, "containerId") for n in model["nodes"]],
        "edges": [release(e, "containerId") for e in model["edges"]],
    }


def set_sequence_autonumber(model: Obj, patch: Obj) -> Obj:
    """Turns `autonumber` on (with start/step when given) or off."""
    if not js_truthy(patch.get("enabled")):
        if model.get("sequenceAutonumber") is None:
            return model
        return _without(model, "sequenceAutonumber")
    return {**model, "sequenceAutonumber": _copy_given({}, patch, ("start", "step"))}
