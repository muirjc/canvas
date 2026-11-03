"""DiagramCore, what the routes call (canvas_api/diagram_core/core.py): every operation answers natively, with the
shapes the TypeScript bridge used to give; where TypeScript throws, it raises DiagramCoreError. The answers
themselves are pinned against TypeScript elsewhere (corpus, vectors, comparisons with tests/diagram_bridge.py)."""

from __future__ import annotations

from typing import Any

import pytest

from canvas_api.diagram_core import DiagramCore, DiagramCoreError
from canvas_api.diagram_core.core import KNOWN_FAMILIES, PARSERS, SERIALIZERS
from canvas_api.diagram_core.diagram_ops import ids_from

SECRET = "Confidential-Payroll-Gateway"  # gitleaks:allow
FLOWCHART = f"flowchart TD\n  A[{SECRET}] --> B\n"
BAD_FRONT_MATTER = f"---\ncanvas: [{SECRET}\n---\nflowchart TD\n  A --> B\n"
SEQUENCE = "sequenceDiagram\n  A->>B: hi\n"
C4 = 'C4Context\n  Person(a, "A")\n'
RULES: dict[str, Any] = {
    "allowedShapeIds": ["rectangle"],
    "mandatoryShapeIds": [],
    "allowedIconLibraryRefs": [],
    "colorPalette": [],
}
TEMPLATE = "# T\n## 3. Services\n| Service |\n|---|\n| Web |\n## 5. Connections\n| From | To |\n|---|---|\n"
EMPTY_SEQUENCE: dict[str, Any] = {"diagramTypeId": "sequence", "nodes": [], "edges": [], "containers": []}
core = DiagramCore()


def test_every_family_parses_and_serializes() -> None:
    assert set(PARSERS) == set(SERIALIZERS) == set(KNOWN_FAMILIES)


def test_parsing_and_serializing() -> None:
    assert core.detect(FLOWCHART) == "flowchart"
    parsed = core.parse("flowchart", FLOWCHART)
    assert [n["id"] for n in parsed["model"]["nodes"]] == ["A", "B"]
    assert core.serialize("flowchart", parsed["model"]).startswith("---\ncanvas:")
    assert core.portable(FLOWCHART).startswith("flowchart TD")
    assert core.detect_and_parse(FLOWCHART)["family"] == "flowchart"
    assert core.empty_dsl("flowchart", "flowchart").startswith("flowchart")
    assert [n["id"] for n in core.parse("sequence", SEQUENCE)["model"]["nodes"]] == ["A", "B"]
    assert core.serialize("c4", core.parse("c4", C4)["model"]).startswith("---\ncanvas:")
    assert core.detect_and_parse(C4, "c4")["family"] == "c4"
    assert core.empty_dsl("erd", "erd").startswith("erDiagram")
    assert core.portable(C4, strip_front_matter=True).startswith("C4Context")


def test_a_diagram_that_does_not_parse_is_an_answer_not_an_error() -> None:
    result = core.parse("flowchart", "flowchart TD\n  A -->\n")
    assert result["errors"][0]["line"] == 2


def test_detect_and_parse_reports_an_unrecognized_header() -> None:
    unrecognized = [{"message": "Unrecognized diagram header"}]
    assert core.detect_and_parse("not a diagram") == {"family": None, "errors": unrecognized}
    assert core.detect_and_parse(FLOWCHART, "gantt") == {"family": "gantt", "errors": unrecognized}


