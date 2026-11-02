"""A diagram's AI chat (feature 004 User Story 1 + 010-ai-diagram-knowledge): the cases of
apps/api/tests/contract/diagram-chat.test.ts -- the HTTP contract (auth, persona lock-in, the ai_settings gate,
the diagram's real family, access parity, standards validation of an AI-edited diagram, reference material in the
system prompt). The model is scripted; the loop's calls to it are what the system-prompt tests assert on.
"""

from __future__ import annotations

from typing import Any

import pytest

from canvas_api.ai.chat import REPLY_STYLE
from canvas_api.diagram_core import DiagramBridge
from tests.ai_helpers import (
    Call,
    ScriptedModel,
    World,
    chat_world,
    enable_chat,
    persona,
    reference_material,
    text_step,
    tool_step,
)
from tests.api import Api


@pytest.fixture()
def w(api: Api, scripted: ScriptedModel, needs_bridge: str) -> World:
    scripted.reply("Okay, done.")
    return chat_world(api)


def chat_personas(w: World) -> list[str | None]:
    with w.api.engine.connect() as conn:
        from sqlalchemy import text

        rows = conn.execute(text("SELECT persona_id FROM diagram_chats WHERE diagram_id = :d"), {"d": w.diagram_id})
        return [None if r.persona_id is None else str(r.persona_id) for r in rows]


def test_returns_503_when_ai_chat_is_administratively_disabled(w: World) -> None:
    enable_chat(w.api, False)
    response = w.chat("add a shape", personaId=w.persona_id)
    assert response.status_code == 503


def test_creates_a_diagram_chat_with_the_given_persona_id_on_the_first_message(w: World) -> None:
    assert w.chat("hello", personaId=w.persona_id).status_code == 200
    assert chat_personas(w) == [w.persona_id]


def test_ignores_persona_id_on_subsequent_messages_the_persona_stays_fixed(w: World) -> None:
    w.chat("hello", personaId=w.persona_id)
    other = persona(w.api, "Other", "Technical", "x")
    w.chat("again", personaId=other)
    assert chat_personas(w) == [w.persona_id]


def test_requires_edit_level_diagram_access(w: World) -> None:
    assert w.chat("hello", who=w.other, personaId=w.persona_id).status_code == 403


def test_get_returns_the_full_message_history_in_order(w: World) -> None:
    w.chat("first", personaId=w.persona_id)
    w.chat("second")
    response = w.history()
    assert response.status_code == 200
    assert [m["content"] for m in response.json()["messages"] if m["role"] == "user"] == ["first", "second"]


def test_get_returns_an_empty_list_for_a_diagram_with_no_chat_activity(w: World) -> None:
    response = w.history()
    assert response.status_code == 200
    assert response.json()["messages"] == []


# --- every diagram family (010-ai-diagram-knowledge, T002/T009) ---------------------------------------

FAMILY_FIXTURES = [
    ("c4-test", "c4", 'C4Context\nPerson(user, "User")\n', "Person(user"),
    ("sequence-test", "sequence", "sequenceDiagram\nAlice->>Bob: Hello\n", "Alice"),
    ("erd-test", "erd", "erDiagram\nCUSTOMER {\n  string name\n}\n", "CUSTOMER"),
    ("uml-test", "uml", "classDiagram\nclass Foo\n", "Foo"),
    ("architecture-test", "architecture", "architecture-beta\nservice api(cloud)[API]\n", "api(cloud)"),
]


@pytest.mark.parametrize(("type_id", "family", "dsl", "needle"), FAMILY_FIXTURES, ids=[f[1] for f in FAMILY_FIXTURES])
def test_succeeds_for_each_family_and_round_trips_the_content_through_the_right_family_not_flowchart(
    w: World, type_id: str, family: str, dsl: str, needle: str
) -> None:
    w.api.diagram_type(type_id, family)
    diagram = w.api.new_diagram(w.project, w.architect, f"{type_id} diagram", type_id)
    response = w.api.call(
        "POST",
        f"/diagrams/{diagram['id']}/chat/messages",
        w.architect,
        json={"message": "hello", "currentDslContent": dsl, "personaId": w.persona_id},
    )
    assert response.status_code == 200
    assert needle in response.json()["updatedDslContent"]


@pytest.mark.parametrize(("type_id", "family", "dsl", "needle"), FAMILY_FIXTURES, ids=[f[1] for f in FAMILY_FIXTURES])
def test_denies_a_view_only_user_identically_403_on_each_family(
    w: World, type_id: str, family: str, dsl: str, needle: str
) -> None:
    w.api.diagram_type(type_id, family)
    diagram = w.api.new_diagram(w.project, w.architect, f"{type_id} diagram", type_id)
    viewer = w.api.user(f"viewer-{type_id}@example.com")
    w.api.grant("diagram", diagram["id"], viewer, "view", w.architect)
    response = w.api.call(
        "POST",
        f"/diagrams/{diagram['id']}/chat/messages",
        viewer,
        json={"message": "hello", "currentDslContent": dsl, "personaId": w.persona_id},
    )
    assert response.status_code == 403


# --- standards validation parity for AI-tool-driven mutations (T020) ----------------------------------


