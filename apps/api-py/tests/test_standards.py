"""Standards (phase 5, canvas-1bty.9): the active standard, every version of a diagram type, creating drafts,
editing them, cloning, publishing and retiring -- the cases of apps/api/tests/contract/standards,
standards-v2 and standards-c4-role-shapes. Every response is also checked against the API contract
(tests/api.py). Creating and editing run diagram-core's definition check, and publishing/retiring re-check
the type's diagrams, both through the bridge (`needs_bridge`).

Request validation: zod and pydantic word structural errors differently, so those cases assert the 400, the
`Invalid standard definition` error and a non-empty list of {path, message} issues. Exact paths and messages
are asserted only for diagram-core's definition-check issues, which come from the same code on both sides.

Left out:
- standards.test.ts's last case of the first describe ends by exporting the flagged diagram as SVG: that step
  is in test_export.py (the case here keeps the flag and the save).
- standards-c4-role-shapes.test.ts's "built-in standards pass the definition check": it runs the seed
  catalog (a TypeScript script) through diagram-core directly; no route is involved.
"""

from __future__ import annotations

from typing import Any

import pytest

from tests.api import MISSING_ID, Api, User

V2_BODY: dict[str, Any] = {
    "name": "Process Map Rules",
    "description": "Kinds for process maps.",
    "requireKnownKinds": True,
    "connectorPolicy": "listed-only",
    "elementKinds": [
        {"id": "step", "label": "Step", "shapes": ["rectangle"], "approvedFills": ["#dbeafe"], "minCount": 2},
        {"id": "decision", "label": "Decision", "shapes": ["diamond"], "approvedFills": [], "maxCount": 3},
    ],
    "connectorRules": [
        {"id": "flow", "label": "Flow", "from": "step", "to": "*", "lineStyles": ["solid"], "maxPerSource": 2}
    ],
    "severityOverrides": {"kind-min-count": "error", "unknown-kind": "error"},
    "guidance": "Every step flows onward.",
}


@pytest.fixture()
def admin(api: Api, needs_bridge: str) -> User:
    api.diagram_type("flowchart", name="Generic Flowchart")
    return api.user("admin@example.com", role="admin")


@pytest.fixture()
def architect(api: Api, admin: User) -> User:
    return api.user("architect@example.com")


def create(api: Api, who: User | None, payload: Any = None, type_id: str = "flowchart") -> Any:
    return api.call("POST", f"/diagram-types/{type_id}/standards", who, json={} if payload is None else payload)


def new_standard(api: Api, admin: User, payload: Any = None, type_id: str = "flowchart") -> dict[str, Any]:
    response = create(api, admin, payload, type_id)
    assert response.status_code == 201, response.text
    standard: dict[str, Any] = response.json()["standard"]
    return standard


def post(api: Api, who: User | None, url: str) -> Any:
    return api.call("POST", url, who)


def publish(api: Api, admin: User, standard_id: str) -> Any:
    return post(api, admin, f"/standards/{standard_id}/publish")


def put(api: Api, who: User | None, standard_id: str, payload: Any) -> Any:
    return api.call("PUT", f"/standards/{standard_id}", who, json=payload)


def versions(api: Api, who: User, type_id: str = "flowchart") -> list[dict[str, Any]]:
    response = api.call("GET", f"/diagram-types/{type_id}/standards", who)
    assert response.status_code == 200
    listed: list[dict[str, Any]] = response.json()["standards"]
    return listed


def active(api: Api, who: User, type_id: str = "flowchart") -> Any:
    return api.call("GET", f"/diagram-types/{type_id}/standard", who)


def assert_invalid(response: Any) -> list[dict[str, str]]:
    assert response.status_code == 400, response.text
    body = response.json()
    assert body["error"] == "Invalid standard definition"
    issues: list[dict[str, str]] = body["issues"]
    assert issues
    assert all(set(issue) == {"path", "message"} for issue in issues)
    return issues


# --- standards.test.ts: the lifecycle -----------------------------------------------------------------


def test_creating_a_standard_needs_an_admin(api: Api, architect: User) -> None:
    assert create(api, architect, {"allowedShapeIds": ["rectangle"]}).status_code == 403
    assert create(api, None, {}).status_code == 401
    assert versions(api, architect) == []


