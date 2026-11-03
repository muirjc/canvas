"""Port of diagram-core's model/standard-ops.ts: edits that apply a standard's element kinds and connector rules,
built on diagram_ops. Same conventions as diagram_ops (pure; an absent key is undefined)."""

from __future__ import annotations

from typing import Any

from canvas_api.diagram_core.diagram_ops import (
    add_node,
    update_edge_arrow_style,
    update_edge_style,
    update_node_role,
    update_node_style,
)
from canvas_api.diagram_core.jsvalues import js_truthy
from canvas_api.diagram_core.standards.kinds import (
    connector_defaults,
    is_approved_color,
    kind_defaults,
    tags_for_kind,
)

__all__ = ["add_element_of_kind", "apply_connector_rule", "apply_element_kind"]

Obj = dict[str, Any]


def _map_node(model: Obj, node_id: str, change: Any) -> Obj:
    return {**model, "nodes": [change(n) if n.get("id") == node_id else n for n in model["nodes"]]}


def _without(item: Obj, key: str) -> Obj:
    return {k: v for k, v in item.items() if k != key}


def _with_kind_tags(model: Obj, node_id: str, kind: Obj, rules: Obj | None) -> Obj:
    """Sets the node's tags for `kind` (tags_for_kind); a no-op without the rules."""
    if not js_truthy(rules):
        return model

    def retag(node: Obj) -> Obj:
        rest = _without(node, "tags")
        tags = tags_for_kind(node, kind, rules or {})
        return {**rest, "tags": tags} if tags is not None else rest

    return _map_node(model, node_id, retag)


def _with_external(model: Obj, node_id: str, external: Any) -> Obj:
    """Sets `external`, or removes the key (never stores false)."""

    def mark(node: Obj) -> Obj:
        rest = _without(node, "external")
        return {**rest, "external": True} if js_truthy(external) else rest

    return _map_node(model, node_id, mark)


def add_element_of_kind(model: Obj, kind: Obj, opts: Obj | None = None) -> Obj:
    """Adds a node of `kind`: its role (and `external`), first shape and first fill/stroke swatch; given the
    rules, the kind's tag too. Returns {"model", "nodeId"}. opts: label, position, fallbackShape, rules."""
    opts = opts or {}
    defaults = kind_defaults(kind)
    shape = defaults.get("shape")
    if shape is None:
        shape = opts.get("fallbackShape")
    label = opts.get("label")
    next_model = add_node(
        model,
        {"shape": "rectangle" if shape is None else shape, "label": kind.get("label") if label is None else label},
    )
    node_id = next_model["nodes"][-1]["id"]
    next_model = update_node_role(next_model, node_id, defaults.get("role"))
    next_model = _with_external(next_model, node_id, defaults.get("external"))
    next_model = _with_kind_tags(next_model, node_id, kind, opts.get("rules"))
    if js_truthy(defaults.get("style")):
        next_model = update_node_style(next_model, node_id, defaults["style"])
    position = opts.get("position")
    if js_truthy(position):
        next_model = _map_node(next_model, node_id, lambda n: {**n, "position": position})
    return {"model": next_model, "nodeId": node_id}


def apply_element_kind(model: Obj, node_id: str, kind: Obj, rules: Obj | None = None) -> Obj:
    """Re-kinds a node: role, `external` and (given the rules) its tag. Keeps its shape if the kind allows it,
    else the kind's first shape; keeps its fill/stroke if approved (any case), else the first swatch. No-op for
    an unknown id."""
    node = next((n for n in model["nodes"] if n.get("id") == node_id), None)
    if node is None:
        return model
    defaults = kind_defaults(kind)
    next_model = update_node_role(model, node_id, defaults.get("role"))
    next_model = _with_external(next_model, node_id, defaults.get("external"))
    next_model = _with_kind_tags(next_model, node_id, kind, rules)
    shapes = kind.get("shapes") or []
    if len(shapes) > 0 and node.get("shape") not in shapes:
        next_model = _map_node(next_model, node_id, lambda n: {**n, "shape": shapes[0]})
    style = node.get("style") or {}
    fill: Any = style.get("fillColor")
    stroke: Any = style.get("strokeColor")
    fills = kind.get("approvedFills") or []
    strokes = kind.get("approvedStrokes") or []
    patch: Obj = {}
    if len(fills) > 0 and not (js_truthy(fill) and is_approved_color(fill, fills)):
        patch["fillColor"] = fills[0]
    if len(strokes) > 0 and not (js_truthy(stroke) and is_approved_color(stroke, strokes)):
        patch["strokeColor"] = strokes[0]
    return update_node_style(next_model, node_id, patch) if patch else next_model


def apply_connector_rule(model: Obj, edge_id: str, rule: Obj) -> Obj:
    """Applies a connector rule's first arrow, line style and stroke to an edge. No-op for an unknown id."""
    if not any(e.get("id") == edge_id for e in model["edges"]):
        return model
    defaults = connector_defaults(rule)
    arrow, line_style, stroke = defaults.get("arrow"), defaults.get("lineStyle"), defaults.get("strokeColor")
    next_model = model
    if arrow is not None or line_style is not None:
        patch: Obj = {}
        if js_truthy(arrow):
            patch["arrow"] = arrow
        if js_truthy(line_style):
            patch["lineStyle"] = line_style
        next_model = update_edge_arrow_style(next_model, edge_id, patch)
    if js_truthy(stroke):
        next_model = update_edge_style(next_model, edge_id, {"strokeColor": stroke})
    return next_model
