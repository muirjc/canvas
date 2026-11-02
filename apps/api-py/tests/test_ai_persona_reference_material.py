"""Persona reference-material administration (010-ai-diagram-knowledge, T025): the cases of
apps/api/tests/contract/persona-reference-material.test.ts -- the admin-only CRUD routes on
/admin/ai-personas/:id/reference-material, and FR-009 (editing or deleting never touches chat history).
"""

from __future__ import annotations

from typing import Any

import pytest

from tests.ai_helpers import ScriptedModel, chat_world, enable_chat, persona, text_step
from tests.api import MISSING_ID, Api, User


@pytest.fixture()
def admin(api: Api) -> User:
    return api.user("admin@example.com", "admin")


@pytest.fixture()
def architect(api: Api) -> User:
    return api.user("architect@example.com")


@pytest.fixture()
def persona_id(api: Api, admin: User, architect: User) -> str:
    return persona(api, "Ref Persona", "Business", "You are a helpful assistant.")


def base(persona_id: str) -> str:
    return f"/admin/ai-personas/{persona_id}/reference-material"


def post(api: Api, admin: User, persona_id: str, body: dict[str, Any]) -> Any:
    return api.call("POST", base(persona_id), admin, json=body)


def test_creates_an_entry_and_returns_its_full_shape(api: Api, admin: User, persona_id: str) -> None:
    response = post(
        api,
        admin,
        persona_id,
        {"content": "Always prefer solid lines over dashed for primary flows.", "diagramFamilies": ["flowchart"]},
    )
    assert response.status_code == 201
    entry = response.json()["entry"]
    assert entry["personaId"] == persona_id
    assert entry["content"] == "Always prefer solid lines over dashed for primary flows."
    assert entry["diagramFamilies"] == ["flowchart"]
    assert isinstance(entry["id"], str)
    assert isinstance(entry["createdAt"], str)
    assert isinstance(entry["updatedAt"], str)


def test_defaults_diagram_families_to_empty_when_omitted(api: Api, admin: User, persona_id: str) -> None:
    response = post(api, admin, persona_id, {"content": "Unscoped guidance."})
    assert response.status_code == 201
    assert response.json()["entry"]["diagramFamilies"] == []


def test_defaults_diagram_families_to_empty_when_given_an_empty_array(api: Api, admin: User, persona_id: str) -> None:
    response = post(api, admin, persona_id, {"content": "Unscoped guidance.", "diagramFamilies": []})
    assert response.status_code == 201
    assert response.json()["entry"]["diagramFamilies"] == []


def test_rejects_empty_content_with_400(api: Api, admin: User, persona_id: str) -> None:
    response = post(api, admin, persona_id, {"content": ""})
    assert response.status_code == 400
    assert isinstance(response.json()["error"], str)


def test_rejects_whitespace_only_content_with_400(api: Api, admin: User, persona_id: str) -> None:
    assert post(api, admin, persona_id, {"content": "   \n\t  "}).status_code == 400


def test_rejects_an_invalid_diagram_families_value_naming_it(api: Api, admin: User, persona_id: str) -> None:
    response = post(
        api, admin, persona_id, {"content": "Some content.", "diagramFamilies": ["flowchart", "not-a-real-family"]}
    )
    assert response.status_code == 400
    assert "not-a-real-family" in response.json()["error"]


def test_lists_every_entry_for_a_persona_in_creation_order(api: Api, admin: User, persona_id: str) -> None:
    first = post(api, admin, persona_id, {"content": "First entry."})
    second = post(api, admin, persona_id, {"content": "Second entry."})
    response = api.call("GET", base(persona_id), admin)
    assert response.status_code == 200
    assert [e["id"] for e in response.json()["entries"]] == [first.json()["entry"]["id"], second.json()["entry"]["id"]]


def test_edits_content_only_leaving_diagram_families_untouched(api: Api, admin: User, persona_id: str) -> None:
    entry_id = post(api, admin, persona_id, {"content": "Original content.", "diagramFamilies": ["erd"]}).json()[
        "entry"
    ]["id"]
    response = api.call("PATCH", f"{base(persona_id)}/{entry_id}", admin, json={"content": "Updated content."})
    assert response.status_code == 200
    assert response.json()["entry"]["content"] == "Updated content."
    assert response.json()["entry"]["diagramFamilies"] == ["erd"]