def test_reading_standards_needs_a_signed_in_user(api: Api, admin: User) -> None:
    assert api.call("GET", "/diagram-types/flowchart/standard").status_code == 401
    assert api.call("GET", "/diagram-types/flowchart/standards").status_code == 401


def test_a_diagram_type_with_no_published_standard_has_no_active_one(api: Api, architect: User) -> None:
    assert active(api, architect).status_code == 404


def test_a_draft_is_not_the_active_standard(api: Api, admin: User) -> None:
    new_standard(api, admin, {"allowedShapeIds": ["rectangle"]})
    assert active(api, admin).status_code == 404


def test_creates_a_draft_publishes_it_and_it_becomes_the_active_standard(
    api: Api, admin: User, architect: User
) -> None:
    standard = new_standard(
        api,
        admin,
        {"allowedShapeIds": ["rectangle", "circle"], "colorPalette": [{"role": "system", "colorHex": "#1168bd"}]},
    )
    assert standard["status"] == "draft"
    assert standard["publishedAt"] is None

    published = publish(api, admin, standard["id"])
    assert published.status_code == 200
    assert published.json()["standard"]["status"] == "published"
    assert published.json()["standard"]["publishedAt"]

    current = active(api, architect)
    assert current.status_code == 200
    assert current.json()["standard"]["id"] == standard["id"]


def test_publishing_a_new_standard_retires_the_one_in_force(api: Api, admin: User) -> None:
    first = new_standard(api, admin, {"allowedShapeIds": ["rectangle"]})
    assert publish(api, admin, first["id"]).status_code == 200
    second = new_standard(api, admin, {"allowedShapeIds": ["circle"]})
    assert publish(api, admin, second["id"]).status_code == 200

    by_id = {s["id"]: s for s in versions(api, admin)}
    assert by_id[first["id"]]["status"] == "retired"
    assert by_id[second["id"]]["status"] == "published"
    assert active(api, admin).json()["standard"]["id"] == second["id"]


def test_publishing_retires_only_the_standards_of_its_own_diagram_type(api: Api, admin: User) -> None:
    api.diagram_type("other-flow", name="Other")
    mine = new_standard(api, admin, {})
    other = new_standard(api, admin, {}, "other-flow")
    assert publish(api, admin, mine["id"]).status_code == 200
    assert publish(api, admin, other["id"]).status_code == 200
    assert versions(api, admin)[0]["status"] == "published"
    assert versions(api, admin, "other-flow")[0]["status"] == "published"


def test_retires_a_standard_on_demand(api: Api, admin: User, architect: User) -> None:
    draft = new_standard(api, admin)
    publish(api, admin, draft["id"])
    retired = post(api, admin, f"/standards/{draft['id']}/retire")
    assert retired.status_code == 200
    assert retired.json()["standard"]["status"] == "retired"
    assert active(api, architect).status_code == 404


def test_publishing_and_retiring_need_an_admin(api: Api, admin: User, architect: User) -> None:
    draft = new_standard(api, admin)
    assert publish(api, architect, draft["id"]).status_code == 403
    assert post(api, architect, f"/standards/{draft['id']}/retire").status_code == 403
    assert publish(api, None, draft["id"]).status_code == 401
    assert versions(api, admin)[0]["status"] == "draft"


def test_publishing_or_retiring_an_unknown_standard_is_404(api: Api, admin: User) -> None:
    assert publish(api, admin, MISSING_ID).status_code == 404
    assert post(api, admin, f"/standards/{MISSING_ID}/retire").status_code == 404


@pytest.mark.parametrize("state", ["published", "retired"])
def test_only_a_draft_can_be_published(api: Api, admin: User, state: str) -> None:
    standard = new_standard(api, admin)
    publish(api, admin, standard["id"])
    if state == "retired":
        post(api, admin, f"/standards/{standard['id']}/retire")
    response = publish(api, admin, standard["id"])
    assert response.status_code == 409
    assert versions(api, admin)[0]["status"] == state


def test_versions_count_up_per_diagram_type_and_list_newest_first(api: Api, admin: User) -> None:
    api.diagram_type("other-flow", name="Other")
    first = new_standard(api, admin)
    second = new_standard(api, admin)
    other = new_standard(api, admin, {}, "other-flow")
    assert [first["version"], second["version"], other["version"]] == [1, 2, 1]
    assert [s["version"] for s in versions(api, admin)] == [2, 1]
    assert [s["id"] for s in versions(api, admin, "other-flow")] == [other["id"]]