def test_where_typescript_throws_it_is_a_diagram_core_error_that_never_quotes_the_diagram() -> None:
    with pytest.raises(DiagramCoreError, match="diagram-core parse") as parse_error:
        core.parse("flowchart", BAD_FRONT_MATTER)
    with pytest.raises(DiagramCoreError, match="diagram-core detect-and-parse"):
        core.detect_and_parse(BAD_FRONT_MATTER, "flowchart")
    # A model or standard missing a field the code reads: only the error's type.
    with pytest.raises(DiagramCoreError, match=r"^diagram-core validate: KeyError$"):
        core.validate({"nodes": [], "edges": [], "containers": []}, {"elementKinds": []})
    for unknown in (lambda: core.parse("gantt", "gantt"), lambda: core.serialize("gantt", {})):
        with pytest.raises(DiagramCoreError, match="unknown family 'gantt'"):
            unknown()
    with pytest.raises(DiagramCoreError):
        core.svg_prepare([{"svg": 1, "idPrefix": "p"}])
    with pytest.raises(DiagramCoreError):
        core.load_library([])
    # A YAML error's message does quote the input: that's the parser's own report, as in TypeScript.
    assert parse_error.value.__cause__ is not None


def test_an_unexpected_error_is_not_hidden(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_args: Any) -> Any:
        raise ValueError("a bug in the port")

    monkeypatch.setattr("canvas_api.diagram_core.core.validate", boom)
    with pytest.raises(ValueError, match="a bug in the port"):
        core.validate({"nodes": []}, RULES)


def test_standards() -> None:
    model = core.parse("flowchart", "flowchart TD\n  A((Start)) --> B\n")["model"]
    [violation] = core.validate(model, RULES)
    assert (violation["elementId"], violation["rule"], violation["severity"]) == ("A", "allowed-shapes", "warning")
    assert core.check_standard(RULES, "flowchart") == []
    bad = {**RULES, "elementKinds": [{"id": "End", "label": "x", "shapes": [], "approvedFills": []}]}
    [issue] = core.check_standard(bad, "flowchart")
    assert issue["path"] == "elementKinds[0].id"


def test_rendering_and_templates() -> None:
    svg = core.render_svg(core.parse("flowchart", FLOWCHART)["model"], background="#ffffff")
    assert svg.startswith('<svg xmlns="http://www.w3.org/2000/svg"')
    assert '<rect width="100%" height="100%" fill="#ffffff" />' in svg
    assert core.compile_template("network", TEMPLATE) == {"dsl": "architecture-beta\n    service web(server)[Web]\n"}
    assert core.compile_template("flowchart", TEMPLATE) == {"unsupported": True}


def test_the_library_operations_and_embeds() -> None:
    assert core.svg_sanitize_strict([{"svg": '<g id="a" onclick="x()"/>', "idPrefix": "p"}]) == [
        {"ok": True, "assetRef": '<g id="p-a"/>'}
    ]
    assert core.svg_prepare([{"svg": "hello", "idPrefix": "p"}]) == [{"ok": False, "error": "This isn't an SVG file."}]
    assert core.load_library({"id": "l", "version": "1", "icons": []}) == {
        "ok": True,
        "library": {"id": "l", "version": "1", "icons": []},
    }
    assert core.icon_refs([{"family": "flowchart", "dsl": FLOWCHART}]) == [[]]
    assert core.embeds("# Doc\n", "docs/a.md", {})["changed"] is False


def test_the_ai_operations() -> None:
    assert [t["name"] for t in core.ai_tools("sequence", None)][-2:] == ["activateParticipant", "deactivateParticipant"]
    added = core.ai_tool("sequence", None, EMPTY_SEQUENCE, "addNode", {"shape": "person", "label": "Ann"})
    assert added["ok"] is True
    assert added["model"]["nodes"][0]["label"] == "Ann"
    assert added["outcomes"] == [{"tool": "addNode", "applied": True}]
    assert core.ai_tool("sequence", None, EMPTY_SEQUENCE, "nope", {})["ok"] is False
    assert core.ai_prompt("sequence", None, EMPTY_SEQUENCE)["currentDiagram"].startswith("Current shapes:\n(none yet)")


def test_supplied_ids_apply_only_inside_their_block() -> None:
    call = ("sequence", None, EMPTY_SEQUENCE, "addNode", {"shape": "person"})
    with ids_from(["n-supplied"]):
        assert core.ai_tool(*call)["output"]["nodeId"] == "n-supplied"
    assert core.ai_tool(*call)["output"]["nodeId"] != "n-supplied"
