"""canvas-8uh1.5: the AI chat links elements to other diagrams (linkToDiagram), sees which elements link where,
and knows a standard's "should link to" rule (kind-link)."""

from __future__ import annotations

from typing import Any

from canvas_api.diagram_core import DiagramCore
from canvas_api.diagram_core.ai import list_tools, prompt_sections, run_tool
from tests.ai_helpers import ScriptedModel, chat_world, text_step, tool_step
from tests.api import Api

core = DiagramCore()
TARGETS = [
    {"id": "11111111-2222-4333-8444-555555555555", "name": "Payments containers", "diagramTypeId": "c4-container"},
    {"id": "66666666-7777-4888-9999-aaaaaaaaaaaa", "name": "Order flow", "diagramTypeId": "flowchart"},
]
CONTAINERS, FLOW = TARGETS[0]["id"], TARGETS[1]["id"]
RULES: dict[str, Any] = {
    "allowedShapeIds": [],
    "mandatoryShapeIds": [],
    "allowedIconLibraryRefs": [],
    "colorPalette": [],
    "elementKinds": [
        {
            "id": "system",
            "label": "Software System",
            "shapes": [],
            "approvedFills": [],
            "match": {"role": "system", "external": False},
            "linkTo": ["c4-container"],
        }
    ],
}


def _c4() -> dict[str, Any]:
    parsed = core.parse("c4", 'C4Context\n  Person(user, "Customer")\n  System(pay, "Payments")\n')
    model: dict[str, Any] = parsed["model"]
    return model


def test_the_tool_is_offered_only_with_diagrams_to_link_to() -> None:
    assert "linkToDiagram" not in {t["name"] for t in list_tools("c4", None)}
    tool = next(t for t in list_tools("c4", None, TARGETS) if t["name"] == "linkToDiagram")
    assert tool["inputSchema"]["required"] == ["elementId"]
    assert "linkToDiagram" in {t["name"] for t in list_tools("c4", None, [])}  # can still remove links


def test_linking_removing_and_refusing() -> None:
    model = _c4()
    linked = run_tool("c4", None, model, "linkToDiagram", {"elementId": "pay", "diagramId": CONTAINERS}, TARGETS)
    assert linked["ok"] and linked["outcomes"] == [{"tool": "linkToDiagram", "applied": True}]
    pay = next(n for n in linked["model"]["nodes"] if n["id"] == "pay")
    assert pay["diagramRef"] == {"diagramId": CONTAINERS}
    assert f"links:\n    pay: {CONTAINERS}" in core.serialize("c4", linked["model"])

    removed = run_tool("c4", None, linked["model"], "linkToDiagram", {"elementId": "pay"}, TARGETS)
    assert "diagramRef" not in next(n for n in removed["model"]["nodes"] if n["id"] == "pay")

    elsewhere = run_tool("c4", None, model, "linkToDiagram", {"elementId": "pay", "diagramId": "nope"}, TARGETS)
    assert elsewhere["output"] == {
        "applied": False,
        "reason": "No diagram with id 'nope' can be linked; use an id from \"Diagrams you can link to\".",
    }
    ghost = run_tool("c4", None, model, "linkToDiagram", {"elementId": "ghost", "diagramId": FLOW}, TARGETS)
    assert ghost["output"]["reason"] == "No shape or group with id 'ghost' was found."


def test_a_sequence_diagram_links_participants_only() -> None:
    model = core.parse("sequence", "sequenceDiagram\n  participant A\n  loop Every day\n    A->>A: tick\n  end\n")[
        "model"
    ]
    block = model["containers"][0]["id"]
    refused = run_tool("sequence", None, model, "linkToDiagram", {"elementId": block, "diagramId": FLOW}, TARGETS)
    assert refused["output"]["reason"] == f"No participant with id '{block}' was found."
    assert run_tool("sequence", None, model, "linkToDiagram", {"elementId": "A", "diagramId": FLOW}, TARGETS)[
        "output"
    ] == {"applied": True}


def test_new_violations_judge_the_link_by_its_diagrams_type() -> None:
    model = _c4()
    right = run_tool("c4", RULES, model, "linkToDiagram", {"elementId": "pay", "diagramId": CONTAINERS}, TARGETS)
    assert "newViolations" not in right["output"]
    # Violations are new by element and rule: an unlinked System is already flagged, so relink a correct one.
    wrong = run_tool("c4", RULES, right["model"], "linkToDiagram", {"elementId": "pay", "diagramId": FLOW}, TARGETS)
    assert wrong["output"]["newViolations"] == [
        {
            "rule": "kind-link",
            "elementId": "pay",
            "message": 'Software System "Payments" links to a flowchart diagram; it should link to c4-container.',
            "severity": "warning",
        }
    ]


def test_the_prompt_lists_the_diagrams_the_links_and_the_rule() -> None:
    model = run_tool("c4", None, _c4(), "linkToDiagram", {"elementId": "pay", "diagramId": CONTAINERS}, TARGETS)[
        "model"
    ]
    sections = prompt_sections("c4", RULES, model, TARGETS)
    assert sections["linkTargets"] == (
        f'- {CONTAINERS}: "Payments containers" (c4-container)\n- {FLOW}: "Order flow" (flowchart)'
    )
    assert (
        f'- pay: "Payments" (rectangle, kind: system) at (220, 40), size 140x60, links to {CONTAINERS}'
        in (sections["currentDiagram"])
    )
    assert "should link to a c4-container diagram" in sections["standard"]
    assert "Current standard violations" not in sections["currentDiagram"]  # the link is of the right type
    assert "linkTargets" not in prompt_sections("c4", None, model)


def test_a_chat_turn_offers_the_projects_other_diagrams_and_links_one(api: Api, scripted: ScriptedModel) -> None:
    world = chat_world(api)
    other = api.new_diagram(world.project, world.architect, "Order flow", "flowchart")
    api.new_diagram(world.project, world.architect, "Someone's draft", "flowchart", draft=True)
    binned = api.new_diagram(world.project, world.architect, "Binned", "flowchart")
    assert api.call("DELETE", f"/diagrams/{binned['id']}", world.architect).status_code == 204
    scripted.script(tool_step("linkToDiagram", {"elementId": "A", "diagramId": other["id"]}), text_step("Linked."))

    response = world.chat("link A to the order flow", currentDslContent="flowchart TD\n  A[Start] --> B[End]\n")
    assert response.status_code == 200, response.text
    assert f"A: {other['id']}" in response.json()["updatedDslContent"]
    first = scripted.calls[0]
    assert "linkToDiagram" in {t.name for t in first.tools}
    assert f'## Diagrams you can link to\n\n- {other["id"]}: "Order flow" (flowchart)\n\n## Current diagram' in (
        first.system
    )
    assert "Someone's draft" not in first.system and "Binned" not in first.system