def test_a_diagram_type_with_no_standards_lists_none(api: Api, admin: User) -> None:
    assert versions(api, admin) == []
    assert versions(api, admin, "no-such-type") == []


def test_a_diagram_that_violates_the_published_standard_is_flagged_but_still_saved(
    api: Api, admin: User, architect: User
) -> None:
    draft = new_standard(api, admin, {"allowedShapeIds": ["rectangle"]})
    publish(api, admin, draft["id"])
    diagram = api.new_diagram(
        api.project(architect), architect, "Violating Diagram", dsl="flowchart TD\n  A((Circle Not Allowed))\n"
    )
    assert any(v["elementId"] == "A" and v["rule"] == "allowed-shapes" for v in diagram["lastValidationResult"])
    assert diagram["standardVersionAtLastCheck"] == draft["version"]


# --- standards.test.ts: metadata and lifecycle dates --------------------------------------------------


def test_stores_and_returns_a_name_and_description(api: Api, admin: User) -> None:
    standard = new_standard(api, admin, {"name": "Core Flowchart Rules", "description": "Shapes for process maps."})
    assert standard["name"] == "Core Flowchart Rules"
    assert standard["description"] == "Shapes for process maps."


def test_a_standard_created_without_a_name_is_named_after_its_type_and_version(api: Api, admin: User) -> None:
    first = new_standard(api, admin)
    second = new_standard(api, admin)
    assert (first["name"], second["name"]) == ("flowchart v1", "flowchart v2")
    assert first["description"] is None


def test_a_standard_always_has_a_creation_date_and_no_retirement_date_until_retired(api: Api, admin: User) -> None:
    standard = new_standard(api, admin, {"name": "Dated"})
    assert standard["createdAt"]
    assert standard["retiredAt"] is None


def test_records_a_retirement_date_when_a_standard_is_explicitly_retired(api: Api, admin: User) -> None:
    standard = new_standard(api, admin, {"name": "To Retire"})
    response = post(api, admin, f"/standards/{standard['id']}/retire")
    assert response.status_code == 200
    assert response.json()["standard"]["retiredAt"]


def test_records_a_retirement_date_on_a_standard_retired_by_supersession(api: Api, admin: User) -> None:
    first = new_standard(api, admin, {"name": "First"})
    publish(api, admin, first["id"])
    second = new_standard(api, admin, {"name": "Second"})
    publish(api, admin, second["id"])
    superseded = next(s for s in versions(api, admin) if s["id"] == first["id"])
    assert superseded["status"] == "retired"
    assert superseded["retiredAt"]


def test_does_not_overwrite_an_existing_retirement_date_when_retired_again(api: Api, admin: User) -> None:
    standard = new_standard(api, admin, {"name": "Retire Twice"})
    original = post(api, admin, f"/standards/{standard['id']}/retire").json()["standard"]["retiredAt"]
    again = post(api, admin, f"/standards/{standard['id']}/retire")
    assert again.status_code == 200
    assert again.json()["standard"]["retiredAt"] == original


def test_lists_standards_identifiable_by_name(api: Api, admin: User) -> None:
    new_standard(api, admin, {"name": "Alpha Rules"})
    new_standard(api, admin, {"name": "Beta Rules"})
    assert [s["name"] for s in versions(api, admin)] == ["Beta Rules", "Alpha Rules"]


# --- standards-v2.test.ts: create and read ------------------------------------------------------------


def test_persists_v2_rules_intact_and_returns_them_from_the_list_and_the_active_standard(
    api: Api, admin: User, architect: User
) -> None:
    response = create(api, admin, V2_BODY)
    assert response.status_code == 201
    standard = response.json()["standard"]
    assert standard["name"] == "Process Map Rules"
    assert len(standard["rules"]["elementKinds"]) == 2
    publish(api, admin, standard["id"])

    for rules in (active(api, architect).json()["standard"]["rules"], versions(api, admin)[0]["rules"]):
        assert rules["elementKinds"] == V2_BODY["elementKinds"]
        assert rules["connectorRules"] == V2_BODY["connectorRules"]
        assert rules["connectorPolicy"] == "listed-only"
        assert rules["requireKnownKinds"] is True
        assert rules["severityOverrides"] == {"kind-min-count": "error", "unknown-kind": "error"}
        assert rules["guidance"] == "Every step flows onward."


