"""canvas-1bty.15.7 (phase 11g-2): the AI chat's tools and prompt sections, native, against TypeScript.

Since the TypeScript copy is gone (canvas-1bty.16) the vectors are golden output, changed on purpose with
tests/data/update_ai_vectors.py (tool lists, descriptions, the unavailable-tool error; never the runs otherwise).

tests/data/ai_tools_vectors.json (see make_ai_tools_vectors.ts there) holds what the diagram bridge's AI operations
answer: every family's tool list (JSON Schemas included) under several standards, the prompt sections, and seeded
random tool-call sequences on corpus diagrams, invalid input included. Python must give the same JSON text: tool
lists and schemas key order included, error text for invalid input word for word.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from canvas_api.diagram_core import diagram_ops
from canvas_api.diagram_core.ai import list_tools, prompt_sections, run_tool
from canvas_api.diagram_core.jsvalues import to_js_json

DATA: dict[str, Any] = json.loads((Path(__file__).parent / "data" / "ai_tools_vectors.json").read_text("utf-8"))
RULES: list[Any] = DATA["rules"]
EMPTY = {"nodes": [], "edges": [], "containers": []}


def _text(value: Any) -> str:
    """JSON.stringify(value), key order included."""
    return json.dumps(to_js_json(value), separators=(",", ":"), ensure_ascii=False)


def _digest(value: Any) -> str:
    return hashlib.sha256(_text(value).encode("utf-8")).hexdigest()[:16]


@pytest.mark.parametrize("entry", DATA["tools"], ids=lambda e: f"{e['family']}-rules{e['rules']}")
def test_the_tool_list_matches_typescript(entry: dict[str, Any]) -> None:
    expected = [DATA["toolDefs"][i] for i in entry["tools"]]
    assert _text(list_tools(entry["family"], RULES[entry["rules"]])) == _text(expected)


@pytest.mark.parametrize("entry", DATA["standards"], ids=lambda e: f"{e['family']}-rules{e['rules']}")
def test_the_primer_and_standard_sections_match_typescript(entry: dict[str, Any]) -> None:
    sections = prompt_sections(entry["family"], RULES[entry["rules"]], EMPTY)
    assert sections["primer"] == entry["primer"]
    assert sections["standard"] == entry["standard"]


@pytest.mark.parametrize("entry", DATA["prompts"], ids=lambda e: f"{e['case']}-rules{e['rules']}")
def test_the_current_diagram_section_matches_typescript(entry: dict[str, Any]) -> None:
    model = DATA["models"][entry["case"]]
    assert prompt_sections(entry["family"], RULES[entry["rules"]], model)["currentDiagram"] == entry["currentDiagram"]


def _runs() -> Iterator[Any]:
    for index, run in enumerate(DATA["runs"]):
        yield pytest.param(run, id=f"{run['case']}-{index}")


@pytest.mark.parametrize("run", list(_runs()))
def test_every_tool_call_matches_typescript(run: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    family, rules = run["family"], RULES[run["rules"]]
    model = DATA["models"][run["case"]]
    for number, step in enumerate(run["steps"]):
        where = f"step {number} {step['name']}({json.dumps(step['input'])[:300]})"
        ids = iter(step.get("ids", []))
        monkeypatch.setattr(diagram_ops, "generate_id", lambda _prefix, ids=ids: next(ids))
        result = run_tool(family, rules, model, step["name"], step["input"])
        if "error" in step:
            assert not result["ok"], where
            assert result["error"] == step["error"], where
            continue
        assert result["ok"], f"{where}: {result.get('error')}"
        assert _text(result["output"]) == _text(step["output"]), where
        assert _text(result["outcomes"]) == _text(step["outcomes"]), where
        # The model crosses JSON between calls, as it does in the chat loop.
        model = to_js_json(result["model"])
        assert _digest(model) == step["hash"], where


#: Tools added after the runs were recorded (canvas-p2g8.2); tests/test_ai_layout_tools.py runs them.
LATER_TOOLS = {"moveElements", "alignElements", "distributeElements", "placeRelative", "arrange"}


def test_the_vectors_reach_every_tool_and_kind_of_answer() -> None:
    names = {t["name"] for t in DATA["toolDefs"]}
    called = {s["name"] for r in DATA["runs"] for s in r["steps"]}
    assert names - LATER_TOOLS <= called
    errors = {s["error"].split(":")[0].split("'")[0] for r in DATA["runs"] for s in r["steps"] if "error" in s}
    assert any(e.startswith("Invalid input for tool") for e in errors)
    assert "Model tried to call unavailable tool " in errors
    outputs = [s["output"] for r in DATA["runs"] for s in r["steps"] if "output" in s]
    assert any("newViolations" in o for o in outputs)
    assert any(o.get("reason", "").startswith("The standard doesn't allow") for o in outputs)


def test_an_empty_list_where_one_item_is_needed_reads_as_zod_says() -> None:
    # Captured from the bridge (packages/diagram-bridge/src/ai.ts runTool) on 2026-11-03.
    model = {"diagramTypeId": "uml", "nodes": [], "edges": [], "containers": []}
    result = run_tool("uml", None, model, "groupIntoContainer", {"nodeIds": [], "kind": "x"})
    assert result == {
        "ok": False,
        "error": "Invalid input for tool groupIntoContainer: Type validation failed: "
        'Value: {"nodeIds":[],"kind":"x"}.\n'
        "Error message: [\n"
        "  {\n"
        '    "origin": "array",\n'
        '    "code": "too_small",\n'
        '    "minimum": 1,\n'
        '    "inclusive": true,\n'
        '    "path": [\n'
        '      "nodeIds"\n'
        "    ],\n"
        '    "message": "Too small: expected array to have >=1 items"\n'
        "  },\n"
        "  {\n"
        '    "code": "invalid_value",\n'
        '    "values": [\n'
        '      "namespace",\n'
        '      "note"\n'
        "    ],\n"
        '    "path": [\n'
        '      "kind"\n'
        "    ],\n"
        '    "message": "Invalid option: expected one of \\"namespace\\"|\\"note\\""\n'
        "  }\n"
        "]",
    }


def test_a_c4_connector_may_end_on_a_boundary() -> None:
    """canvas-lwa4: Mermaid 12 lets a C4 relationship start or end on a boundary; the AI's addEdge does too."""
    model = {
        "diagramTypeId": "c4-context",
        "nodes": [{"id": "u", "label": "User", "shape": "person", "role": "person", "position": {"x": 0, "y": 0}}],
        "edges": [],
        "containers": [{"id": "b", "label": "Bank", "role": "system-boundary", "position": {"x": 0, "y": 0}}],
    }
    result = run_tool("c4", None, model, "addEdge", {"sourceId": "u", "targetId": "b", "label": "Uses"})
    assert result["output"] == {"applied": True}
    assert [(e["sourceId"], e["targetId"]) for e in result["model"]["edges"]] == [("u", "b")]
    missing = run_tool("c4", None, model, "addEdge", {"sourceId": "u", "targetId": "nowhere", "label": "Uses"})
    assert missing["output"]["applied"] is False
    flowchart = run_tool(
        "flowchart", None, {**model, "diagramTypeId": "flowchart"}, "addEdge", {"sourceId": "u", "targetId": "b"}
    )
    assert flowchart["output"]["applied"] is False
