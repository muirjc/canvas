"""Checks a diagram model against a standard's rules (packages/diagram-core/src/standards/validator.ts). Pure: the
same answer as the editor's live feedback. Severities come from DEFAULT_SEVERITY, overridden by
`severityOverrides`; none of them ever blocks a save.

Models and rules are dicts from JSON: an absent key is JavaScript's undefined, a present None is null (a check for
`!== undefined` is a check that the key is there)."""

from __future__ import annotations

from typing import Any

from canvas_api.diagram_core.colors import resolve_node_fill_stroke
from canvas_api.diagram_core.jsvalues import js_template, js_truthy
from canvas_api.diagram_core.standards.authoring import SHAPE_ALIAS_LIBRARY_ID, effective_authoring
from canvas_api.diagram_core.standards.kinds import (
    classify_node,
    is_approved_color,
    kind_group_members,
    resolve_connector_rule,
)
from canvas_api.diagram_core.standards.schema import DEFAULT_SEVERITY
from canvas_api.github.jstext import js_trim

__all__ = ["validate"]

Obj = dict[str, Any]
DIAGRAM = "(diagram)"


def _t(obj: Obj | None, key: str) -> str:
    """`${obj.key}`: "undefined" when the key is absent."""
    if obj is None or key not in obj:
        return "undefined"
    return js_template(obj[key])


def _join(values: list[Any], separator: str = ", ") -> str:
    """Array.prototype.join: null and undefined become ""."""
    return separator.join("" if v is None else js_template(v) for v in values)


def _n(value: Any) -> Any:
    """A number as JavaScript's < and > see it: null is 0."""
    return 0 if value is None else value


def _plural(count: Any, many: str) -> str:
    return "" if count == 1 and not isinstance(count, bool) else many


def _violation(
    element_id: Any, rule: str, message: str, *, element_type: str | None = None, kind_id: Any = None
) -> Obj:
    violation: Obj = {"elementId": element_id}
    if element_type is not None:
        violation["elementType"] = element_type
    if kind_id is not None:
        violation["kindId"] = kind_id
    violation.update({"rule": rule, "message": message, "severity": "warning"})
    return violation


def _is_generic(node: Obj, rules: Obj) -> bool:
    """An element that isn't one of the standard's kinds (with no kinds defined, every element is one)."""
    return len(rules.get("elementKinds") or []) == 0 or classify_node(node, rules) is None


def _check_allowed_shapes(model: Obj, rules: Obj, out: list[Obj]) -> None:
    if effective_authoring(rules)["shapes"] == "none" and not js_truthy(rules.get("requireKnownKinds")):
        for node in model["nodes"]:
            if node.get("shape") == "icon" or node.get("role") == "junction" or not _is_generic(node, rules):
                continue
            out.append(
                _violation(
                    node.get("id"),
                    "allowed-shapes",
                    f'This diagram type doesn\'t use generic shapes ("{_t(node, "shape")}"); '
                    "use one of its element kinds.",
                )
            )
        return
    allowed = rules["allowedShapeIds"]
    if len(allowed) == 0:
        return
    for node in model["nodes"]:
        if node.get("shape") not in allowed:
            out.append(
                _violation(
                    node.get("id"),
                    "allowed-shapes",
                    f'Shape "{_t(node, "shape")}" is not in the approved shape list for this diagram type '
                    f"({_join(allowed)}).",
                )
            )


def _check_mandatory_shapes(model: Obj, rules: Obj, out: list[Obj]) -> None:
    for required in rules["mandatoryShapeIds"]:
        if not any(node.get("shape") == required for node in model["nodes"]):
            out.append(
                _violation(
                    DIAGRAM,
                    "mandatory-shapes",
                    f'This diagram type requires at least one "{js_template(required)}" shape, but none was found.',
                )
            )


def _check_icon_libraries(model: Obj, rules: Obj, out: list[Obj]) -> None:
    icons = effective_authoring(rules)["icons"]
    if icons == "all":
        return
    refs = rules["allowedIconLibraryRefs"]
    for node in model["nodes"]:
        icon: Any = node.get("icon")
        if not js_truthy(icon) or icon.get("libraryId") == SHAPE_ALIAS_LIBRARY_ID:
            continue
        if icons == "none":
            if not _is_generic(node, rules) or js_truthy(rules.get("requireKnownKinds")):
                continue
            out.append(
                _violation(
                    node.get("id"),
                    "allowed-icon-libraries",
                    f'This diagram type doesn\'t use icons ("{_t(icon, "libraryId")}"); use one of its element kinds.',
                )
            )
            continue
        if not any(ref.get("libraryId") == icon.get("libraryId") for ref in refs):
            out.append(
                _violation(
                    node.get("id"),
                    "allowed-icon-libraries",
                    f'Icons from "{_t(icon, "libraryId")}" aren\'t approved for this diagram type '
                    f"({_join([ref.get('libraryId') for ref in refs])}).",
                )
            )