def test_persists_the_authoring_setting_and_rejects_an_unknown_scope(api: Api, admin: User) -> None:
    refs = [{"libraryId": "azure-icons", "libraryVersion": "1.0.0"}]
    response = create(
        api, admin, {**V2_BODY, "authoring": {"shapes": "none", "icons": "listed"}, "allowedIconLibraryRefs": refs}
    )
    assert response.status_code == 201
    assert response.json()["standard"]["rules"]["authoring"] == {"shapes": "none", "icons": "listed"}
    assert response.json()["standard"]["rules"]["allowedIconLibraryRefs"] == refs
    assert_invalid(create(api, admin, {**V2_BODY, "authoring": {"shapes": "some"}}))


def test_persists_kind_groups_and_rejects_one_naming_an_unknown_kind(api: Api, admin: User) -> None:
    groups = [{"id": "nodes", "label": "Node", "kindIds": ["step", "decision"], "maxCount": 4}]
    response = create(api, admin, {**V2_BODY, "kindGroups": groups})
    assert response.status_code == 201
    assert response.json()["standard"]["rules"]["kindGroups"] == groups
    bad = create(api, admin, {**V2_BODY, "kindGroups": [{**groups[0], "kindIds": ["step", "ghost"]}]})
    assert "ghost" in " ".join(issue["message"] for issue in assert_invalid(bad))


def test_still_accepts_a_v1_only_body_and_returns_no_v2_fields(api: Api, admin: User) -> None:
    rules = new_standard(
        api, admin, {"allowedShapeIds": ["rectangle"], "colorPalette": [{"role": "system", "colorHex": "#1168bd"}]}
    )["rules"]
    assert rules == {
        "allowedShapeIds": ["rectangle"],
        "mandatoryShapeIds": [],
        "allowedIconLibraryRefs": [],
        "colorPalette": [{"role": "system", "colorHex": "#1168bd"}],
    }


def test_an_empty_body_saves_empty_v1_lists(api: Api, admin: User) -> None:
    assert new_standard(api, admin, {})["rules"] == {
        "allowedShapeIds": [],
        "mandatoryShapeIds": [],
        "allowedIconLibraryRefs": [],
        "colorPalette": [],
    }


def test_a_kind_without_shapes_or_fills_saves_them_as_empty_lists(api: Api, admin: User) -> None:
    rules = new_standard(api, admin, {"elementKinds": [{"id": "step", "label": "Step"}]})["rules"]
    assert rules["elementKinds"] == [{"id": "step", "label": "Step", "shapes": [], "approvedFills": []}]


def test_unknown_keys_are_dropped_at_every_level(api: Api, admin: User) -> None:
    standard = new_standard(
        api,
        admin,
        {
            "bogus": 1,
            "id": "ignored",
            "status": "published",
            "elementKinds": [{"id": "step", "label": "Step", "shapes": ["rectangle"], "color": "red"}],
            "colorPalette": [{"role": "system", "colorHex": "#1168bd", "extra": True}],
        },
    )
    assert standard["status"] == "draft"
    assert "bogus" not in standard["rules"]
    assert standard["rules"]["elementKinds"] == [
        {"id": "step", "label": "Step", "shapes": ["rectangle"], "approvedFills": []}
    ]
    assert standard["rules"]["colorPalette"] == [{"role": "system", "colorHex": "#1168bd"}]


def test_font_constraints_are_stored_and_returned(api: Api, admin: User) -> None:
    standard = new_standard(api, admin, {"fontConstraints": {"family": "Inter", "minSize": 10, "maxSize": 18}})
    assert standard["rules"]["fontConstraints"] == {"family": "Inter", "minSize": 10, "maxSize": 18}
    assert versions(api, admin)[0]["rules"]["fontConstraints"] == {"family": "Inter", "minSize": 10, "maxSize": 18}


def test_shape_order_is_kept(api: Api, admin: User) -> None:
    rules = new_standard(
        api, admin, {"allowedShapeIds": ["diamond", "circle", "rectangle"], "mandatoryShapeIds": ["circle", "diamond"]}
    )["rules"]
    assert rules["allowedShapeIds"] == ["diamond", "circle", "rectangle"]
    assert rules["mandatoryShapeIds"] == ["circle", "diamond"]
    assert versions(api, admin)[0]["rules"]["allowedShapeIds"] == ["diamond", "circle", "rectangle"]


