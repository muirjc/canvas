"""canvas-4h1j.2: Wardley maps in the app -- the diagram type and its starter standard, the AI chat's tools for
them, and creating, saving and exporting one through the API."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from canvas_api.diagram_core import DiagramCore
from canvas_api.diagram_core.ai import list_tools, prompt_sections, run_tool
from canvas_api.diagram_core.ai.primers import primer_for
from canvas_api.seed.diagram_types import DIAGRAM_TYPES
from canvas_api.seed.reference_standards import BUILT_IN_STANDARDS
from tests.api import Api

core = DiagramCore()
EMPTY: dict[str, Any] = {"diagramTypeId": "wardley", "nodes": [], "edges": [], "containers": []}
CORPUS = Path(__file__).resolve().parents[3] / "packages" / "diagram-core" / "corpus" / "cases"
WARDLEY_CASES = sorted(p.name for p in CORPUS.glob("wardley-*"))


def call(model: dict[str, Any], name: str, args: dict[str, Any]) -> dict[str, Any]:
    result = run_tool("wardley", None, model, name, args)
    assert result["ok"], result
    return result


def body(model: dict[str, Any]) -> str:
    return core.serialize("wardley", model)


# --- the type and its standard -----------------------------------------------------------------------------------


def test_the_wardley_map_type_is_for_business_and_enterprise_architects() -> None:
    seeded = next(t for t in DIAGRAM_TYPES if t.id == "wardley")
    assert (seeded.name, seeded.personas, seeded.dsl_family) == ("Wardley Map", ("Business", "Enterprise"), "wardley")


def test_the_starter_standard_finds_nothing_wrong_with_the_corpus_maps() -> None:
    assert WARDLEY_CASES, "no wardley corpus cases found"
    rules = next(s for s in BUILT_IN_STANDARDS if s["diagramTypeId"] == "wardley")["rules"]
    assert core.check_standard(rules, "wardley") == []
    for case in WARDLEY_CASES:
        parsed = core.parse("wardley", (CORPUS / case / "input.mmd").read_text("utf-8"))
        assert "model" in parsed, case
        assert core.validate(parsed["model"], rules) == [], case


# --- the AI tools ------------------------------------------------------------------------------------------------


def test_wardley_maps_get_their_own_tools_and_no_layout_or_style_tools() -> None:
    names = [t["name"] for t in list_tools("wardley", None)]
    for name in ("addComponent", "moveComponent", "setComponentMarkings", "addPipelineComponent", "setLinkFlow"):
        assert name in names
    for name in ("addEdge", "removeNode", "removeEdge", "updateNodeLabel", "updateEdgeLabel"):
        assert name in names
    for name in (
        "addNode",
        "updateNodeStyle",
        "updateEdgeStyle",
        "groupIntoContainer",
        "setConnectorStyle",
        "moveElements",
        "alignElements",
        "distributeElements",
        "placeRelative",
        "arrange",
    ):
        assert name not in names
    schemas = {t["name"]: t["inputSchema"] for t in list_tools("wardley", None)}
    assert schemas["addComponent"]["properties"]["kind"]["enum"] == [
        "anchor",
        "component",
        "note",
        "annotation",
        "accelerator",
        "deaccelerator",
    ]
    assert schemas["setLinkFlow"]["properties"]["flow"]["enum"] == ["forward", "backward", "both", "none"]
    primer = primer_for("wardley")
    assert primer is not None and all(w in primer for w in ("Genesis", "Custom Built", "Product", "Commodity"))


def test_the_ai_can_build_a_wardley_map_that_saves_as_mermaid() -> None:
    model = EMPTY
    ids: dict[str, str] = {}
    for key, args in (
        ("customer", {"kind": "anchor", "label": "Customer", "visibility": 0.95, "evolution": 0.6}),
        ("tea", {"kind": "component", "label": "Cup of Tea", "visibility": 0.8, "evolution": 0.6}),
        ("kettle", {"kind": "component", "label": "Kettle", "visibility": 0.45, "evolution": 0.35}),
        ("power", {"kind": "component", "label": "Power", "visibility": 0.1, "evolution": 0.7}),
        ("note", {"kind": "note", "label": "Power is a utility", "visibility": 0.2, "evolution": 0.5}),
    ):
        result = call(model, "addComponent", args)
        model, ids[key] = result["model"], result["output"]["nodeId"]
    for source, target in (("customer", "tea"), ("tea", "kettle"), ("kettle", "power")):
        model = call(model, "addEdge", {"sourceId": ids[source], "targetId": ids[target]})["model"]
    flow_edge = model["edges"][-1]["id"]
    model = call(model, "setLinkFlow", {"edgeId": flow_edge, "flow": "forward"})["model"]
    model = call(model, "moveComponent", {"nodeId": ids["kettle"], "visibility": 0.43, "evolution": 0.4})["model"]
    marked = call(
        model, "setComponentMarkings", {"nodeId": ids["kettle"], "strategy": "buy", "inertia": True, "evolve": 0.62}
    )
    model = marked["model"]
    piped = call(model, "addPipelineComponent", {"parentId": ids["kettle"], "label": "Electric", "evolution": 0.5})
    model = piped["model"]

    text = body(model)
    assert text.startswith("wardley-beta")
    for line in (
        "anchor Customer [0.95, 0.6]",
        "component Kettle [0.43, 0.4] (buy) (inertia)",
        "Customer -> Cup of Tea",
        "Kettle +> Power",
        "evolve Kettle 0.62",
        'note "Power is a utility" [0.2, 0.5]',
        "component Electric [0.5]",
    ):
        assert line in text, (line, text)
    reread = core.parse("wardley", text)["model"]
    assert sorted(n["role"] for n in reread["nodes"]) == [
        "anchor",
        "component",
        "component",
        "component",
        "note",
        "pipeline-component",
    ]

    # Clearing the markings and the flow.
    model = call(
        model,
        "setComponentMarkings",
        {"nodeId": ids["kettle"], "strategy": "none", "inertia": False, "removeEvolve": True},
    )["model"]
    model = call(model, "setLinkFlow", {"edgeId": flow_edge, "flow": "none"})["model"]
    text = body(model)
    assert "(buy)" not in text and "(inertia)" not in text and "evolve" not in text
    assert "Kettle -> Power" in text

    # Removing the kettle takes its pipeline and links with it.
    model = call(model, "removeNode", {"nodeId": ids["kettle"]})["model"]
    assert {n["label"] for n in model["nodes"]} == {"Customer", "Cup of Tea", "Power", "Power is a utility"}
    assert model["containers"] == [] and len(model["edges"]) == 1


def test_the_wardley_tools_refuse_what_the_map_cant_hold() -> None:
    model = EMPTY
    for args in (
        {"kind": "component", "label": "Kettle", "visibility": 0.4, "evolution": 0.3},
        {"kind": "component", "label": "Power", "visibility": 0.1, "evolution": 0.8},
        {"kind": "note", "label": "a note"},
    ):
        model = call(model, "addComponent", args)["model"]
    kettle, power, note = (n["id"] for n in model["nodes"])

    renamed = call(model, "updateNodeLabel", {"nodeId": kettle, "label": "Power"})
    assert renamed["output"]["applied"] is False and "already called 'Power'" in renamed["output"]["reason"]
    assert call(model, "updateNodeLabel", {"nodeId": kettle, "label": "Boiler"})["output"] == {"applied": True}

    to_note = call(model, "addEdge", {"sourceId": kettle, "targetId": note})
    assert to_note["output"]["applied"] is False and "is a note" in to_note["output"]["reason"]

    marked = call(model, "setComponentMarkings", {"nodeId": note, "strategy": "build"})
    assert marked["output"]["applied"] is False
    both = call(model, "setComponentMarkings", {"nodeId": kettle, "evolve": 0.5, "removeEvolve": True})
    assert both["output"]["applied"] is False

    # A pipeline component takes an evolve arrow but no strategy or inertia.
    piped = call(model, "addPipelineComponent", {"parentId": kettle, "label": "Electric", "evolution": 0.5})
    child = piped["output"]["nodeId"]
    for patch in ({"strategy": "build"}, {"inertia": True}, {"strategy": "none", "evolve": 0.7}):
        refused_marking = call(piped["model"], "setComponentMarkings", {"nodeId": child, **patch})
        assert refused_marking["output"]["applied"] is False
        assert "only have an evolve arrow" in refused_marking["output"]["reason"]
    evolved = call(piped["model"], "setComponentMarkings", {"nodeId": child, "evolve": 0.7})
    assert evolved["output"] == {"applied": True}
    assert "evolve Electric 0.7" in body(evolved["model"])

    for name, args, what in (
        ("moveComponent", {"nodeId": "ghost", "visibility": 0.5, "evolution": 0.5}, "element"),
        ("setComponentMarkings", {"nodeId": "ghost", "inertia": True}, "component"),
        ("addPipelineComponent", {"parentId": "ghost"}, "component"),
        ("setLinkFlow", {"edgeId": "ghost", "flow": "both"}, "link"),
    ):
        assert call(model, name, args)["output"] == {
            "applied": False,
            "reason": f"No {what} with id 'ghost' was found.",
        }

    # An edit wardley_ops refuses comes back as the tool's error.
    refused = run_tool("wardley", None, model, "addPipelineComponent", {"parentId": note})
    assert refused["ok"] is False and "only a component" in refused["error"]
    unknown = run_tool("wardley", None, model, "addNode", {"shape": "circle"})
    assert unknown["ok"] is False and "unavailable tool 'addNode'" in unknown["error"]
    _ = power


def test_the_prompt_describes_the_map_by_its_coordinates() -> None:
    text = (CORPUS / "wardley-complete" / "input.mmd").read_text("utf-8")
    model = core.parse("wardley", text)["model"]
    described = prompt_sections("wardley", None, model)["currentDiagram"]
    assert (
        '"Database" (component) [visibility 0.5, evolution 0.45; strategy buy; inertia; evolving to 0.75]' in described
    )
    assert '"Cloud Native" (accelerator) [visibility 0.2, evolution 0.85]' in described
    assert "number 2" in described
    assert " at (" not in described and "size" not in described

    piped = core.parse(
        "wardley",
        "wardley-beta\ncomponent Kettle [45.0, 35.0]\npipeline Kettle {\n  component Electric [0.6]\n}\n"
        "Kettle +<> Electric\n",
    )["model"]
    described = prompt_sections("wardley", None, piped)["currentDiagram"]
    assert '"Kettle" (component) [visibility 0.45, evolution 0.35]' in described
    assert "in the pipeline of Kettle" in described
    assert "(flow both ways)" in described


@pytest.mark.parametrize("percent", [False, True])
def test_coordinates_written_as_percentages_are_shown_as_fractions(percent: bool) -> None:
    point = "[63.0, 79.0]" if percent else "[0.63, 0.79]"
    model = core.parse("wardley", f"wardley-beta\ncomponent Tea {point}\n")["model"]
    assert "[visibility 0.63, evolution 0.79]" in prompt_sections("wardley", None, model)["currentDiagram"]


# --- through the API ---------------------------------------------------------------------------------------------


def test_a_wardley_map_is_created_saved_and_exported_through_the_api(api: Api) -> None:
    api.diagram_type("wardley", "wardley", name="Wardley Map")
    owner = api.user("owner@example.com")
    project = api.project(owner)
    created = api.call("POST", f"/projects/{project}/diagrams", owner, json={"name": "Tea", "diagramTypeId": "wardley"})
    assert created.status_code == 201, created.text
    diagram = created.json()["diagram"]
    assert diagram["dslContent"].strip().startswith("wardley-beta")
    dsl = "wardley-beta\ntitle Tea\nanchor Business [0.95, 0.63]\ncomponent Tea [0.63, 0.81]\nBusiness -> Tea\n"
    saved = api.call(
        "PATCH",
        f"/diagrams/{diagram['id']}",
        owner,
        json={"dslContent": dsl, "baseVersionId": diagram["currentVersionId"]},
    )
    assert saved.status_code == 200, saved.text
    svg = api.call("GET", f"/diagrams/{diagram['id']}/export?format=svg", owner)
    assert svg.status_code == 200 and "<svg" in svg.text and "Tea" in svg.text
    mermaid = api.call("GET", f"/diagrams/{diagram['id']}/export?format=mermaid", owner)
    assert mermaid.status_code == 200 and "Business -> Tea" in mermaid.text