def test_edits_diagram_families_only_leaving_content_untouched(api: Api, admin: User, persona_id: str) -> None:
    entry_id = post(api, admin, persona_id, {"content": "Original content.", "diagramFamilies": ["erd"]}).json()[
        "entry"
    ]["id"]
    response = api.call("PATCH", f"{base(persona_id)}/{entry_id}", admin, json={"diagramFamilies": ["uml", "c4"]})
    assert response.status_code == 200
    assert response.json()["entry"]["content"] == "Original content."
    assert response.json()["entry"]["diagramFamilies"] == ["uml", "c4"]


def test_404s_a_patch_for_an_unknown_entry_id(api: Api, admin: User, persona_id: str) -> None:
    assert api.call("PATCH", f"{base(persona_id)}/{MISSING_ID}", admin, json={"content": "x"}).status_code == 404


def test_404s_a_patch_when_the_entry_belongs_to_a_different_persona(api: Api, admin: User, persona_id: str) -> None:
    other = persona(api, "Other Persona", "Technical", "x")
    entry_id = post(api, admin, other, {"content": "Belongs to other persona."}).json()["entry"]["id"]
    response = api.call("PATCH", f"{base(persona_id)}/{entry_id}", admin, json={"content": "Hijacked?"})
    assert response.status_code == 404
    # It truly wasn't touched.
    assert api.call("GET", base(other), admin).json()["entries"][0]["content"] == "Belongs to other persona."


def test_deletes_an_entry_confirmed_gone_via_a_follow_up_get(api: Api, admin: User, persona_id: str) -> None:
    entry_id = post(api, admin, persona_id, {"content": "Delete me."}).json()["entry"]["id"]
    assert api.call("DELETE", f"{base(persona_id)}/{entry_id}", admin).status_code == 204
    assert api.call("GET", base(persona_id), admin).json()["entries"] == []


def test_404s_a_delete_for_an_unknown_entry_id(api: Api, admin: User, persona_id: str) -> None:
    assert api.call("DELETE", f"{base(persona_id)}/{MISSING_ID}", admin).status_code == 404


def test_404s_get_and_post_for_an_unknown_persona_id(api: Api, admin: User) -> None:
    assert api.call("GET", base(MISSING_ID), admin).status_code == 404
    assert post(api, admin, MISSING_ID, {"content": "x"}).status_code == 404


def test_denies_a_non_admin_on_all_4_routes(api: Api, admin: User, architect: User, persona_id: str) -> None:
    entry_id = post(api, admin, persona_id, {"content": "Admin-created for the 403 checks."}).json()["entry"]["id"]
    assert api.call("GET", base(persona_id), architect).status_code == 403
    assert post(api, architect, persona_id, {"content": "x"}).status_code == 403
    assert api.call("PATCH", f"{base(persona_id)}/{entry_id}", architect, json={"content": "x"}).status_code == 403
    assert api.call("DELETE", f"{base(persona_id)}/{entry_id}", architect).status_code == 403


def test_fr_009_editing_or_deleting_reference_material_never_touches_chat_history(
    api: Api, scripted: ScriptedModel, needs_bridge: str, admin: User, architect: User, persona_id: str
) -> None:
    scripted.reply(text_step("Okay, done."))
    world = chat_world(api, admin=admin, architect=architect)
    enable_chat(api)
    entry_id = post(api, admin, persona_id, {"content": "Original reference material."}).json()["entry"]["id"]

    assert world.chat("hello", personaId=persona_id).status_code == 200
    before = world.history()
    assert before.status_code == 200

    patched = api.call("PATCH", f"{base(persona_id)}/{entry_id}", admin, json={"content": "Edited reference material."})
    assert patched.status_code == 200
    assert api.call("DELETE", f"{base(persona_id)}/{entry_id}", admin).status_code == 204

    after = world.history()
    assert after.status_code == 200
    assert after.json() == before.json()