def test_creating_for_an_unknown_diagram_type_is_404(api: Api, admin: User) -> None:
    assert create(api, admin, V2_BODY, "no-such-type").status_code == 404


# --- standards-v2.test.ts: definition validation ------------------------------------------------------


def test_rejects_an_invalid_kind_id_with_400_and_a_path_bearing_issue(api: Api, admin: User) -> None:
    issues = assert_invalid(
        create(api, admin, {"elementKinds": [{"id": "Bad-Id", "label": "Bad", "shapes": ["rectangle"]}]})
    )
    assert any("elementKinds" in issue["path"] for issue in issues)


def test_rejects_a_shape_the_flowchart_family_cannot_draw(api: Api, admin: User) -> None:
    issues = assert_invalid(
        create(api, admin, {"elementKinds": [{"id": "who", "label": "Who", "shapes": ["person"], "approvedFills": []}]})
    )
    assert any("shapes" in issue["path"] for issue in issues)


def test_rejects_a_connector_rule_that_references_an_unknown_kind(api: Api, admin: User) -> None:
    issues = assert_invalid(
        create(
            api,
            admin,
            {
                "elementKinds": [{"id": "step", "label": "Step", "shapes": ["rectangle"], "approvedFills": []}],
                "connectorRules": [{"id": "flow", "label": "Flow", "from": "step", "to": "ghost"}],
            },
        )
    )
    assert any("connectorRules" in issue["path"] for issue in issues)


@pytest.mark.parametrize(
    "payload",
    [
        {"elementKinds": "nope"},
        {"allowedShapeIds": "rectangle"},
        {"severityOverrides": {"kind-min-count": "fatal"}},
        {"connectorPolicy": "sometimes"},
        {"elementKinds": [{"id": "step"}]},
        {"name": 5},
    ],
)
def test_rejects_a_structurally_invalid_body(api: Api, admin: User, payload: dict[str, Any]) -> None:
    assert_invalid(create(api, admin, payload))
    assert versions(api, admin) == []


def test_structural_issues_name_the_offending_field(api: Api, admin: User) -> None:
    assert assert_invalid(create(api, admin, {"elementKinds": "nope"}))[0]["path"] == "elementKinds"


def test_rejects_a_severity_override_for_an_unknown_rule(api: Api, admin: User) -> None:
    issues = assert_invalid(create(api, admin, {"severityOverrides": {"made-up-rule": "error"}}))
    assert issues[0]["path"] == "severityOverrides.made-up-rule"


def test_persists_nothing_when_validation_fails(api: Api, admin: User) -> None:
    create(api, admin, {"elementKinds": [{"id": "Bad-Id", "label": "Bad", "shapes": [], "approvedFills": []}]})
    assert versions(api, admin) == []


# --- standards-v2.test.ts: PUT /standards/:id ---------------------------------------------------------


def test_edits_a_draft_in_place(api: Api, admin: User) -> None:
    standard = new_standard(api, admin, V2_BODY)
    response = put(
        api,
        admin,
        standard["id"],
        {**V2_BODY, "name": "Renamed", "guidance": "New guidance", "elementKinds": [V2_BODY["elementKinds"][0]]}
        | {"connectorRules": []},
    )
    assert response.status_code == 200
    updated = response.json()["standard"]
    assert (updated["id"], updated["version"], updated["status"]) == (standard["id"], standard["version"], "draft")
    assert updated["name"] == "Renamed"
    assert updated["rules"]["guidance"] == "New guidance"
    assert len(updated["rules"]["elementKinds"]) == 1

    listed = versions(api, admin)
    assert len(listed) == 1
    assert listed[0]["name"] == "Renamed"
    assert len(listed[0]["rules"]["elementKinds"]) == 1


def test_an_edit_replaces_the_rules_it_leaves_out(api: Api, admin: User) -> None:
    standard = new_standard(
        api,
        admin,
        {**V2_BODY, "allowedShapeIds": ["rectangle"], "fontConstraints": {"family": "Inter"}},
    )
    rules = put(api, admin, standard["id"], {"allowedShapeIds": ["circle"]}).json()["standard"]["rules"]
    assert rules == {
        "allowedShapeIds": ["circle"],
        "mandatoryShapeIds": [],
        "allowedIconLibraryRefs": [],
        "colorPalette": [],
    }


