"""Whether a standard's own definition is coherent for the family it applies to (packages/diagram-core/src/
standards/definition-check.ts): checkStandardDefinition's blocking issues and standardDefinitionNotices' notes."""

from __future__ import annotations

import re
from typing import Any

from canvas_api.diagram_core.c4 import C4_ELEMENT_ROLES, C4_ROLE_SHAPES
from canvas_api.diagram_core.family_capabilities import (
    FAMILY_KIND_SHAPES,
    FAMILY_RESERVED_KIND_IDS,
    FAMILY_SUPPORTS_ELEMENT_KINDS,
)
from canvas_api.diagram_core.jsvalues import js_template, js_truthy
from canvas_api.diagram_core.standards.kinds import classify_node
from canvas_api.diagram_core.standards.schema import DIAGRAM_TYPE_ID_PATTERN, KIND_ID_PATTERN, RESERVED_KIND_IDS
from canvas_api.github.jstext import js_trim

__all__ = ["check_standard_definition", "standard_definition_notices"]

Obj = dict[str, Any]
#: /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
HEX = re.compile(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})")


def _t(obj: Obj, key: str) -> str:
    """`${obj.key}`: "undefined" when the key is absent."""
    return js_template(obj[key]) if key in obj else "undefined"


def _matches(pattern: re.Pattern[str], value: Any) -> bool:
    """RegExp.test: the value is converted to a string first."""
    text = "undefined" if value is _MISSING else js_template(value)
    return pattern.fullmatch(text) is not None


_MISSING = object()


def _blank(value: Any) -> bool:
    """`!value?.trim()`."""
    return value is None or (isinstance(value, str) and js_trim(value) == "")


def _n(value: Any) -> Any:
    return 0 if value is None else value


def _issue(path: str, message: str) -> Obj:
    return {"path": path, "message": message}


def check_standard_definition(rules: Obj, family: str) -> list[Obj]:
    """[] when valid; otherwise each problem with its dotted path into the rules."""
    issues: list[Obj] = []
    kinds = rules.get("elementKinds") or []
    authoring = rules.get("authoring") or {}

    if len(kinds) > 0 and family not in FAMILY_SUPPORTS_ELEMENT_KINDS:
        issues.append(_issue("elementKinds", f'Element kinds aren\'t supported for the "{family}" diagram family.'))

    # canvas-7ewa: "What authors can add".
    if authoring.get("shapes") == "listed" and len(rules["allowedShapeIds"]) == 0:
        issues.append(_issue("authoring.shapes", "Choose at least one shape, or pick All or None."))
    if authoring.get("icons") == "listed" and len(rules["allowedIconLibraryRefs"]) == 0:
        issues.append(_issue("authoring.icons", "Choose at least one icon library, or pick All or None."))
    if len(kinds) == 0 and authoring.get("shapes") == "none" and authoring.get("icons") == "none":
        issues.append(
            _issue("authoring", "With no element kinds, no shapes and no icons, authors would have nothing to add.")
        )

    family_shapes = FAMILY_KIND_SHAPES.get(family, FAMILY_KIND_SHAPES["flowchart"])
    reserved = (*RESERVED_KIND_IDS, *FAMILY_RESERVED_KIND_IDS.get(family, ()))
    seen_kind_ids: set[Any] = set()
    for i, kind in enumerate(kinds):
        at = f"elementKinds[{i}]"
        kind_id = kind.get("id", _MISSING)
        id_text = _t(kind, "id")
        if not _matches(KIND_ID_PATTERN, kind_id):
            issues.append(
                _issue(
                    f"{at}.id",
                    f'Kind id "{id_text}" must start with a lowercase letter and use only lowercase letters, digits '
                    "and underscores.",
                )
            )
        elif str(kind_id).lower() in reserved:
            issues.append(_issue(f"{at}.id", f'Kind id "{id_text}" is a reserved word.'))
        hashable_id = None if kind_id is _MISSING else kind_id
        if hashable_id in seen_kind_ids:
            issues.append(_issue(f"{at}.id", f'Duplicate kind id "{id_text}".'))
        seen_kind_ids.add(hashable_id)

        if _blank(kind.get("label")):
            issues.append(_issue(f"{at}.label", "A kind needs a label."))

        for shape in kind["shapes"]:
            if shape not in family_shapes:
                issues.append(
                    _issue(f"{at}.shapes", f'Shape "{js_template(shape)}" isn\'t available for {family} diagrams.')
                )
        for fill in kind["approvedFills"]:
            if not _matches(HEX, fill):
                issues.append(
                    _issue(f"{at}.approvedFills", f'"{js_template(fill)}" isn\'t a hex color (#rgb or #rrggbb).')
                )
        for stroke in kind.get("approvedStrokes") or []:
            if not _matches(HEX, stroke):
                issues.append(
                    _issue(f"{at}.approvedStrokes", f'"{js_template(stroke)}" isn\'t a hex color (#rgb or #rrggbb).')
                )

        _check_counts(kind, at, issues)
        seen_types: set[str] = set()
        for type_id in kind.get("linkTo") or []:
            if not _matches(DIAGRAM_TYPE_ID_PATTERN, type_id):
                issues.append(_issue(f"{at}.linkTo", f'"{js_template(type_id)}" isn\'t a diagram type id.'))
            elif js_template(type_id) in seen_types:
                issues.append(_issue(f"{at}.linkTo", f'"{js_template(type_id)}" is listed twice.'))
            seen_types.add(js_template(type_id))

        match = kind.get("match")
        if js_truthy(match):
            if family != "c4":
                issues.append(_issue(f"{at}.match", "Role matching is only used for C4 diagrams."))
            elif match.get("role") not in C4_ELEMENT_ROLES:
                issues.append(
                    _issue(
                        f"{at}.match",
                        f'"{_t(match, "role")}" isn\'t a C4 element role ({", ".join(C4_ELEMENT_ROLES)}).',
                    )
                )

        # canvas-syd: a C4 element's shape follows from its role.
        c4_role: Any = None
        if family == "c4":
            c4_role = match.get("role") if js_truthy(match) and match.get("role") is not None else kind.get("id")
        role_shapes = C4_ROLE_SHAPES.get(c4_role) if isinstance(c4_role, str) and c4_role else None
        if role_shapes:
            unusable = [shape for shape in kind["shapes"] if shape not in role_shapes]
            if unusable:
                shown = " or ".join(f'"{js_template(s)}"' for s in unusable)
                issues.append(
                    _issue(
                        f"{at}.shapes",
                        f"A C4 {c4_role} element can't be drawn as {shown}; {c4_role} elements use "
                        f"{', '.join(role_shapes)}.",
                    )
                )

    # canvas-thia: kind groups.
    seen_group_ids: set[Any] = set()
    for i, group in enumerate(rules.get("kindGroups") or []):
        at = f"kindGroups[{i}]"
        group_id = group.get("id", _MISSING)
        id_text = _t(group, "id")
        if not _matches(KIND_ID_PATTERN, group_id):
            issues.append(
                _issue(
                    f"{at}.id",
                    f'Group id "{id_text}" must start with a lowercase letter and use only lowercase letters, digits '
                    "and underscores.",
                )
            )
        hashable_id = None if group_id is _MISSING else group_id
        if hashable_id in seen_group_ids:
            issues.append(_issue(f"{at}.id", f'Duplicate group id "{id_text}".'))
        seen_group_ids.add(hashable_id)
        if _blank(group.get("label")):
            issues.append(_issue(f"{at}.label", "A group needs a name."))
        unique = list(dict.fromkeys(group["kindIds"]))
        if len(unique) < 2:
            issues.append(_issue(f"{at}.kindIds", "A group needs at least two element kinds."))
        for kind_id in unique:
            if kind_id not in seen_kind_ids:
                issues.append(_issue(f"{at}.kindIds", f'"{js_template(kind_id)}" isn\'t a defined element kind.'))
        _check_counts(group, at, issues)
        if "minCount" not in group and "maxCount" not in group:
            issues.append(_issue(f"{at}.maxCount", "Set a minimum or a maximum count for the group."))

    seen_connector_ids: set[Any] = set()
    for i, rule in enumerate(rules.get("connectorRules") or []):
        at = f"connectorRules[{i}]"
        rule_id = rule.get("id")
        if rule_id in seen_connector_ids:
            issues.append(_issue(f"{at}.id", f'Duplicate connector rule id "{_t(rule, "id")}".'))
        seen_connector_ids.add(rule_id)
        for side in ("from", "to"):
            ref = rule.get(side)
            if ref != "*" and ref not in seen_kind_ids:
                issues.append(_issue(f"{at}.{side}", f'"{_t(rule, side)}" isn\'t a defined element kind (or "*").'))
        for stroke in rule.get("approvedStrokes") or []:
            if not _matches(HEX, stroke):
                issues.append(
                    _issue(f"{at}.approvedStrokes", f'"{js_template(stroke)}" isn\'t a hex color (#rgb or #rrggbb).')
                )

    return issues


