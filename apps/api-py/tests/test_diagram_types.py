"""Diagram types (canvas-1bty.6), the cases of apps/api/tests/contract/diagram-types-admin and
diagram-types-hide-delete. The catalog-seed cases stay with the seed, which is still TypeScript.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest

from tests.api import Api, User


@pytest.fixture()
def admin(api: Api) -> User:
    # A few built-ins standing in for the catalog seed.
    api.diagram_type("flowchart", name="Generic Flowchart")
    api.diagram_type("value-chain", name="Value Chain")
    api.diagram_type("roadmap", name="Roadmap", personas=["Business", "Enterprise"])
    return api.user("admin@example.com", role="admin")


@pytest.fixture()
def architect(api: Api) -> User:
    return api.user("architect@example.com")


def create(api: Api, admin: User, **payload: Any) -> Any:
    return api.call("POST", "/admin/diagram-types", admin, json=payload)


def patch(api: Api, who: User, type_id: str, **payload: Any) -> Any:
    return api.call("PATCH", f"/admin/diagram-types/{type_id}", who, json=payload)


def listed(api: Api, who: User, query: str = "") -> dict[str, dict[str, Any]]:
    return {t["id"]: t for t in api.call("GET", f"/diagram-types{query}", who).json()["diagramTypes"]}


def custom(api: Api, admin: User, name: str = "Custom One") -> str:
    response = create(api, admin, name=name, dslFamily="flowchart", personas=["Business"])
    assert response.status_code == 201, response.text
    return str(response.json()["diagramType"]["id"])


# --- create ------------------------------------------------------------------------------------------


def test_creates_a_custom_type_with_a_slug_id(api: Api, admin: User) -> None:
    response = create(
        api,
        admin,
        name="Process Map (Ops)",
        dslFamily="flowchart",
        personas=["Business", "Solution"],
        description="Ops",
    )
    assert response.status_code == 201
    assert response.json()["diagramType"] == {
        "id": "process-map-ops",
        "name": "Process Map (Ops)",
        "personas": ["Business", "Solution"],
        "abstractionLevel": "N/A",
        "dslFamily": "flowchart",
        "defaultPaletteLibraryIds": [],
        "origin": "custom",
        "adminEdited": False,
        "description": "Ops",
        "hidden": False,
    }


def test_stores_palette_libraries_and_trims_the_name(api: Api, admin: User) -> None:
    response = create(
        api, admin, name="  Palette Type ", dslFamily="flowchart", personas=["Business"], paletteLibraryIds=["generic"]
    )
    assert response.json()["diagramType"]["defaultPaletteLibraryIds"] == ["generic"]
    assert response.json()["diagramType"]["name"] == "Palette Type"


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({"name": "X Type", "dslFamily": "mindmap", "personas": ["Business"]}, 'Unknown diagram family "mindmap"'),
        ({"name": "X Type", "dslFamily": "flowchart", "personas": []}, "Choose at least one persona."),
        ({"name": "X Type", "dslFamily": "flowchart", "personas": ["Wizard"]}, "Unknown persona(s): Wizard."),
        ({"name": "   ", "dslFamily": "flowchart", "personas": ["Business"]}, "A diagram type needs a name."),
        (
            {"name": "!!!", "dslFamily": "flowchart", "personas": ["Business"]},
            "The name needs at least one letter or digit.",
        ),
        ({"name": 5, "dslFamily": "flowchart", "personas": ["Business"]}, None),
    ],
    ids=["unknown family", "no personas", "unknown persona", "blank name", "no letters", "wrong type"],
)
def test_create_rejects_a_bad_type(api: Api, admin: User, payload: dict[str, Any], message: str | None) -> None:
    response = api.call("POST", "/admin/diagram-types", admin, json=payload)
    assert response.status_code == 400
    assert response.json()["error"]
    if message:
        assert response.json()["error"].startswith(message)


def test_create_conflicts_with_a_built_in_id_or_an_existing_one(api: Api, admin: User) -> None:
    response = create(api, admin, name="Value Chain", dslFamily="flowchart", personas=["Business"])
    assert response.status_code == 409
    assert response.json()["error"] == '"Value Chain" collides with the built-in diagram type "value-chain".'
    assert create(api, admin, name="Dupe", dslFamily="flowchart", personas=["Business"]).status_code == 201
    assert create(api, admin, name="dupe", dslFamily="erd", personas=["Technical"]).status_code == 409


def test_only_admins_create(api: Api, admin: User, architect: User) -> None:
    assert create(api, architect, name="Nope", dslFamily="flowchart", personas=["Business"]).status_code == 403


# --- edit --------------------------------------------------------------------------------------------


def test_edits_an_unused_custom_type_including_its_family(api: Api, admin: User) -> None:
    type_id = custom(api, admin)
    response = patch(
        api, admin, type_id, name="Custom Renamed", description="d", personas=["Technical"], dslFamily="erd"
    )
    assert response.status_code == 200
    assert (
        response.json()["diagramType"]
        | {
            "name": "Custom Renamed",
            "description": "d",
            "personas": ["Technical"],
            "dslFamily": "erd",
            "origin": "custom",
        }
        == response.json()["diagramType"]
    )


def test_editing_a_built_in_flags_it_admin_edited(api: Api, admin: User, architect: User) -> None:
    assert listed(api, architect)["flowchart"]["adminEdited"] is False
    response = patch(api, admin, "flowchart", name="Renamed Flow", description="mine", personas=["Technical"])
    assert response.status_code == 200
    assert response.json()["diagramType"] | {"origin": "builtin", "adminEdited": True} == response.json()["diagramType"]
    assert listed(api, architect)["flowchart"]["name"] == "Renamed Flow"


def test_a_built_in_family_never_changes(api: Api, admin: User, architect: User) -> None:
    response = patch(api, admin, "flowchart", dslFamily="erd")
    assert response.status_code == 409
    assert (
        listed(api, architect)["flowchart"] | {"dslFamily": "flowchart", "adminEdited": False}
        == listed(api, architect)["flowchart"]
    )
    # Re-sending the same family is not a change.
    assert patch(api, admin, "flowchart", dslFamily="flowchart", name="Same Family").status_code == 200


def test_a_custom_family_is_locked_once_a_diagram_uses_it(api: Api, admin: User) -> None:
    type_id = custom(api, admin)
    api.diagram(api.project(admin, "P"), admin, "D", type_id)
    assert patch(api, admin, type_id, dslFamily="erd").status_code == 409
    assert patch(api, admin, type_id, dslFamily="flowchart", name="Still Fine").status_code == 200


def test_edit_errors(api: Api, admin: User, architect: User) -> None:
    type_id = custom(api, admin)
    assert patch(api, admin, "does-not-exist", name="x").status_code == 404
    assert patch(api, admin, type_id, personas=[]).status_code == 400
    assert patch(api, admin, type_id, dslFamily="mindmap").status_code == 400
    assert patch(api, architect, type_id, name="x").status_code == 403


def test_description_can_be_cleared(api: Api, admin: User) -> None:
    type_id = custom(api, admin)
    patch(api, admin, type_id, description="something")
    assert patch(api, admin, type_id, description=None).json()["diagramType"]["description"] is None


# --- list --------------------------------------------------------------------------------------------


def test_lists_origins_and_filters_by_persona(api: Api, admin: User, architect: User) -> None:
    create(api, admin, name="Business Only", dslFamily="flowchart", personas=["Business"], description="hello")
    types = listed(api, architect)
    assert types["flowchart"]["origin"] == "builtin"
    assert types["business-only"] | {"origin": "custom", "description": "hello"} == types["business-only"]
    assert "business-only" in listed(api, architect, "?persona=Business")
    assert "business-only" not in listed(api, architect, "?persona=Technical")
    assert list(listed(api, architect)) == sorted(
        listed(api, architect), key=lambda i: listed(api, architect)[i]["name"]
    )


def test_the_list_requires_sign_in(api: Api, admin: User) -> None:
    assert api.call("GET", "/diagram-types").status_code == 401


# --- hide and delete (diagram-types-hide-delete.test.ts) ---------------------------------------------


def test_a_hidden_type_leaves_the_default_list_and_comes_back(api: Api, admin: User, architect: User) -> None:
    hidden = patch(api, admin, "roadmap", hidden=True)
    assert hidden.status_code == 200
    assert hidden.json()["diagramType"]["hidden"] is True
    assert "roadmap" not in listed(api, architect)
    everything = listed(api, architect, "?includeHidden=true")
    assert everything["roadmap"]["hidden"] is True
    # Hiding isn't editing: a built-in stays un-edited, so catalog updates keep reaching it.
    assert everything["roadmap"]["adminEdited"] is False
    assert patch(api, admin, "roadmap", hidden=False).status_code == 200
    assert "roadmap" in listed(api, architect)


def test_custom_types_can_be_hidden_and_only_admins_hide(api: Api, admin: User, architect: User) -> None:
    type_id = custom(api, admin, "Ops Map")
    patch(api, admin, type_id, hidden=True)
    assert type_id not in listed(api, architect)
    assert patch(api, architect, "roadmap", hidden=True).status_code == 403
    assert patch(api, admin, "roadmap", hidden="yes").status_code == 400


def test_deletes_an_unused_custom_type_and_its_standards(api: Api, admin: User, architect: User) -> None:
    type_id = custom(api, admin, "Ops Map")
    api.execute(
        "INSERT INTO standards (id, diagram_type_id, version, status) VALUES (:id, :t, 1, 'draft')",
        id=str(uuid4()),
        t=type_id,
    )
    assert api.call("DELETE", f"/admin/diagram-types/{type_id}", admin).status_code == 204
    assert type_id not in listed(api, architect, "?includeHidden=true")
    assert api.scalar("SELECT COUNT(*) FROM standards WHERE diagram_type_id = :t", t=type_id) == 0


def test_a_used_type_is_not_deleted_and_deleted_diagrams_count(api: Api, admin: User, architect: User) -> None:
    type_id = custom(api, admin, "Ops Map")
    project = api.project(admin, "P")
    api.diagram(project, admin, "One", type_id)
    api.diagram(project, admin, "Two", type_id, deleted=True)
    response = api.call("DELETE", f"/admin/diagram-types/{type_id}", admin)
    assert response.status_code == 409
    assert response.json()["error"] == (
        f'"{type_id}" is used by 2 diagrams (deleted diagrams included), so it can\'t be deleted; hide it instead.'
    )
    assert type_id in listed(api, architect)


def test_a_built_in_is_hidden_not_deleted(api: Api, admin: User) -> None:
    response = api.call("DELETE", "/admin/diagram-types/roadmap", admin)
    assert response.status_code == 409
    assert "built-in" in response.json()["error"]
    assert "hide" in response.json()["error"]


def test_delete_unknown_and_non_admin(api: Api, admin: User, architect: User) -> None:
    assert api.call("DELETE", "/admin/diagram-types/no-such-type", admin).status_code == 404
    type_id = custom(api, admin, "Ops Map")
    assert api.call("DELETE", f"/admin/diagram-types/{type_id}", architect).status_code == 403


def test_slugs_match_the_typescript_rule() -> None:
    from canvas_api.routes.diagram_types import slugify

    assert slugify("Process Map (Ops)") == "process-map-ops"
    assert slugify("  Café Flow ") == "cafe-flow"
    assert slugify("x" * 80) == "x" * 60