def test_an_edit_keeps_the_name_and_description_it_does_not_mention(api: Api, admin: User) -> None:
    standard = new_standard(api, admin, {"name": "Keep", "description": "Keep me"})
    updated = put(api, admin, standard["id"], {"allowedShapeIds": ["circle"]}).json()["standard"]
    assert (updated["name"], updated["description"]) == ("Keep", "Keep me")


def test_an_edit_can_change_and_clear_the_description(api: Api, admin: User) -> None:
    standard = new_standard(api, admin, {"name": "N", "description": "Old"})
    changed = put(api, admin, standard["id"], {"description": "New"}).json()["standard"]
    assert changed["description"] == "New"
    # Only an explicit null clears it; the TypeScript route sends null through as a change.
    cleared = put(api, admin, standard["id"], {"description": None}).json()["standard"]
    assert cleared["description"] is None
    assert cleared["name"] == "N"


def test_rejects_an_invalid_edit_and_leaves_the_draft_unchanged(api: Api, admin: User) -> None:
    standard = new_standard(api, admin, V2_BODY)
    assert_invalid(
        put(
            api,
            admin,
            standard["id"],
            {"elementKinds": [{"id": "Bad-Id", "label": "x", "shapes": [], "approvedFills": []}]},
        )
    )
    assert len(versions(api, admin)[0]["rules"]["elementKinds"]) == 2


def test_an_edit_that_fails_the_family_check_leaves_the_shapes_unchanged(api: Api, admin: User) -> None:
    standard = new_standard(api, admin, {"allowedShapeIds": ["rectangle"]})
    assert_invalid(put(api, admin, standard["id"], {"allowedShapeIds": ["circle"], "elementKinds": "nope"}))
    assert versions(api, admin)[0]["rules"]["allowedShapeIds"] == ["rectangle"]


@pytest.mark.parametrize("state", ["published", "retired"])
def test_only_a_draft_can_be_edited(api: Api, admin: User, state: str) -> None:
    standard = new_standard(api, admin, V2_BODY)
    publish(api, admin, standard["id"])
    if state == "retired":
        post(api, admin, f"/standards/{standard['id']}/retire")
    assert put(api, admin, standard["id"], V2_BODY).status_code == 409
    assert versions(api, admin)[0]["status"] == state


def test_editing_an_unknown_standard_is_404(api: Api, admin: User) -> None:
    assert put(api, admin, MISSING_ID, V2_BODY).status_code == 404


# --- standards-v2.test.ts: clone ----------------------------------------------------------------------


def test_clones_a_published_standard_into_a_new_draft_at_the_next_version_with_the_same_rules(
    api: Api, admin: User
) -> None:
    standard = new_standard(api, admin, V2_BODY)
    publish(api, admin, standard["id"])

    response = post(api, admin, f"/standards/{standard['id']}/clone")
    assert response.status_code == 201
    clone = response.json()["standard"]
    assert clone["id"] != standard["id"]
    assert clone["status"] == "draft"
    assert clone["version"] == standard["version"] + 1
    assert clone["name"] == "Process Map Rules (copy)"
    assert clone["description"] == "Kinds for process maps."
    assert clone["rules"] == standard["rules"]
    assert clone["publishedAt"] is None

    # The published original is untouched and still the active standard.
    assert active(api, admin).json()["standard"]["id"] == standard["id"]


def test_clone_copies_v1_shapes_too(api: Api, admin: User) -> None:
    standard = new_standard(
        api, admin, {"allowedShapeIds": ["rectangle", "circle"], "mandatoryShapeIds": ["rectangle"]}
    )
    clone = post(api, admin, f"/standards/{standard['id']}/clone").json()["standard"]
    assert clone["rules"]["allowedShapeIds"] == ["rectangle", "circle"]
    assert clone["rules"]["mandatoryShapeIds"] == ["rectangle"]


