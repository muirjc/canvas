"""canvas-bnnh part 2: state diagrams in the app -- the AI chat's tools for them, and creating, saving and exporting
one through the API."""

from __future__ import annotations

from typing import Any

from canvas_api.diagram_core import DiagramCore
from canvas_api.diagram_core.ai import list_tools, prompt_sections, run_tool
from canvas_api.diagram_core.ai.primers import primer_for
from tests.api import Api

core = DiagramCore()
EMPTY: dict[str, Any] = {"diagramTypeId": "state", "nodes": [], "edges": [], "containers": []}


def call(model: dict[str, Any], name: str, args: dict[str, Any]) -> dict[str, Any]:
    result = run_tool("state", None, model, name, args)
    assert result["ok"], result
    return result


def test_state_diagrams_get_add_state_instead_of_add_node() -> None:
    names = [t["name"] for t in list_tools("state", None)]
    assert "addState" in names and "addNode" not in names
    for name in ("addEdge", "groupIntoContainer", "arrange", "moveElements", "placeRelative"):
        assert name in names
    kinds = next(t for t in list_tools("state", None) if t["name"] == "addState")["inputSchema"]["properties"]["kind"]
    assert kinds["enum"] == ["state", "start", "end", "choice", "fork", "join"]
    primer = primer_for("state")
    assert primer is not None and all(k in primer for k in ("start", "end", "choice", "fork", "join", "composite"))


def test_the_ai_can_build_a_state_diagram_that_saves_as_mermaid() -> None:
    model = EMPTY
    ids: dict[str, str] = {}
    for key, args in (
        ("start", {"kind": "start"}),
        ("idle", {"kind": "state", "label": "Idle"}),
        ("busy", {"kind": "state", "label": "Busy"}),
        ("check", {"kind": "choice"}),
        ("end", {"kind": "end"}),
    ):
        result = call(model, "addState", args)
        model, ids[key] = result["model"], result["output"]["nodeId"]
    assert ids["start"] == "root_start" and ids["end"] == "root_end"
    # A second start is the same start.
    again = call(model, "addState", {"kind": "start"})
    assert again["output"]["nodeId"] == "root_start" and len(again["model"]["nodes"]) == len(model["nodes"])

    for source, target, label in (
        ("start", "idle", None),
        ("idle", "busy", "job arrives"),
        ("busy", "check", None),
        ("check", "idle", "more work"),
        ("check", "end", "shut down"),
    ):
        edge = {"sourceId": ids[source], "targetId": ids[target], **({"label": label} if label else {})}
        model = call(model, "addEdge", edge)["model"]
    grouped = call(model, "groupIntoContainer", {"nodeIds": [ids["busy"]], "label": "Working"})
    model, group = grouped["model"], grouped["output"]["containerId"]
    assert model["containers"][-1]["role"] == "composite"
    # A connector may end on the composite state itself.
    model = call(model, "addEdge", {"sourceId": ids["idle"], "targetId": group, "label": "start work"})["model"]
    model = call(model, "arrange", {"direction": "LR"})["model"]

    text = core.serialize("state", model)
    body = text[text.index("stateDiagram-v2") :]
    assert "[*] --> " in body and " --> [*] : shut down" in body
    assert "<<choice>>" in body and 'state "Working" as' in body
    again_model = core.parse("state", text)["model"]
    assert sorted(n["role"] for n in again_model["nodes"]) == ["choice", "end", "start", "state", "state"]
    described = prompt_sections("state", None, model)["currentDiagram"]
    assert "Current groups:" in described


def test_add_state_refuses_an_unknown_group_and_add_edge_an_unknown_end() -> None:
    result = call(EMPTY, "addState", {"kind": "state", "groupId": "ghost"})
    assert result["output"] == {"applied": False, "reason": "No group with id 'ghost' was found."}
    refused = call(EMPTY, "addEdge", {"sourceId": "a", "targetId": "b"})
    assert refused["output"]["applied"] is False


def test_a_state_diagram_is_created_saved_and_exported_through_the_api(api: Api) -> None:
    api.diagram_type("state", "state", name="State Diagram")
    owner = api.user("owner@example.com")
    project = api.project(owner)
    created = api.call("POST", f"/projects/{project}/diagrams", owner, json={"name": "Order", "diagramTypeId": "state"})
    assert created.status_code == 201, created.text
    diagram = created.json()["diagram"]
    assert diagram["dslContent"].strip().endswith("stateDiagram-v2")
    dsl = "stateDiagram-v2\n  [*] --> Placed\n  Placed --> Shipped : ship\n  Shipped --> [*]\n"
    saved = api.call(
        "PATCH",
        f"/diagrams/{diagram['id']}",
        owner,
        json={"dslContent": dsl, "baseVersionId": diagram["currentVersionId"]},
    )
    assert saved.status_code == 200, saved.text
    svg = api.call("GET", f"/diagrams/{diagram['id']}/export?format=svg", owner)
    assert svg.status_code == 200 and 'data-node-id="root_start"' in svg.text
    mermaid = api.call("GET", f"/diagrams/{diagram['id']}/export?format=mermaid", owner)
    assert "Placed --> Shipped : ship" in mermaid.text