def _check_color_palette(model: Obj, rules: Obj, out: list[Obj]) -> None:
    palette = rules["colorPalette"]
    if len(palette) == 0:
        return
    required_by_role = {entry.get("role"): entry.get("colorHex") for entry in palette}
    for node in model["nodes"]:
        role = node.get("role")
        if not js_truthy(role):
            continue
        required = required_by_role.get(role)
        if not js_truthy(required):
            continue
        actual = (node.get("style") or {}).get("fillColor")
        if js_truthy(actual) and str(actual).lower() != str(required).lower():
            out.append(
                _violation(
                    node.get("id"),
                    "color-palette",
                    f'Nodes with role "{js_template(role)}" must use color {js_template(required)}, '
                    f"but this node uses {js_template(actual)}.",
                )
            )


def _check_font_constraints(model: Obj, rules: Obj, out: list[Obj]) -> None:
    constraints: Any = rules.get("fontConstraints")
    if not js_truthy(constraints):
        return
    for node in model["nodes"]:
        style: Any = node.get("style")
        if not js_truthy(style):
            continue
        family = constraints.get("family")
        font = style.get("fontFamily")
        if js_truthy(family) and js_truthy(font) and font != family:
            out.append(
                _violation(
                    node.get("id"),
                    "font-family",
                    f'Font "{js_template(font)}" is not the approved font "{js_template(family)}" '
                    "for this diagram type.",
                )
            )
        if "fontSize" in style:
            size = style["fontSize"]
            if "minSize" in constraints and _n(size) < _n(constraints["minSize"]):
                out.append(
                    _violation(
                        node.get("id"),
                        "font-size",
                        f"Font size {js_template(size)} is below the minimum approved size "
                        f"{js_template(constraints['minSize'])}.",
                    )
                )
            if "maxSize" in constraints and _n(size) > _n(constraints["maxSize"]):
                out.append(
                    _violation(
                        node.get("id"),
                        "font-size",
                        f"Font size {js_template(size)} exceeds the maximum approved size "
                        f"{js_template(constraints['maxSize'])}.",
                    )
                )


# ---- canvas-tfr: element kinds, connectors, containers ----


