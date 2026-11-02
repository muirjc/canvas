"""AI personas (feature 004): the cases of apps/api/tests/contract/ai-persona.test.ts -- the list that feeds the
chat's persona dropdown, and admin create/edit/archive.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest

from tests.ai_helpers import persona
from tests.api import MISSING_ID, Api, User


@pytest.fixture()
def architect(api: Api) -> User:
    return api.user("architect@example.com")


def names(response: Any) -> list[str]:
    return [p["name"] for p in response.json()["personas"]]


def test_lists_active_personas_available_to_any_authenticated_user(api: Api, architect: User) -> None:
    persona(api, "Business Architect", "Business")
    persona(api, "Enterprise Architect", "Enterprise")
    response = api.call("GET", "/ai-personas", architect)
    assert response.status_code == 200
    assert {"Business Architect", "Enterprise Architect"} <= set(names(response))


def test_excludes_archived_personas(api: Api, architect: User) -> None:
    persona(api, "Retired Persona", "Technical", status="archived")
    assert "Retired Persona" not in names(api.call("GET", "/ai-personas", architect))


def test_list_requires_authentication(api: Api) -> None:
    assert api.call("GET", "/ai-personas").status_code == 401


# --- admin CRUD ---------------------------------------------------------------------------------------


@pytest.fixture()
def admin(api: Api) -> User:
    return api.user("admin@example.com", "admin")


def create(api: Api, who: User, name: str, category: str, prompt: str = "x") -> Any:
    return api.call(
        "POST", "/admin/ai-personas", who, json={"name": name, "category": category, "systemPrompt": prompt}
    )


def test_lets_an_admin_create_a_persona_which_then_appears_in_the_active_list(
    api: Api, admin: User, architect: User
) -> None:
    created = create(api, admin, "Cloud Architect", "Solution", "You are a cloud-focused solution architect.")
    assert created.status_code == 201
    assert created.json()["persona"]["status"] == "active"
    assert "Cloud Architect" in names(api.call("GET", "/ai-personas", architect))


def test_rejects_a_create_with_an_invalid_category(api: Api, admin: User) -> None:
    assert create(api, admin, "Bad Category", "NotACategory").status_code == 400


def test_allows_multiple_personas_in_the_same_category_as_distinct_options(
    api: Api, admin: User, architect: User
) -> None:
    create(api, admin, "Persona One", "Business")
    create(api, admin, "Persona Two", "Business", "y")
    assert {"Persona One", "Persona Two"} <= set(names(api.call("GET", "/ai-personas", architect)))


def test_lets_an_admin_edit_a_persona(api: Api, admin: User) -> None:
    persona_id = create(api, admin, "Original Name", "Technical", "Original prompt.").json()["persona"]["id"]
    patched = api.call("PATCH", f"/admin/ai-personas/{persona_id}", admin, json={"systemPrompt": "Updated prompt."})
    assert patched.status_code == 200
    assert patched.json()["persona"]["systemPrompt"] == "Updated prompt."
    # The fields not sent are untouched.
    assert patched.json()["persona"]["name"] == "Original Name"
    assert patched.json()["persona"]["category"] == "Technical"


def test_lets_an_admin_archive_a_persona_idempotently_without_disturbing_a_chat_that_uses_it(
    api: Api, admin: User, architect: User
) -> None:
    persona_id = create(api, admin, "To Archive", "Enterprise").json()["persona"]["id"]
    api.diagram_type("flowchart")
    diagram_id = api.diagram(api.project(architect), architect)
    api.execute(
        "INSERT INTO diagram_chats (id, diagram_id, persona_id) VALUES (:id, :diagram, :persona)",
        id=str(uuid4()),
        diagram=diagram_id,
        persona=persona_id,
    )

    archived = api.call("POST", f"/admin/ai-personas/{persona_id}/archive", admin)
    assert archived.status_code == 200
    assert archived.json()["persona"]["status"] == "archived"
    # Archiving again is a no-op, not an error.
    assert api.call("POST", f"/admin/ai-personas/{persona_id}/archive", admin).status_code == 200

    assert "To Archive" not in names(api.call("GET", "/ai-personas", architect))
    assert str(api.scalar("SELECT persona_id FROM diagram_chats WHERE diagram_id = :d", d=diagram_id)) == persona_id


def test_denies_a_non_admin_from_creating_editing_or_archiving_personas(api: Api, architect: User) -> None:
    assert create(api, architect, "Denied", "Business").status_code == 403
    patch = api.call("PATCH", f"/admin/ai-personas/{MISSING_ID}", architect, json={"name": "Denied"})
    assert patch.status_code == 403
    assert api.call("POST", f"/admin/ai-personas/{MISSING_ID}/archive", architect).status_code == 403


def test_admin_list_includes_archived_personas(api: Api, admin: User) -> None:
    persona(api, "Old", "Business", status="archived")
    persona(api, "New", "Business")
    assert names(api.call("GET", "/admin/ai-personas", admin)) == ["New", "Old"]


def test_edit_and_archive_of_an_unknown_persona_are_404(api: Api, admin: User) -> None:
    assert api.call("PATCH", f"/admin/ai-personas/{MISSING_ID}", admin, json={"name": "x"}).status_code == 404
    assert api.call("POST", f"/admin/ai-personas/{MISSING_ID}/archive", admin).status_code == 404
