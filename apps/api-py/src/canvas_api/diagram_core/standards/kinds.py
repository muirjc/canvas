"""Element kinds (packages/diagram-core/src/standards/kinds.ts): which kind a node is, which connector rule governs
an edge, what a new element of a kind gets, and whether another one may be added.

Rules and models are dicts from JSON: an absent key is JavaScript's undefined, a present None is null."""

from __future__ import annotations

from typing import Any

from canvas_api.diagram_core.jsvalues import js_template, js_truthy

__all__ = [
    "classify_node",
    "connector_defaults",
    "count_kind_group",
    "is_approved_color",
    "kind_add_blocked_reason",
    "kind_defaults",
    "kind_group_limit_message",
    "kind_group_members",
    "kind_limit_message",
    "kind_limit_reached",
    "kind_needs_tag",
    "resolve_connector_rule",
    "tags_for_kind",
]

Obj = dict[str, Any]
_ABSENT = object()


def _kinds(rules: Obj) -> list[Obj]:
    return rules.get("elementKinds") or []


def _match(kind: Obj) -> Obj | None:
    match = kind.get("match")
    return match if js_truthy(match) else None


def kind_fits_node(kind: Obj, node: Obj) -> bool:
    """Whether a node's role (+ external flag) satisfies a kind's match, ignoring tags."""
    match = _match(kind)
    role = match.get("role") if match is not None else None
    if role is None:
        role = kind.get("id")
    if role != node.get("role"):
        return False
    want = match.get("external", _ABSENT) if match is not None else _ABSENT
    # `wantExternal === undefined`: absent only; a null never equals a boolean.
    return want is _ABSENT or (isinstance(want, bool) and want == js_truthy(node.get("external")))


def classify_node(node: Obj, rules: Obj) -> Obj | None:
    """The node's element kind: a tag naming a fitting kind wins outright, else the first fitting kind."""
    if not js_truthy(node.get("role")):
        return None
    kinds = _kinds(rules)
    for tag in node.get("tags") or []:
        for kind in kinds:
            if kind.get("id") == tag and kind_fits_node(kind, node):
                return kind
    for kind in kinds:
        if kind_fits_node(kind, node):
            return kind
    return None


def kind_needs_tag(kind: Obj, rules: Obj) -> bool:
    """True when another kind would also match an element of `kind` by role (+ external) alone."""
    match = _match(kind)
    if match is None:
        return False
    role = match.get("role")
    external = match.get("external", _ABSENT)
    for other in _kinds(rules):
        if other.get("id") == kind.get("id"):
            continue
        sample_external = False if external is _ABSENT or external is None else external
        if kind_fits_node(other, {"role": role, "external": sample_external}):
            return True
        if external is _ABSENT and kind_fits_node(other, {"role": role, "external": True}):
            return True
    return False


def tags_for_kind(node: Obj, kind: Obj, rules: Obj) -> list[str] | None:
    """The node's tags after it becomes `kind`; None when nothing is left."""
    kind_ids = {k.get("id") for k in _kinds(rules)}
    others = [tag for tag in node.get("tags") or [] if tag not in kind_ids]
    tags = [kind.get("id"), *others] if kind_needs_tag(kind, rules) else others
    return tags if tags else None


def resolve_connector_rule(rules: Obj, from_kind: str | None, to_kind: str | None) -> Obj | None:
    """Exact kind->kind beats one '*' side, which beats '*'->'*'. First wins a tie."""
    best: Obj | None = None
    best_score = -1
    for rule in rules.get("connectorRules") or []:
        source, target = rule.get("from"), rule.get("to")
        from_ok = source == "*" or (from_kind is not None and source == from_kind)
        to_ok = target == "*" or (to_kind is not None and target == to_kind)
        if not from_ok or not to_ok:
            continue
        score = (0 if source == "*" else 1) + (0 if target == "*" else 1)
        if score > best_score:
            best, best_score = rule, score
    return best


