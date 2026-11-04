"""Ports of apps/api/src/ai/describe-model.ts and standard-prompt.ts: the "Current diagram" and "Diagram standard"
sections of the AI chat's system prompt.

Models and rules here have crossed JSON: an absent key is undefined, a present None is null (written "null" in a
template, as JavaScript writes it)."""

from __future__ import annotations

import math
from typing import Any

from canvas_api.diagram_core import layout_ops
from canvas_api.diagram_core.auto_layout import pinned_element_ids
from canvas_api.diagram_core.family_capabilities import FAMILY_SUPPORTS_ELEMENT_KINDS
from canvas_api.diagram_core.jsvalues import js_template, js_truthy
from canvas_api.diagram_core.standards import validate
from canvas_api.github.jstext import js_trim

__all__ = ["build_standard_prompt", "describe_model"]

Obj = dict[str, Any]


def _t(obj: Obj, key: str) -> str:
    """`${obj.key}`: "undefined" when the key is absent."""
    return js_template(obj[key]) if key in obj else "undefined"


def _join(values: list[Any], separator: str = ", ") -> str:
    """Array.prototype.join: null becomes ""."""
    return separator.join("" if v is None else js_template(v) for v in values)


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _num(value: Any) -> str:
    """A coordinate, rounded to a whole number (half up, as JavaScript's Math.round)."""
    return str(math.floor(value + 0.5)) if isinstance(value, int | float) and math.isfinite(value) else "?"


def _placement(model: Obj, element_id: Any) -> str:
    """canvas-p2g8.2: " at (x, y), size wxh" -- where it is drawn, so the model can reason about layout."""
    box = layout_ops.bounds_of(model, element_id) if isinstance(element_id, str) else None
    if box is None:
        return ""
    return f" at ({_num(box['x'])}, {_num(box['y'])}), size {_num(box['width'])}x{_num(box['height'])}"


def describe_model(model: Obj, rules: Obj | None = None, family: str | None = None) -> str:
    """A short summary of the diagram, so the model can refer to shapes and connectors by id; under a standard,
    each element's kind and the first ten violations too. For a family with stored positions (not sequence),
    each shape's and group's position and size, and the groups with what they contain (canvas-p2g8.2)."""
    positioned = family in layout_ops.POSITIONED_FAMILIES
    # canvas-rqm6: pinned shapes and groups stay put when the diagram is arranged.
    pinned = set(pinned_element_ids(model)) if positioned else set()
    node_lines = []
    for n in model["nodes"]:
        kind = ""
        if js_truthy(rules) and js_truthy(n.get("role")):
            kind = f", kind: {_t(n, 'role')}{' external' if js_truthy(n.get('external')) else ''}"
        where = _placement(model, n.get("id")) if positioned else ""
        inside = f", in {_t(n, 'containerId')}" if positioned and js_truthy(n.get("containerId")) else ""
        pin = ", pinned" if isinstance(n.get("id"), str) and n["id"] in pinned else ""
        node_lines.append(f'- {_t(n, "id")}: "{_t(n, "label")}" ({_t(n, "shape")}{kind}){where}{inside}{pin}')
    edge_lines = []
    for e in model["edges"]:
        label = f' ("{_t(e, "label")}")' if js_truthy(e.get("label")) else ""
        edge_lines.append(f"- {_t(e, 'id')}: {_t(e, 'sourceId')} -> {_t(e, 'targetId')}{label}")
    nodes = "\n".join(node_lines) or "(none yet)"
    edges = "\n".join(edge_lines) or "(none yet)"
    summary = f"Current shapes:\n{nodes}\n\nCurrent connectors:\n{edges}"
    if positioned and model.get("containers"):
        group_lines = []
        for c in model["containers"]:
            role = f" ({_t(c, 'role')})" if js_truthy(c.get("role")) else ""
            parent = f", in {_t(c, 'parentContainerId')}" if js_truthy(c.get("parentContainerId")) else ""
            pin = ", pinned" if isinstance(c.get("id"), str) and c["id"] in pinned else ""
            where = _placement(model, c.get("id"))
            group_lines.append(f'- {_t(c, "id")}: "{_t(c, "label")}"{role}{where}{parent}{pin}')
        summary += "\n\nCurrent groups:\n" + "\n".join(group_lines)
    if rules is not None:
        violations = validate(model, rules)[:10]
        if violations:
            listed = "\n".join(f"- [{_t(v, 'severity')}] {_t(v, 'elementId')}: {_t(v, 'message')}" for v in violations)
            summary += f"\n\nCurrent standard violations:\n{listed}"
    return summary


