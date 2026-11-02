"""The fill and border a node is drawn with (resolveNodeFillStroke in packages/diagram-core/src/render/
svg-renderer.ts): its own style, else its C4 role's default (Structurizr's colours, greys for `_Ext`), else white
with a dark border. The validator checks these, so what you see is what is checked; the renderer (11d) shares it.
"""

from __future__ import annotations

from typing import Any

from canvas_api.diagram_core.jsvalues import js_truthy

__all__ = ["C4_EXTERNAL_NODE_COLORS", "C4_NODE_COLORS", "resolve_node_fill_stroke"]

C4_NODE_COLORS: dict[str, dict[str, str]] = {
    "person": {"fill": "#08427b", "stroke": "#073b6f"},
    "system": {"fill": "#1168bd", "stroke": "#1864ad"},
    "container": {"fill": "#438dd5", "stroke": "#3d81c3"},
    "component": {"fill": "#85bbf0", "stroke": "#78a8d8"},
}

C4_EXTERNAL_NODE_COLORS: dict[str, dict[str, str]] = {
    "person": {"fill": "#686868", "stroke": "#5d5d5d"},
    "system": {"fill": "#999999", "stroke": "#8a8a8a"},
    "container": {"fill": "#b3b3b3", "stroke": "#a6a6a6"},
    "component": {"fill": "#cccccc", "stroke": "#bdbdbd"},
}


def resolve_node_fill_stroke(node: dict[str, Any], diagram_type_id: Any = None) -> dict[str, Any]:
    """{fill, stroke}. `diagram_type_id` scopes the C4 defaults to C4 diagrams (ids starting "c4"); None keeps
    the role-only behaviour. A fill of "" is kept (JavaScript's `??`), only null/absent fall through."""
    c4_applies = diagram_type_id is None or str(diagram_type_id).startswith("c4")
    role = node.get("role")
    c4_default: dict[str, str] | None = None
    if c4_applies and js_truthy(role):
        if js_truthy(node.get("external")) and isinstance(role, str):
            c4_default = C4_EXTERNAL_NODE_COLORS.get(role)
        if c4_default is None and isinstance(role, str):
            c4_default = C4_NODE_COLORS.get(role)
    style = node.get("style") or {}
    fill = style.get("fillColor") if isinstance(style, dict) else None
    stroke = style.get("strokeColor") if isinstance(style, dict) else None
    if fill is None:
        fill = c4_default["fill"] if c4_default else "#ffffff"
    if stroke is None:
        stroke = c4_default["stroke"] if c4_default else "#333333"
    return {"fill": fill, "stroke": stroke}
