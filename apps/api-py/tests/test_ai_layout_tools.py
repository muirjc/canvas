"""canvas-p2g8.2: the AI chat's layout tools and what it is told about positions, through run_tool and
prompt_sections -- the path the chat loop takes (schema checks included). The arithmetic itself is
tests/test_diagram_core_layout_ops.py."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from canvas_api.diagram_core import DiagramCore
from canvas_api.diagram_core.ai import list_tools, prompt_sections, run_tool

LAYOUT_TOOLS = ["moveElements", "alignElements", "distributeElements", "placeRelative", "arrange"]
#: A rule set with element kinds and requireKnownKinds (start/step/decision/store), from the AI vectors.
KIND_RULES: dict[str, Any] = json.loads((Path(__file__).parent / "data" / "ai_tools_vectors.json").read_text("utf-8"))[
    "rules"
][5]


def node(node_id: str, x: float, y: float, **extra: Any) -> dict[str, Any]:
    return {
        "id": node_id,
        "label": node_id.upper(),
        "shape": "rectangle",
        "position": {"x": x, "y": y},
        "size": {"width": 100, "height": 50},
        **extra,
    }


def flowchart(*nodes: dict[str, Any], containers: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"diagramTypeId": "flowchart", "nodes": list(nodes), "edges": [], "containers": containers or []}


def positions(model: dict[str, Any]) -> dict[str, tuple[float, float]]:
    return {n["id"]: (n["position"]["x"], n["position"]["y"]) for n in model["nodes"]}


def call(model: dict[str, Any], name: str, args: dict[str, Any], family: str = "flowchart") -> dict[str, Any]:
    result = run_tool(family, None, model, name, args)
    assert result["ok"], result
    return result


@pytest.mark.parametrize("family", ["flowchart", "c4", "architecture", "erd", "uml"])
def test_every_family_with_stored_positions_gets_the_layout_tools(family: str) -> None:
    names = [t["name"] for t in list_tools(family, None)]
    assert all(name in names for name in LAYOUT_TOOLS)


def test_sequence_diagrams_do_not_since_their_layout_is_computed() -> None:
    names = [t["name"] for t in list_tools("sequence", None)]
    assert not any(name in names for name in LAYOUT_TOOLS)
    add_node = next(t for t in list_tools("sequence", None) if t["name"] == "addNode")
    assert "near" not in add_node["inputSchema"]["properties"]


def test_move_elements_moves_shapes_and_groups_with_their_contents() -> None:
    group = {"id": "g", "label": "G", "position": {"x": 0, "y": 0}, "size": {"width": 300, "height": 200}}
    model = flowchart(node("a", 10, 10, containerId="g"), node("b", 400, 0), containers=[group])
    result = call(model, "moveElements", {"moves": [{"id": "g", "x": 100, "y": 100}, {"id": "b", "x": 5, "y": 6}]})
    assert result["outcomes"] == [{"tool": "moveElements", "applied": True}]
    assert positions(result["model"]) == {"a": (110, 110), "b": (5, 6)}


def test_an_unknown_id_refuses_the_whole_call_and_moves_nothing() -> None:
    model = flowchart(node("a", 0, 0), node("b", 200, 0))
    for name, args in (
        ("moveElements", {"moves": [{"id": "a", "x": 50, "y": 50}, {"id": "ghost", "x": 1, "y": 1}]}),
        ("alignElements", {"ids": ["a", "ghost"], "alignment": "top"}),
        ("distributeElements", {"ids": ["a", "b", "ghost"], "axis": "horizontal"}),
        ("placeRelative", {"elementId": "a", "side": "below", "anchorId": "ghost"}),
    ):
        result = call(model, name, args)
        assert result["output"] == {"applied": False, "reason": "No shape or group with id 'ghost' was found."}
        assert positions(result["model"]) == positions(model), name


def test_align_distribute_and_place_relative() -> None:
    model = flowchart(node("a", 0, 0), node("b", 150, 40), node("c", 400, 80))
    assert positions(call(model, "alignElements", {"ids": ["a", "b", "c"], "alignment": "top"})["model"]) == {
        "a": (0, 0),
        "b": (150, 0),
        "c": (400, 0),
    }
    spread = call(model, "distributeElements", {"ids": ["a", "b", "c"], "axis": "horizontal"})["model"]
    assert positions(spread)["b"] == (200, 40)
    placed = call(model, "placeRelative", {"elementId": "c", "side": "below", "anchorId": "a", "gap": 20})["model"]
    assert positions(placed)["c"] == (0, 70)
    beside = call(model, "placeRelative", {"elementId": "c", "side": "right", "anchorId": "a"})["model"]
    assert positions(beside)["c"] == (160, 0)  # the default gap, 60


def test_place_relative_refuses_to_place_a_shape_next_to_itself() -> None:
    result = call(flowchart(node("a", 0, 0)), "placeRelative", {"elementId": "a", "side": "below", "anchorId": "a"})
    assert result["output"] == {"applied": False, "reason": "A shape can't be placed next to itself."}


def test_the_schemas_hold_the_model_to_enough_ids() -> None:
    model = flowchart(node("a", 0, 0), node("b", 1, 1))
    too_few = run_tool("flowchart", None, model, "distributeElements", {"ids": ["a", "b"], "axis": "vertical"})
    assert not too_few["ok"]
    assert "Too small: expected array to have >=3 items" in too_few["error"]
    bad_side = run_tool("flowchart", None, model, "placeRelative", {"elementId": "a", "side": "under", "anchorId": "b"})
    assert not bad_side["ok"]


def test_add_node_can_go_next_to_an_existing_shape_instead_of_the_next_grid_slot() -> None:
    model = flowchart(node("api", 300, 100))
    result = call(model, "addNode", {"shape": "cylinder", "label": "DB", "near": {"anchorId": "api", "side": "below"}})
    new_id = result["output"]["nodeId"]
    added = next(n for n in result["model"]["nodes"] if n["id"] == new_id)
    assert added["position"]["y"] == 100 + 50 + 60  # under the anchor, the default gap apart
    plain = call(model, "addNode", {"shape": "cylinder", "label": "DB"})
    assert (
        next(n for n in plain["model"]["nodes"] if n["id"] == plain["output"]["nodeId"])["position"]
        != added["position"]
    )


def test_add_node_next_to_an_unknown_shape_adds_nothing() -> None:
    model = flowchart(node("api", 300, 100))
    result = call(model, "addNode", {"shape": "cylinder", "near": {"anchorId": "ghost", "side": "left"}})
    assert result["output"] == {"applied": False, "reason": "No shape or group with id 'ghost' was found."}
    assert len(result["model"]["nodes"]) == 1


def test_add_element_takes_the_same_hint_under_a_standard() -> None:
    model = flowchart(node("a", 100, 100, role="step"))
    result = run_tool(
        "flowchart", KIND_RULES, model, "addElement", {"kind": "step", "near": {"anchorId": "a", "side": "right"}}
    )
    assert result["ok"], result
    new_id = result["output"]["nodeId"]
    added = next(n for n in result["model"]["nodes"] if n["id"] == new_id)
    assert added["position"]["x"] == 100 + 100 + 60


def test_the_model_is_told_where_shapes_and_groups_are() -> None:
    group = {
        "id": "g",
        "label": "Payments",
        "role": "boundary",
        "position": {"x": 0, "y": 0},
        "size": {"width": 300, "height": 200},
    }
    model = flowchart(node("a", 10.4, 20.5, containerId="g"), node("b", 400, 0), containers=[group])
    described = prompt_sections("flowchart", None, model)["currentDiagram"]
    assert '- a: "A" (rectangle) at (10, 21), size 100x50, in g' in described
    assert '- b: "B" (rectangle) at (400, 0), size 100x50' in described
    assert 'Current groups:\n- g: "Payments" (boundary) at (0, 0), size 300x200' in described


def test_a_sequence_diagram_is_described_without_positions() -> None:
    model = {"diagramTypeId": "sequence", "nodes": [node("a", 0, 0)], "edges": [], "containers": []}
    assert prompt_sections("sequence", None, model)["currentDiagram"] == (
        'Current shapes:\n- a: "A" (rectangle)\n\nCurrent connectors:\n(none yet)'
    )


# --- arrange: the editor's Auto Layout, from the AI ------------------------------------------------------------

ARRANGE_DSL = {
    "flowchart": "flowchart TD\n  A --> B\n  A --> C\n  C --> D\n",
    "c4": 'C4Context\n  Person(u, "User")\n  System(s, "Shop")\n  System_Ext(p, "Payments")\n  Rel(u, s, "buys")\n'
    '  Rel(s, p, "charges")\n',
    "erd": "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE : has\n",
    "uml": "classDiagram\n  Animal <|-- Dog\n  Animal <|-- Cat\n",
    "architecture": "architecture-beta\n  group api(cloud)[API]\n  service db(database)[DB] in api\n"
    "  service web(server)[Web] in api\n  db:L -- R:web\n",
}


@pytest.mark.parametrize("family", sorted(ARRANGE_DSL))
def test_arrange_is_exactly_the_editors_auto_layout(family: str) -> None:
    """The AI's arrange and the toolbar's Auto Layout run the same engine (the Python port is held to the
    TypeScript one by tests/test_diagram_core_auto_layout.py), so they can't disagree."""
    core = DiagramCore()
    model = core.parse(family, ARRANGE_DSL[family])["model"]
    tool = next(t for t in list_tools(family, None) if t["name"] == "arrange")
    if family == "architecture":
        assert tool["inputSchema"]["properties"] == {}  # placement comes from the diagram's own anchors
        result = call(model, "arrange", {}, family)
        assert result["model"] == core.auto_layout(model, None, family)
    else:
        result = call(model, "arrange", {"direction": "LR"}, family)
        assert result["model"] == core.auto_layout(model, "LR", family)
        assert result["model"] != call(model, "arrange", {"direction": "TD"}, family)["model"]
    assert result["outcomes"] == [{"tool": "arrange", "applied": True}]


def test_arrange_keeps_the_current_direction_when_none_is_given() -> None:
    core = DiagramCore()
    model = core.parse("flowchart", "flowchart LR\n  A --> B --> C\n")["model"]
    assert call(model, "arrange", {})["model"] == core.auto_layout(model, None, "flowchart")
    xs = [n["position"]["x"] for n in call(model, "arrange", {})["model"]["nodes"]]
    assert xs == sorted(xs) and len(set(xs)) == 3  # still left to right


def test_sequence_diagrams_have_no_arrange() -> None:
    assert "arrange" not in [t["name"] for t in list_tools("sequence", None)]