def _kind_line(kind: Obj) -> str:
    parts = [f'- {_t(kind, "id")} ("{_t(kind, "label")}")']
    if js_truthy(kind.get("description")):
        parts.append(f": {_t(kind, 'description')}")
    details: list[str] = []
    shapes = _list(kind.get("shapes"))
    if shapes:
        details.append(f"shapes {_join(shapes, '/')}")
    fills = _list(kind.get("approvedFills"))
    if fills:
        details.append(f"fill {_join(fills, ' or ')}")
    strokes: Any = kind.get("approvedStrokes")
    if js_truthy(strokes) and len(strokes) > 0:
        details.append(f"border {_join(strokes, ' or ')}")
    if "minCount" in kind and "maxCount" in kind and kind["minCount"] == kind["maxCount"]:
        details.append(f"exactly {_t(kind, 'minCount')}")
    else:
        if "minCount" in kind:
            details.append(f"at least {_t(kind, 'minCount')}")
        if "maxCount" in kind:
            details.append(f"at most {_t(kind, 'maxCount')}")
    if js_truthy(kind.get("requireConnection")):
        details.append("must be connected")
    if details:
        parts.append(f" [{'; '.join(details)}]")
    return "".join(parts)


def _group_line(group: Obj) -> str:
    members = _join(_list(group.get("kindIds")))
    if "minCount" in group and group["minCount"] == group.get("maxCount", object()):
        count = f"exactly {_t(group, 'minCount')}"
    else:
        bounds = [
            f"at least {_t(group, 'minCount')}" if "minCount" in group else "",
            f"at most {_t(group, 'maxCount')}" if "maxCount" in group else "",
        ]
        count = " and ".join(b for b in bounds if b)
    return f'- Group "{_t(group, "label")}": {count} element(s) in total from {members}.'


def _connector_line(rule: Obj) -> str:
    source = "any element" if rule.get("from") == "*" else _t(rule, "from")
    target = "any element" if rule.get("to") == "*" else _t(rule, "to")
    details: list[str] = []
    if js_truthy(rule.get("requireLabel")):
        details.append("needs a label")
    if "maxPerSource" in rule:
        details.append(f"at most {_t(rule, 'maxPerSource')} per source")
    for key, text in (("lineStyles", "line"), ("approvedStrokes", "color")):
        values: Any = rule.get(key)
        if js_truthy(values) and len(values) > 0:
            details.append(f"{text} {_join(values, '/' if key == 'lineStyles' else ' or ')}")
    shown = f" [{'; '.join(details)}]" if details else ""
    return f"- {_t(rule, 'label')}: {source} -> {target}{shown}"


def build_standard_prompt(rules: Obj, family: str) -> str | None:
    """The standard as a compact prompt section: the kinds to draw with, connection rules, groupings, guidance.
    None when the standard says nothing the model can use."""
    kinds = _list(rules.get("elementKinds")) if family in FAMILY_SUPPORTS_ELEMENT_KINDS else []
    lines: list[str] = []
    if kinds:
        lines.append(
            "This diagram follows a published standard. Build it only from these element kinds, using the "
            "addElement tool with the kind id (it applies the right shape and color for you):"
        )
        lines.extend(_kind_line(kind) for kind in kinds)
        lines.extend(_group_line(group) for group in _list(rules.get("kindGroups")))
        if js_truthy(rules.get("requireKnownKinds")):
            lines.append("Every element must be one of these kinds.")

    connectors = _list(rules.get("connectorRules"))
    listed_only = rules.get("connectorPolicy") == "listed-only"
    if connectors or listed_only:
        lines.append("Only these connections are allowed:" if listed_only else "Connections follow these rules:")
        lines.extend(_connector_line(rule) for rule in connectors)

    containers: Any = rules.get("containers")
    if js_truthy(containers):
        if not js_truthy(containers.get("allowed")):
            lines.append("Do not create groupings/boundaries.")
        elif js_truthy(containers.get("allowedRoles")):
            lines.append(f"Groupings allowed: {_join(containers['allowedRoles'])}.")
        else:
            lines.append("Groupings are allowed.")

    guidance = rules.get("guidance")
    if isinstance(guidance, str) and js_trim(guidance):
        lines.append(f"Guidance: {js_trim(guidance)}")

    if not lines:
        return None
    lines.append(
        "Tool results may include newViolations: standard rules your change just broke. "
        "Fix them before finishing when you can."
    )
    return "Standard for this diagram:\n" + "\n".join(lines)