def _check_counts(item: Obj, at: str, issues: list[Obj]) -> None:
    """Negative counts, and a minimum above the maximum (kinds and groups share these)."""
    if _n(item.get("minCount")) < 0 or _n(item.get("maxCount")) < 0:
        issues.append(_issue(f"{at}.minCount", "Counts cannot be negative."))
    if "minCount" in item and "maxCount" in item and _n(item["minCount"]) > _n(item["maxCount"]):
        issues.append(
            _issue(
                f"{at}.minCount",
                f"Minimum count {js_template(item['minCount'])} exceeds maximum {js_template(item['maxCount'])}.",
            )
        )


def standard_definition_notices(rules: Obj, family: str) -> list[Obj]:
    """Non-blocking notes: a C4 kind whose match is also satisfied by an earlier kind (an untagged element in
    hand-written DSL counts as that earlier kind)."""
    if family != "c4":
        return []
    notices: list[Obj] = []
    for i, kind in enumerate(rules.get("elementKinds") or []):
        match = kind.get("match")
        if not js_truthy(match):
            continue
        samples = [False, True] if "external" not in match else [match["external"]]
        winners: dict[str, None] = {}
        for external in samples:
            sample = {
                "id": "sample",
                "label": "",
                "shape": "rectangle",
                "position": {"x": 0, "y": 0},
                "role": match.get("role"),
                "external": external,
            }
            winner = classify_node(sample, rules)
            if winner is not None and winner.get("id") != kind.get("id"):
                label = winner.get("label")
                trimmed = js_trim(label) if isinstance(label, str) else ""
                winners[trimmed or js_template(winner.get("id"))] = None
        if not winners:
            continue
        names = " and ".join(f'"{w}"' for w in winners)
        label = kind.get("label")
        own = (js_trim(label) if isinstance(label, str) else "") or js_template(kind.get("id"))
        notices.append(
            {
                "path": f"elementKinds[{i}].match",
                "message": f'"{own}" has the same C4 role as {names}. Elements drawn in the editor or by the AI are '
                "tagged with their kind, so they are told apart; an untagged element in hand-written or imported DSL "
                f"counts as {names}.",
            }
        )
    return notices