def _check_kinds(model: Obj, rules: Obj, out: list[Obj]) -> None:
    kinds = rules.get("elementKinds") or []
    if len(kinds) == 0:
        return
    counts: dict[Any, int] = {}
    connected: set[Any] = set()
    for edge in model["edges"]:
        connected.add(edge.get("sourceId"))
        connected.add(edge.get("targetId"))
    kind_labels = _join([k.get("label") for k in kinds])

    for node in model["nodes"]:
        kind = classify_node(node, rules)
        if kind is None:
            # An architecture junction is a routing point that never carries a kind.
            if node.get("role") == "junction":
                continue
            if js_truthy(rules.get("requireKnownKinds")):
                label = _t(node, "label")
                message = (
                    f'"{label}" is a "{js_template(node["role"])}", which isn\'t one of this standard\'s element kinds '
                    f"({kind_labels})."
                    if js_truthy(node.get("role"))
                    else f'"{label}" has no element kind; this standard expects one of: {kind_labels}.'
                )
                out.append(_violation(node.get("id"), "unknown-kind", message, element_type="node"))
            continue
        kind_id = kind.get("id")
        counts[kind_id] = counts.get(kind_id, 0) + 1
        kind_label = _t(kind, "label")
        node_label = _t(node, "label")

        shapes = kind["shapes"]
        if len(shapes) > 0 and node.get("shape") not in shapes:
            out.append(
                _violation(
                    node.get("id"),
                    "kind-shape",
                    f'{kind_label} "{node_label}" uses shape "{_t(node, "shape")}"; allowed: {_join(shapes)}.',
                    element_type="node",
                    kind_id=kind_id,
                )
            )
        # The fill/stroke actually drawn, so what you see is what is checked.
        colors = resolve_node_fill_stroke(node, model.get("diagramTypeId"))
        fills = kind["approvedFills"]
        if len(fills) > 0 and not is_approved_color(str(colors["fill"]), fills):
            out.append(
                _violation(
                    node.get("id"),
                    "kind-fill",
                    f'{kind_label} "{node_label}" is filled {js_template(colors["fill"])}; approved: {_join(fills)}.',
                    element_type="node",
                    kind_id=kind_id,
                )
            )
        strokes: Any = kind.get("approvedStrokes")
        if js_truthy(strokes) and len(strokes) > 0 and not is_approved_color(str(colors["stroke"]), strokes):
            out.append(
                _violation(
                    node.get("id"),
                    "kind-stroke",
                    f'{kind_label} "{node_label}" has border {js_template(colors["stroke"])}; '
                    f"approved: {_join(strokes)}.",
                    element_type="node",
                    kind_id=kind_id,
                )
            )
        if js_truthy(kind.get("requireConnection")) and node.get("id") not in connected:
            out.append(
                _violation(
                    node.get("id"),
                    "kind-unconnected",
                    f'{kind_label} "{node_label}" isn\'t connected to anything.',
                    element_type="node",
                    kind_id=kind_id,
                )
            )

    for kind in kinds:
        kind_id = kind.get("id")
        count = counts.get(kind_id, 0)
        label = _t(kind, "label")
        if "minCount" in kind and count < _n(kind["minCount"]):
            minimum = kind["minCount"]
            out.append(
                _violation(
                    DIAGRAM,
                    "kind-min-count",
                    f"Needs at least {js_template(minimum)} {label}{_plural(minimum, ' elements')}; found {count}.",
                    element_type="diagram",
                    kind_id=kind_id,
                )
            )
        if "maxCount" in kind and count > _n(kind["maxCount"]):
            maximum = kind["maxCount"]
            out.append(
                _violation(
                    DIAGRAM,
                    "kind-max-count",
                    f"Allows at most {js_template(maximum)} {label}{_plural(maximum, ' elements')}; found {count}.",
                    element_type="diagram",
                    kind_id=kind_id,
                )
            )

    # canvas-thia: count rules across several kinds together.
    for group in rules.get("kindGroups") or []:
        count = sum(counts.get(kind_id, 0) for kind_id in group.get("kindIds") or [])
        members = kind_group_members(group, rules)
        label = _t(group, "label")
        if "minCount" in group and count < _n(group["minCount"]):
            minimum = group["minCount"]
            out.append(
                _violation(
                    DIAGRAM,
                    "kind-group-min-count",
                    f"Needs at least {js_template(minimum)} {label}{_plural(minimum, ' elements')} ({members}); "
                    f"found {count}.",
                    element_type="diagram",
                )
            )
        if "maxCount" in group and count > _n(group["maxCount"]):
            maximum = group["maxCount"]
            out.append(
                _violation(
                    DIAGRAM,
                    "kind-group-max-count",
                    f"Allows at most {js_template(maximum)} {label}{_plural(maximum, ' elements')} ({members}); "
                    f"found {count}.",
                    element_type="diagram",
                )
            )


