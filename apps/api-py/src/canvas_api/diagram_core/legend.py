"""A diagram legend: which entries it shows and where (packages/diagram-core/src/render/legend.ts, canvas-ltk).

Automatic entries come from the standard (one per element kind and connector rule the diagram uses, in the
standard's order); the author's `model.legend` hides or renames them and adds its own. Sequence diagrams have no
legend. Models and rules are JSON dicts (absent or None = undefined); results use TypeScript's camelCase keys."""

from __future__ import annotations

from typing import Any

from canvas_api.diagram_core.jsvalues import js_truthy
from canvas_api.diagram_core.standards.kinds import classify_node, resolve_connector_rule
from canvas_api.github.jstext import js_len, js_trim

__all__ = ["LEGEND_METRICS", "compute_legend_entries", "legend_layout"]

Obj = dict[str, Any]

LEGEND_METRICS: dict[str, float] = {
    "padding": 12,
    "titleHeight": 22,
    "rowHeight": 30,
    "sampleWidth": 36,
    "sampleHeight": 22,
    "gap": 10,
    "fontSize": 12,
    # Rough width per character for sizing the box (no font metrics in a pure function).
    "charWidth": 7,
    "minWidth": 140,
    # Space between the content and a legend placed beside it.
    "offset": 24,
}


def _first(values: Any) -> Any:
    """`values?.[0]`."""
    return values[0] if isinstance(values, list) and values else None


def _coalesce(*values: Any) -> Any:
    """`a ?? b ?? ...`."""
    for value in values:
        if value is not None:
            return value
    return None


def _style(item: Obj) -> Obj:
    style = item.get("style")
    return style if isinstance(style, dict) else {}


def compute_legend_entries(model: Obj, rules: Obj | None) -> list[Obj]:
    """[{key, label, sample, automatic}]: automatic entries in the standard's order, then the author's."""
    if model.get("diagramTypeId") == "sequence":
        return []
    legend = model.get("legend")
    legend = legend if isinstance(legend, dict) else None
    hidden = set((legend or {}).get("hidden") or [])
    labels = (legend or {}).get("labels")

    def rename(key: str, label: Any) -> Any:
        override = labels.get(key) if isinstance(labels, dict) else None
        return label if override is None else override

    entries: list[Obj] = []
    if rules is not None and js_truthy(rules):
        kind_of: dict[str, Any] = {}
        first_node_of_kind: dict[Any, Obj] = {}
        for node in model.get("nodes") or []:
            kind = classify_node(node, rules)
            if not kind:
                continue
            kind_of[node["id"]] = kind.get("id")
            first_node_of_kind.setdefault(kind.get("id"), node)
        for kind in rules.get("elementKinds") or []:
            node = first_node_of_kind.get(kind.get("id"))
            key = f"kind:{kind.get('id')}"
            if node is None or key in hidden:
                continue
            fill = _coalesce(_style(node).get("fillColor"), _first(kind.get("approvedFills")))
            stroke = _coalesce(_style(node).get("strokeColor"), _first(kind.get("approvedStrokes")))
            sample: Obj = {"kind": "shape", "shape": node.get("shape")}
            if js_truthy(fill):
                sample["fill"] = fill
            if js_truthy(stroke):
                sample["stroke"] = stroke
            entries.append({"key": key, "label": rename(key, kind.get("label")), "sample": sample, "automatic": True})

        first_edge_of_rule: dict[Any, Obj] = {}
        for edge in model.get("edges") or []:
            rule = resolve_connector_rule(rules, kind_of.get(edge.get("sourceId")), kind_of.get(edge.get("targetId")))
            if rule:
                first_edge_of_rule.setdefault(rule.get("id"), edge)
        for rule in rules.get("connectorRules") or []:
            edge = first_edge_of_rule.get(rule.get("id"))
            key = f"connector:{rule.get('id')}"
            if edge is None or key in hidden:
                continue
            line_style = _coalesce(edge.get("lineStyle"), _first(rule.get("lineStyles")))
            arrow = _coalesce(edge.get("arrow"), _first(rule.get("arrows")), "target")
            stroke = _coalesce(_style(edge).get("strokeColor"), _first(rule.get("approvedStrokes")))
            sample = {"kind": "line", "arrow": arrow}
            if js_truthy(line_style):
                sample["lineStyle"] = line_style
            if js_truthy(stroke):
                sample["stroke"] = stroke
            entries.append({"key": key, "label": rename(key, rule.get("label")), "sample": sample, "automatic": True})

    for extra in (legend or {}).get("extra") or []:
        entries.append(
            {
                "key": f"extra:{extra.get('id')}",
                "label": extra.get("label"),
                "sample": extra.get("sample"),
                "automatic": False,
            }
        )
    return entries


def legend_layout(model: Obj, entries: list[Obj], content_bounds: Obj) -> Obj | None:
    """The legend box and its rows; None when there's no visible legend or nothing to show. Without a saved
    position it sits beside the content (`content_bounds`: width/height without the legend), top-aligned."""
    legend = model.get("legend")
    if not isinstance(legend, dict) or not js_truthy(legend.get("visible")) or not entries:
        return None
    if model.get("diagramTypeId") == "sequence":
        return None
    m = LEGEND_METRICS
    raw_title = legend.get("title")
    title = js_trim(raw_title) if raw_title is not None else None
    longest = max(js_len(title) if title is not None else 0, *(js_len(e["label"]) for e in entries))
    width = max(m["minWidth"], m["padding"] * 2 + m["sampleWidth"] + m["gap"] + longest * m["charWidth"])
    title_height = m["titleHeight"] if title else 0
    height = m["padding"] * 2 + title_height + len(entries) * m["rowHeight"]
    position = legend.get("position")
    position = position if isinstance(position, dict) else {}
    x = _coalesce(position.get("x"), max(0, content_bounds["width"] - 40 + m["offset"]))
    y = _coalesce(position.get("y"), 40)
    top = y + m["padding"] + title_height
    layout: Obj = {"x": x, "y": y, "width": width, "height": height}
    if title:
        layout["title"] = {"text": title, "x": x + m["padding"], "y": y + m["padding"] + m["fontSize"]}
    layout["rows"] = [
        {
            "entry": entry,
            "y": top + i * m["rowHeight"],
            "sampleX": x + m["padding"],
            "labelX": x + m["padding"] + m["sampleWidth"] + m["gap"],
        }
        for i, entry in enumerate(entries)
    ]
    return layout
