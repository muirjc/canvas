"""The chat channel under a published Standards v2 standard (canvas-tfr, canvas-7wx): the cases of
apps/api/tests/contract/diagram-chat-standard.test.ts, through the route with AI_PROVIDER=mock. The standard
section reaches the system prompt only for a diagram whose type has a published standard, and the mock model's
"add a <kind id> called X" drives addElement end to end.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from canvas_api.config import Settings
from tests.ai_helpers import World, enable_chat
from tests.api import Api

TYPE_ID = "value-chain-chat-test"
INTROSPECT = "what do you know about this diagram?"

#: VALUE_CHAIN_STANDARD (apps/api/src/seed/reference-standards.seed.ts).
VALUE_CHAIN_STANDARD: dict[str, Any] = {
    "name": "VC",
    "allowedShapeIds": [],
    "mandatoryShapeIds": [],
    "allowedIconLibraryRefs": [],
    "colorPalette": [],
    "requireKnownKinds": True,
    "connectorPolicy": "listed-only",
    "elementKinds": [
        {
            "id": "primary_activity",
            "label": "Primary Activity",
            "description": "An activity that directly creates and delivers value. Chain them left to right.",
            "shapes": ["asymmetric"],
            "approvedFills": ["#dbeafe", "#bfdbfe"],
            "approvedStrokes": ["#1d4ed8"],
            "minCount": 1,
            "requireConnection": True,
        },
        {
            "id": "support_activity",
            "label": "Support Activity",
            "description": "An activity that enables the primary activities across the whole chain.",
            "shapes": ["rectangle"],
            "approvedFills": ["#fef3c7", "#fde68a"],
            "approvedStrokes": ["#b45309"],
            "minCount": 1,
        },
        {
            "id": "margin",
            "label": "Margin",
            "description": "The value captured: exactly one, at the end of the primary activity chain.",
            "shapes": ["hexagon"],
            "approvedFills": ["#dcfce7"],
            "approvedStrokes": ["#15803d"],
            "minCount": 1,
            "maxCount": 1,
        },
    ],
    "connectorRules": [
        {
            "id": "flow",
            "label": "Value flow",
            "from": "primary_activity",
            "to": "primary_activity",
            "lineStyles": ["solid"],
            "arrows": ["target"],
            "maxPerSource": 1,
        },
        {
            "id": "to_margin",
            "label": "Delivers margin",
            "from": "primary_activity",
            "to": "margin",
            "lineStyles": ["solid"],
            "arrows": ["target"],
            "maxPerSource": 1,
        },
    ],
    "guidance": "Porter's value chain: primary activities in sequence left to right.",
}


@pytest.fixture()
def w(api: Api, ai_env: Callable[..., Settings], needs_bridge: str) -> World:
    ai_env(ai_provider="mock")
    api.diagram_type(TYPE_ID, "flowchart", name="Value Chain Test")
    admin = api.user("admin@example.com", "admin")
    architect = api.user("architect@example.com")
    project = api.project(architect, "Standard Chat Project")
    enable_chat(api)
    created = api.call("POST", f"/diagram-types/{TYPE_ID}/standards", admin, json=VALUE_CHAIN_STANDARD)
    assert created.status_code == 201, created.text
    assert api.call("POST", f"/standards/{created.json()['standard']['id']}/publish", admin).status_code == 200
    diagram = api.new_diagram(project, architect, "VC Diagram", TYPE_ID)
    return World(api, admin, architect, architect, project, diagram["id"])


def ask(w: World, message: str, dsl: str = "flowchart TD\n") -> dict[str, Any]:
    response = w.chat(message, currentDslContent=dsl)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def test_includes_the_standard_section_in_the_system_prompt(w: World) -> None:
    prompt = ask(w, INTROSPECT)["assistantMessage"]
    assert "Standard for this diagram" in prompt
    assert "primary_activity" in prompt
    assert "#dbeafe" in prompt


def test_puts_each_appended_section_under_its_own_heading_after_the_persona_prompt(w: World) -> None:
    prompt = ask(w, INTROSPECT)["assistantMessage"]
    order = [prompt.find(f"\n{h}\n") for h in ("## Diagram type", "## Diagram standard", "## Current diagram")]
    assert all(i > 0 for i in order)
    assert order == sorted(order)
    # The persona's own prompt (here the default) stays first and unheaded.
    assert not prompt.startswith("## ")
    # No persona in this chat, so no reference-material section.
    assert "## Reference material" not in prompt


def test_has_no_standard_section_for_a_diagram_whose_type_has_no_published_standard(w: World) -> None:
    w.api.diagram_type("plain-flow", "flowchart")
    plain = w.api.new_diagram(w.project, w.architect, "Plain", "plain-flow")
    response = w.api.call(
        "POST",
        f"/diagrams/{plain['id']}/chat/messages",
        w.architect,
        json={"message": INTROSPECT, "currentDslContent": "flowchart TD\n"},
    )
    assert response.status_code == 200
    assert "Standard for this diagram" not in response.json()["assistantMessage"]


def test_places_the_standard_after_the_family_primer_and_shows_kind_and_violations_in_the_model_summary(
    w: World,
) -> None:
    drawn = ask(w, "add a primary_activity called Operations")
    system = ask(w, INTROSPECT, drawn["updatedDslContent"])["assistantMessage"]
    assert system.index("Standard for this diagram") > -1
    assert "kind: primary_activity" in system
    assert "Current standard violations" in system


def test_add_a_primary_activity_called_operations_yields_a_primary_activity_node_via_add_element(w: World) -> None:
    result = ask(w, "add a primary_activity called Operations")
    assert result["toolCalls"] == [{"tool": "addElement", "applied": True}]
    assert ":::primary_activity" in result["updatedDslContent"]
    assert "Operations" in result["updatedDslContent"]