def _check_connectors(model: Obj, rules: Obj, out: list[Obj]) -> None:
    connector_rules = rules.get("connectorRules") or []
    listed_only = rules.get("connectorPolicy") == "listed-only"
    if len(connector_rules) == 0 and not listed_only:
        return
    nodes_by_id = {node.get("id"): node for node in model["nodes"]}

    def kind_of(node_id: Any) -> Obj | None:
        node = nodes_by_id.get(node_id)
        return classify_node(node, rules) if node is not None else None

    per_source_rule: dict[tuple[Any, Any], int] = {}
    for edge in model["edges"]:
        source, target = kind_of(edge.get("sourceId")), kind_of(edge.get("targetId"))
        rule = resolve_connector_rule(
            rules, source.get("id") if source is not None else None, target.get("id") if target is not None else None
        )
        from_label = _label_or(source, "unclassified element")
        to_label = _label_or(target, "unclassified element")
        if rule is None:
            if listed_only:
                out.append(
                    _violation(
                        edge.get("id"),
                        "connector-not-allowed",
                        f"This standard doesn't allow a connection from {from_label} to {to_label}.",
                        element_type="edge",
                    )
                )
            continue
        # Defaults mirror how an unstyled edge is drawn: a solid line with a target arrowhead.
        line_style = edge.get("lineStyle")
        line_style = "solid" if line_style is None else line_style
        arrow = edge.get("arrow")
        arrow = "target" if arrow is None else arrow
        line_styles: Any = rule.get("lineStyles")
        arrows: Any = rule.get("arrows")
        strokes: Any = rule.get("approvedStrokes")
        bad_line = js_truthy(line_styles) and len(line_styles) > 0 and line_style not in line_styles
        bad_arrow = js_truthy(arrows) and len(arrows) > 0 and arrow not in arrows
        style: Any = edge.get("style")
        has_stroke = js_truthy(style) and "strokeColor" in style
        stroke = style.get("strokeColor") if has_stroke else None
        bad_stroke = (
            has_stroke and js_truthy(strokes) and len(strokes) > 0 and not is_approved_color(str(stroke), strokes)
        )
        rule_label = _t(rule, "label")
        if bad_line or bad_arrow or bad_stroke:
            parts = []
            if bad_line:
                parts.append(f'line "{js_template(line_style)}" (allowed: {_join(line_styles)})')
            if bad_arrow:
                parts.append(f'arrowhead "{js_template(arrow)}" (allowed: {_join(arrows)})')
            if bad_stroke:
                parts.append(f"color {js_template(stroke)} (approved: {_join(strokes)})")
            out.append(
                _violation(
                    edge.get("id"),
                    "connector-style",
                    f"{rule_label} connector uses {', '.join(parts)}.",
                    element_type="edge",
                )
            )
        label = edge.get("label")
        if js_truthy(rule.get("requireLabel")) and not (isinstance(label, str) and js_trim(label)):
            out.append(
                _violation(
                    edge.get("id"),
                    "connector-label-required",
                    f"{rule_label} connections from {from_label} to {to_label} need a label.",
                    element_type="edge",
                )
            )
        if "maxPerSource" in rule:
            key = (edge.get("sourceId"), rule.get("id"))
            seen = per_source_rule.get(key, 0) + 1
            per_source_rule[key] = seen
            maximum = rule["maxPerSource"]
            if seen > _n(maximum):
                out.append(
                    _violation(
                        edge.get("id"),
                        "connector-max-per-source",
                        f"A {from_label} may have at most {js_template(maximum)} {rule_label} "
                        f"connection{_plural(maximum, 's')}.",
                        element_type="edge",
                    )
                )


def _label_or(kind: Obj | None, fallback: str) -> str:
    """`kind?.label ?? fallback`."""
    label = kind.get("label") if kind is not None else None
    return fallback if label is None else js_template(label)


def _check_containers(model: Obj, rules: Obj, out: list[Obj]) -> None:
    policy: Any = rules.get("containers")
    if not js_truthy(policy):
        return
    allowed = js_truthy(policy.get("allowed"))
    roles = policy.get("allowedRoles")
    for container in model["containers"]:
        role = container.get("role")
        bad_role = allowed and "allowedRoles" in policy and ("" if role is None else role) not in (roles or [])
        if not allowed or bad_role:
            label = _t(container, "label")
            message = (
                f'This standard doesn\'t use groupings, but "{label}" is one.'
                if not allowed
                else f'"{label}" is a {"plain" if role is None else js_template(role)} grouping; '
                f"allowed: {_join(roles or [])}."
            )
            out.append(_violation(container.get("id"), "container-not-allowed", message, element_type="container"))


def validate(model: Obj, rules: Obj) -> list[Obj]:
    violations: list[Obj] = []
    _check_allowed_shapes(model, rules, violations)
    _check_mandatory_shapes(model, rules, violations)
    _check_icon_libraries(model, rules, violations)
    _check_color_palette(model, rules, violations)
    _check_font_constraints(model, rules, violations)
    _check_kinds(model, rules, violations)
    _check_connectors(model, rules, violations)
    _check_containers(model, rules, violations)
    overrides = rules.get("severityOverrides") or {}
    for violation in violations:
        rule = violation["rule"]
        override = overrides.get(rule) if isinstance(overrides, dict) else None
        if override is not None:
            violation["severity"] = override
        elif rule in DEFAULT_SEVERITY:
            violation["severity"] = DEFAULT_SEVERITY[rule]
    return violations