def test_flags_an_ai_set_node_role_identically_to_the_same_role_set_manually_once_the_chat_result_is_saved(
    w: World, scripted: ScriptedModel
) -> None:
    w.api.diagram_type("c4-t020-test", "c4")
    created = w.api.call(
        "POST",
        "/diagram-types/c4-t020-test/standards",
        w.admin,
        json={"colorPalette": [{"role": "system", "colorHex": "#1168bd"}]},
    )
    assert created.status_code == 201, created.text
    assert w.api.call("POST", f"/standards/{created.json()['standard']['id']}/publish", w.admin).status_code == 200

    # First turn: call setNodeRole on node 'sys' -> 'system'. Once the tool's result is back, finish with text.
    def handler(_n: int, call: Call) -> Any:
        if call.messages[-1].role == "tool":
            return text_step("Done.")
        return tool_step("setNodeRole", {"nodeId": "sys", "role": "system"}, call_id="mock-t020")

    scripted.handler = handler

    # A Container element that already carries the WRONG fill color for what role "system" would require.
    # No violation yet: the palette rule only applies to role "system", and this node isn't that role (yet).
    initial = 'C4Context\n  Container(sys, "Sys", "desc")\n  UpdateElementStyle(sys, $bgColor="#ff0000")\n'
    diagram = w.api.new_diagram(w.project, w.architect, "T020 Diagram", "c4-t020-test", dsl=initial)
    assert diagram["lastValidationResult"] == []

    chat = w.api.call(
        "POST",
        f"/diagrams/{diagram['id']}/chat/messages",
        w.architect,
        json={"message": "make this a system", "currentDslContent": diagram["dslContent"]},
    )
    assert chat.status_code == 200
    assert chat.json()["toolCalls"] == [{"tool": "setNodeRole", "applied": True}]

    # Saved through the SAME path a manual edit would use: no special AI bypass.
    saved = w.api.save_diagram(w.architect, diagram, chat.json()["updatedDslContent"])
    assert saved.status_code == 200
    ai_violations = saved.json()["diagram"]["lastValidationResult"]
    assert any(v["elementId"] == "sys" and v["rule"] == "color-palette" for v in ai_violations)

    # Parity: authoring the SAME end state (role "system", same wrong fill) by hand gives the IDENTICAL violation.
    manual = 'C4Context\n  System(sys, "Sys", "desc")\n  UpdateElementStyle(sys, $bgColor="#ff0000")\n'
    other = w.api.new_diagram(w.project, w.architect, "T020 Manual Diagram", "c4-t020-test", dsl=manual)
    assert other["lastValidationResult"] == ai_violations


# --- persona reference material in the system prompt (T026) -------------------------------------------


@pytest.fixture()
def erd(w: World) -> str:
    w.api.diagram_type("erd-refmat-test", "erd")
    return str(
        w.api.new_diagram(w.project, w.architect, "Ref Material ERD Diagram", "erd-refmat-test", dsl="erDiagram\n")[
            "id"
        ]
    )


def erd_chat(w: World, diagram_id: str, persona_id: str) -> Any:
    return w.api.call(
        "POST",
        f"/diagrams/{diagram_id}/chat/messages",
        w.architect,
        json={"message": "hello", "currentDslContent": "erDiagram\n", "personaId": persona_id},
    )


def erd_primer(bridge_url: str) -> str:
    with DiagramBridge(bridge_url) as bridge:
        model = bridge.parse("erd", "erDiagram\n")["model"]
        primer = bridge.ai_prompt("erd", None, model)["primer"]
    assert isinstance(primer, str)
    return primer


def test_includes_family_scoped_and_unscoped_material_excludes_other_families_and_orders_the_sections(
    w: World, scripted: ScriptedModel, erd: str, needs_bridge: str
) -> None:
    erd_marker, c4_marker, unscoped = "ERD-SCOPED-MARKER-a1b2c3", "C4-SCOPED-MARKER-x9y8z7", "UNSCOPED-MARKER-q5w4e3"
    prompt = "PERSONA-SYSTEM-PROMPT-m1n2o3"
    persona_id = persona(w.api, "Ref Material Persona", "Business", prompt)
    reference_material(w.api, persona_id, erd_marker, ["erd"])
    reference_material(w.api, persona_id, c4_marker, ["c4"])
    reference_material(w.api, persona_id, unscoped)

    assert erd_chat(w, erd, persona_id).status_code == 200
    [call] = scripted.calls
    system = call.system
    assert erd_marker in system
    assert unscoped in system
    assert c4_marker not in system

    primer = erd_primer(needs_bridge)
    persona_at, primer_at = system.index(prompt), system.index(primer)
    erd_at, unscoped_at, summary_at = system.index(erd_marker), system.index(unscoped), system.index("Current shapes:")
    assert persona_at >= 0
    assert primer_at > persona_at
    assert erd_at > primer_at
    assert unscoped_at > primer_at
    assert summary_at > erd_at
    assert summary_at > unscoped_at


def test_behaves_as_before_for_a_persona_with_no_reference_material_entries(
    w: World, scripted: ScriptedModel, erd: str, needs_bridge: str
) -> None:
    prompt = "PERSONA-WITH-NO-REFERENCE-MATERIAL"
    persona_id = persona(w.api, "Ref Material Persona", "Business", prompt)
    assert erd_chat(w, erd, persona_id).status_code == 200
    # Appended sections carry their own `##` headings; no reference material means no such section at all.
    expected = "\n\n".join(
        [
            prompt,
            f"## Diagram type\n\n{erd_primer(needs_bridge)}",
            f"## Reply style\n\n{REPLY_STYLE}",
            "## Current diagram\n\nCurrent shapes:\n(none yet)\n\nCurrent connectors:\n(none yet)",
        ]
    )
    assert scripted.calls[0].system == expected