def kind_defaults(kind: Obj) -> Obj:
    """What a new element of `kind` gets: role (+ external), first shape, first fill/stroke swatch."""
    match = _match(kind)
    role = match.get("role") if match is not None else None
    defaults: Obj = {"role": kind.get("id") if role is None else role}
    if match is not None and match.get("external", _ABSENT) is not _ABSENT:
        defaults["external"] = match["external"]
    shapes = kind.get("shapes") or []
    if len(shapes) > 0:
        defaults["shape"] = shapes[0]
    style: Obj = {}
    fills = kind.get("approvedFills") or []
    if len(fills) > 0:
        style["fillColor"] = fills[0]
    strokes: Any = kind.get("approvedStrokes")
    if js_truthy(strokes) and len(strokes) > 0:
        style["strokeColor"] = strokes[0]
    if style:
        defaults["style"] = style
    return defaults


def connector_defaults(rule: Obj) -> Obj:
    """The first listed arrow / line style / stroke of a connector rule."""
    defaults: Obj = {}
    for key, field in (("arrows", "arrow"), ("lineStyles", "lineStyle"), ("approvedStrokes", "strokeColor")):
        values: Any = rule.get(key)
        if js_truthy(values) and len(values) > 0:
            defaults[field] = values[0]
    return defaults


def is_approved_color(color: str, approved: list[str]) -> bool:
    """Case-insensitive membership for hex swatch lists."""
    lower = color.lower()
    return any(c.lower() == lower for c in approved)


def _count(value: Any) -> Any:
    """A count as JavaScript compares it: null is 0."""
    return 0 if value is None else value


def kind_limit_reached(model: Obj, rules: Obj, kind: Obj, ignore_node_id: str | None = None) -> bool:
    if "maxCount" not in kind:
        return False
    count = sum(
        1
        for node in model["nodes"]
        if node.get("id") != ignore_node_id and (classify_node(node, rules) or {}).get("id") == kind.get("id")
    )
    return bool(count >= _count(kind["maxCount"]))


def kind_limit_message(kind: Obj) -> str:
    maximum = kind.get("maxCount")
    if maximum is None:
        maximum = 0
    label = js_template(kind.get("label")) if "label" in kind else "undefined"
    if maximum == 1:
        return f"This diagram already has its 1 {label}."
    return f"This diagram already has its {js_template(maximum)} {label} elements, the most allowed."


def kind_group_members(group: Obj, rules: Obj) -> str:
    """ "New Component, Reused Component or Retired Component"."""
    labels: list[Any] = []
    for kind_id in group.get("kindIds") or []:
        kind = next((k for k in _kinds(rules) if k.get("id") == kind_id), None)
        label = kind.get("label") if kind is not None else None
        labels.append(kind_id if label is None else label)

    def joined(values: list[Any], separator: str) -> str:  # Array.join: null and undefined are ""
        return separator.join("" if v is None else js_template(v) for v in values)

    if len(labels) <= 1:
        return joined(labels, "")
    return f"{joined(labels[:-1], ', ')} or {js_template(labels[-1])}"


def count_kind_group(model: Obj, rules: Obj, group: Obj, ignore_node_id: str | None = None) -> int:
    members = set(group.get("kindIds") or [])
    count = 0
    for node in model["nodes"]:
        if node.get("id") == ignore_node_id:
            continue
        kind = classify_node(node, rules)
        if kind is not None and kind.get("id") in members:
            count += 1
    return count


def kind_group_limit_message(group: Obj, rules: Obj) -> str:
    maximum = group.get("maxCount")
    if maximum is None:
        maximum = 0
    members = kind_group_members(group, rules)
    label = js_template(group.get("label")) if "label" in group else "undefined"
    if maximum == 1:
        return f"This diagram already has its 1 {label} ({members})."
    return f"This diagram already has its {js_template(maximum)} {label} elements ({members}), the most allowed."


def kind_add_blocked_reason(model: Obj, rules: Obj, kind: Obj, ignore_node_id: str | None = None) -> str | None:
    """Why another element of this kind can't be added: its own Max count, or a full group it belongs to."""
    if kind_limit_reached(model, rules, kind, ignore_node_id):
        return kind_limit_message(kind)
    for group in rules.get("kindGroups") or []:
        if "maxCount" not in group or kind.get("id") not in (group.get("kindIds") or []):
            continue
        if count_kind_group(model, rules, group, ignore_node_id) >= _count(group["maxCount"]):
            return kind_group_limit_message(group, rules)
    return None