def test_clone_works_from_a_retired_version_and_a_clone_can_be_edited_and_published(api: Api, admin: User) -> None:
    standard = new_standard(api, admin, {"allowedShapeIds": ["rectangle"]})
    publish(api, admin, standard["id"])
    post(api, admin, f"/standards/{standard['id']}/retire")
    clone = post(api, admin, f"/standards/{standard['id']}/clone").json()["standard"]
    assert put(api, admin, clone["id"], {"allowedShapeIds": ["circle"]}).status_code == 200
    assert publish(api, admin, clone["id"]).status_code == 200
    assert active(api, admin).json()["standard"]["rules"]["allowedShapeIds"] == ["circle"]


def test_cloning_a_clone_stacks_the_copy_suffix(api: Api, admin: User) -> None:
    standard = new_standard(api, admin, {"name": "Base"})
    clone = post(api, admin, f"/standards/{standard['id']}/clone").json()["standard"]
    again = post(api, admin, f"/standards/{clone['id']}/clone").json()["standard"]
    assert again["name"] == "Base (copy) (copy)"


def test_cloning_an_unknown_standard_is_404(api: Api, admin: User) -> None:
    assert post(api, admin, f"/standards/{MISSING_ID}/clone").status_code == 404


# --- standards-v2.test.ts: authorization --------------------------------------------------------------


def test_a_non_admin_cannot_create_edit_or_clone(api: Api, admin: User, architect: User) -> None:
    standard = new_standard(api, admin, V2_BODY)
    assert create(api, architect, V2_BODY).status_code == 403
    assert put(api, architect, standard["id"], V2_BODY).status_code == 403
    assert post(api, architect, f"/standards/{standard['id']}/clone").status_code == 403
    assert put(api, None, standard["id"], V2_BODY).status_code == 401
    assert len(versions(api, admin)) == 1


# --- standards-v2.test.ts: validation of saved diagrams against v2 rules ------------------------------

#: `class <ids> <kind>` gives a node its element kind (the flowchart parser: first class == role).
KINDED_DSL = "flowchart TD\n  A --> B\n  class A step\n"


