"""canvas-1bty.15.3: the native standards code against the TypeScript results.

tests/data/standards_vectors.json (see make_standards_vectors.ts there) holds what diagram-core's TypeScript returns
for the definition check and its notices, the element-kind helpers, the authoring scope, and validate() on
hand-made models (fonts, JSON nulls) the parsers can't produce. The golden corpus covers validate() on parsed
diagrams. No Node needed to run these.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from canvas_api.diagram_core.family_capabilities import FAMILY_NODE_SHAPES
from canvas_api.diagram_core.jsvalues import to_js_json
from canvas_api.diagram_core.standards import check_standard_definition, standard_definition_notices, validate
from canvas_api.diagram_core.standards.authoring import effective_authoring, icon_library_offered, offered_shapes
from canvas_api.diagram_core.standards.kinds import (
    classify_node,
    connector_defaults,
    count_kind_group,
    is_approved_color,
    kind_add_blocked_reason,
    kind_defaults,
    kind_group_limit_message,
    kind_group_members,
    kind_limit_message,
    kind_limit_reached,
    kind_needs_tag,
    resolve_connector_rule,
    tags_for_kind,
)
from canvas_api.diagram_core.standards.schema import DEFAULT_SEVERITY, RULE_IDS

DATA: dict[str, Any] = json.loads((Path(__file__).parent / "data" / "standards_vectors.json").read_text("utf-8"))
KINDS: dict[str, Any] = DATA["kinds"]


@pytest.mark.parametrize(
    "case", DATA["definitions"], ids=[f"{i}-{c['family']}" for i, c in enumerate(DATA["definitions"])]
)
def test_definition_check_matches_typescript(case: dict[str, Any]) -> None:
    assert to_js_json(check_standard_definition(case["rules"], case["family"])) == case["issues"]
    assert to_js_json(standard_definition_notices(case["rules"], case["family"])) == case["notices"]


def test_the_definition_vectors_reach_every_kind_of_issue() -> None:
    paths = {issue["path"].split("[")[0].split(".")[0] for case in DATA["definitions"] for issue in case["issues"]}
    assert paths >= {"elementKinds", "kindGroups", "connectorRules", "authoring"}
    assert any(case["notices"] for case in DATA["definitions"])


@pytest.mark.parametrize("case", DATA["validations"], ids=lambda c: c["name"])
def test_validate_matches_typescript(case: dict[str, Any]) -> None:
    assert to_js_json(validate(case["model"], case["rules"])) == case["violations"]


# --- element-kind helpers ---------------------------------------------------------------------------------------

RULES: dict[str, Any] = {
    "allowedShapeIds": [],
    "mandatoryShapeIds": [],
    "allowedIconLibraryRefs": [],
    "colorPalette": [],
}
#: The rules and model the generator ran the kind helpers on.
KIND_RULES: dict[str, Any] = KINDS["rules"]
KIND_MODEL: dict[str, Any] = KINDS["model"]


def _kinds_fixture() -> tuple[dict[str, Any], dict[str, Any]]:
    return KIND_RULES, KIND_MODEL


def test_classify_node() -> None:
    rules, model = _kinds_fixture()
    actual = {n["id"]: (classify_node(n, rules) or {}).get("id") for n in model["nodes"]}
    assert actual == KINDS["classify"]


@pytest.mark.parametrize("kind", KIND_RULES["elementKinds"], ids=lambda k: k["id"])
def test_kind_helpers(kind: dict[str, Any]) -> None:
    rules, model = _kinds_fixture()
    kid = kind["id"]
    assert kind_needs_tag(kind, rules) == KINDS["needsTag"][kid]
    assert kind_defaults(kind) == KINDS["defaults"][kid]
    assert kind_limit_message(kind) == KINDS["limitMessage"][kid]
    assert kind_limit_reached(model, rules, kind) == KINDS["limitReached"][kid]
    assert {n["id"]: tags_for_kind(n, kind, rules) for n in model["nodes"]} == KINDS["tags"][kid]
    blocked = {"(none)": kind_add_blocked_reason(model, rules, kind)}
    blocked.update({n["id"]: kind_add_blocked_reason(model, rules, kind, n["id"]) for n in model["nodes"]})
    assert blocked == KINDS["blocked"][kid]


@pytest.mark.parametrize("group", KIND_RULES["kindGroups"], ids=lambda g: g["id"])
def test_kind_group_helpers(group: dict[str, Any]) -> None:
    rules, model = _kinds_fixture()
    assert {
        "members": kind_group_members(group, rules),
        "count": count_kind_group(model, rules, group),
        "countIgnoring": count_kind_group(model, rules, group, "n1"),
        "limitMessage": kind_group_limit_message(group, rules),
    } == KINDS["groups"][group["id"]]


def test_connector_helpers() -> None:
    rules, _ = _kinds_fixture()
    assert {r["id"]: connector_defaults(r) for r in rules["connectorRules"]} == KINDS["connectorDefaults"]
    subset = {**RULES, "connectorRules": rules["connectorRules"][1:3]}
    for entry in KINDS["resolve"]:
        source, target, expected = entry[0], entry[1], entry[2]
        which = subset if len(entry) == 4 else rules
        assert (resolve_connector_rule(which, source, target) or {}).get("id") == expected, entry
    for color, approved, expected in KINDS["approved"]:
        assert is_approved_color(color, approved) == expected


@pytest.mark.parametrize("case", DATA["authoring"], ids=[f"authoring-{i}" for i in range(len(DATA["authoring"]))])
def test_authoring(case: dict[str, Any]) -> None:
    rules = case["rules"]
    assert effective_authoring(rules) == case["effective"]
    assert offered_shapes(FAMILY_NODE_SHAPES["flowchart"], rules) == case["offered"]
    assert {i: icon_library_offered(i, rules) for i in ("generic", "aws-icons", "azure-icons")} == case["icons"]


def test_every_rule_has_a_default_severity() -> None:
    assert set(DEFAULT_SEVERITY) == set(RULE_IDS)