def stored_result(api: Api, who: User, diagram_id: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = api.call("GET", f"/diagrams/{diagram_id}", who).json()["diagram"][
        "lastValidationResult"
    ]
    return result


def test_flags_v2_violations_on_a_new_diagram_with_the_overridden_severity(
    api: Api, admin: User, architect: User
) -> None:
    api.diagram_type("value-chain", name="Value Chain")
    publish(api, admin, new_standard(api, admin, V2_BODY, "value-chain")["id"])
    diagram = api.new_diagram(api.project(architect), architect, "D", "value-chain", dsl=KINDED_DSL)
    result = diagram["lastValidationResult"]
    assert any(
        v["rule"] == "kind-min-count" and v["severity"] == "error" and v["elementId"] == "(diagram)" for v in result
    )
    assert any(v["rule"] == "unknown-kind" and v["severity"] == "error" and v["elementId"] == "B" for v in result)


def test_revalidates_existing_diagrams_when_a_v2_standard_is_published(api: Api, admin: User, architect: User) -> None:
    api.diagram_type("value-chain", name="Value Chain")
    diagram = api.new_diagram(api.project(architect), architect, "D", "value-chain", dsl=KINDED_DSL)
    assert diagram["lastValidationResult"] == []
    assert diagram["standardVersionAtLastCheck"] is None

    standard = new_standard(api, admin, V2_BODY, "value-chain")
    publish(api, admin, standard["id"])

    assert "kind-min-count" in [v["rule"] for v in stored_result(api, architect, diagram["id"])]
    stored = api.call("GET", f"/diagrams/{diagram['id']}", architect).json()["diagram"]
    assert stored["standardVersionAtLastCheck"] == standard["version"]


def test_revalidation_never_touches_the_diagrams_dsl_or_version(api: Api, admin: User, architect: User) -> None:
    api.diagram_type("value-chain", name="Value Chain")
    diagram = api.new_diagram(api.project(architect), architect, "D", "value-chain", dsl=KINDED_DSL)
    publish(api, admin, new_standard(api, admin, V2_BODY, "value-chain")["id"])
    stored = api.call("GET", f"/diagrams/{diagram['id']}", architect).json()["diagram"]
    assert stored["dslContent"] == diagram["dslContent"]
    assert stored["currentVersionId"] == diagram["currentVersionId"]


def test_revalidation_covers_only_diagrams_of_the_published_type(api: Api, admin: User, architect: User) -> None:
    api.diagram_type("value-chain", name="Value Chain")
    project = api.project(architect)
    inside = api.new_diagram(project, architect, "In", "value-chain", dsl=KINDED_DSL)
    outside = api.new_diagram(project, architect, "Out", "flowchart", dsl=KINDED_DSL)
    publish(api, admin, new_standard(api, admin, V2_BODY, "value-chain")["id"])
    assert stored_result(api, architect, inside["id"])
    assert stored_result(api, architect, outside["id"]) == []
    stored = api.call("GET", f"/diagrams/{outside['id']}", architect).json()["diagram"]
    assert stored["standardVersionAtLastCheck"] is None


def test_publishing_a_newer_version_refreshes_the_cached_result_and_version(
    api: Api, admin: User, architect: User
) -> None:
    first = new_standard(api, admin, {"allowedShapeIds": ["rectangle"]})
    publish(api, admin, first["id"])
    diagram = api.new_diagram(api.project(architect), architect, "D", dsl="flowchart TD\n  A((Round))\n")
    assert [v["rule"] for v in diagram["lastValidationResult"]] == ["allowed-shapes"]

    second = new_standard(api, admin, {"allowedShapeIds": ["circle", "rectangle"]})
    publish(api, admin, second["id"])
    stored = api.call("GET", f"/diagrams/{diagram['id']}", architect).json()["diagram"]
    assert stored["lastValidationResult"] == []
    assert stored["standardVersionAtLastCheck"] == second["version"]


def test_clears_cached_violations_after_the_standard_is_retired(api: Api, admin: User, architect: User) -> None:
    api.diagram_type("value-chain", name="Value Chain")
    standard = new_standard(api, admin, V2_BODY, "value-chain")
    publish(api, admin, standard["id"])
    diagram = api.new_diagram(api.project(architect), architect, "D", "value-chain", dsl=KINDED_DSL)
    assert diagram["lastValidationResult"]

    assert post(api, admin, f"/standards/{standard['id']}/retire").status_code == 200
    stored = api.call("GET", f"/diagrams/{diagram['id']}", architect).json()["diagram"]
    assert stored["lastValidationResult"] == []
    assert stored["standardVersionAtLastCheck"] is None


# --- standards-c4-role-shapes.test.ts -----------------------------------------------------------------


def kind_body(role: str) -> dict[str, Any]:
    return {
        "name": "C4 rules",
        "elementKinds": [
            {
                "id": "person",
                "label": "Person",
                "match": {"role": role, "external": True},
                "shapes": ["person"],
                "approvedFills": [],
            }
        ],
    }


@pytest.fixture()
def c4(api: Api, admin: User) -> None:
    api.diagram_type("c4-context", "c4", name="C4 Context", personas=["Technical"], palette=["c4-notation"])


def test_rejects_creating_a_person_kind_whose_role_is_system_naming_the_shapes_path(
    api: Api, admin: User, c4: None
) -> None:
    response = create(api, admin, kind_body("system"), "c4-context")
    assert response.status_code == 400
    assert {
        "path": "elementKinds[0].shapes",
        "message": 'A C4 system element can\'t be drawn as "person"; system elements use rectangle, cylinder, stadium.',
    } in response.json()["issues"]


def test_accepts_the_same_kind_with_role_person(api: Api, admin: User, c4: None) -> None:
    standard = new_standard(api, admin, kind_body("person"), "c4-context")
    assert standard["rules"]["elementKinds"][0]["match"] == {"role": "person", "external": True}


def test_rejects_updating_a_draft_so_a_kind_has_a_role_that_cannot_produce_its_shape(
    api: Api, admin: User, c4: None
) -> None:
    standard = new_standard(api, admin, kind_body("person"), "c4-context")
    issues = assert_invalid(put(api, admin, standard["id"], kind_body("system")))
    assert any(issue["path"] == "elementKinds[0].shapes" for issue in issues)
    assert versions(api, admin, "c4-context")[0]["rules"]["elementKinds"][0]["match"]["role"] == "person"


def test_a_kind_match_with_no_external_flag_saves_without_one(api: Api, admin: User, c4: None) -> None:
    body = kind_body("person")
    body["elementKinds"][0]["match"] = {"role": "person"}
    standard = new_standard(api, admin, body, "c4-context")
    assert standard["rules"]["elementKinds"][0]["match"] == {"role": "person"}
