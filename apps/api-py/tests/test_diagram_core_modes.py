"""canvas-1bty.15.1, .15.2: DiagramCore's modes (native / shadow / bridge) with a fake bridge, so no Node is needed."""

from __future__ import annotations

import logging
from typing import Any

import pytest

from canvas_api.diagram_core import BridgeError, DiagramCore
from canvas_api.diagram_core.core import KNOWN_FAMILIES, NATIVE_FAMILIES, Mode

LOGGER = "canvas_api.diagram_core"
SECRET = "Confidential-Payroll-Gateway"  # gitleaks:allow
FLOWCHART = f"flowchart TD\n  A[{SECRET}] --> B\n"
BAD_FRONT_MATTER = f"---\ncanvas: [{SECRET}\n---\nflowchart TD\n  A --> B\n"
SEQUENCE = "sequenceDiagram\n  A->>B: hi\n"
C4 = 'C4Context\n  Person(a, "A")\n'


class FakeBridge:
    """Stands in for DiagramBridge: records the calls it gets and answers from `answers`, else with a marker."""

    def __init__(self, **answers: Any) -> None:
        self.answers = answers
        self.calls: list[str] = []
        self.closed = False

    def _answer(self, op: str, default: Any) -> Any:
        self.calls.append(op)
        return self.answers.get(op, default)

    def health(self) -> bool:
        return self.answers.get("health", True)  # type: ignore[no-any-return]

    def close(self) -> None:
        self.closed = True

    def detect(self, dsl: str) -> str | None:
        return self._answer("detect", "bridge-family")  # type: ignore[no-any-return]

    def parse(self, family: str, dsl: str) -> dict[str, Any]:
        return self._answer("parse", {"model": {"from": "bridge"}})  # type: ignore[no-any-return]

    def serialize(self, family: str, model: dict[str, Any]) -> str:
        return self._answer("serialize", "from the bridge")  # type: ignore[no-any-return]

    def detect_and_parse(self, dsl: str, family: str | None = None) -> dict[str, Any]:
        return self._answer("detect_and_parse", {"family": "bridge", "model": {}})  # type: ignore[no-any-return]

    def empty_dsl(self, family: str, diagram_type_id: str) -> str:
        return self._answer("empty_dsl", "from the bridge")  # type: ignore[no-any-return]

    def portable(self, dsl: str, *, strip_front_matter: bool = False) -> str:
        return self._answer("portable", "from the bridge")  # type: ignore[no-any-return]

    def validate(self, model: dict[str, Any], rules: dict[str, Any]) -> list[dict[str, Any]]:
        return self._answer("validate", [])  # type: ignore[no-any-return]

    def check_standard(self, rules: dict[str, Any], family: str) -> list[dict[str, Any]]:
        return self._answer("check_standard", [])  # type: ignore[no-any-return]

    def render_svg(self, model: dict[str, Any], **_options: Any) -> str:
        return self._answer("render_svg", "<svg/>")  # type: ignore[no-any-return]

    def compile_template(self, diagram_type_id: str, template: str) -> dict[str, Any]:
        return self._answer("compile_template", {"dsl": "from the bridge"})  # type: ignore[no-any-return]

    def load_library(self, manifest: Any) -> dict[str, Any]:
        return self._answer("load_library", {"library": "from the bridge"})  # type: ignore[no-any-return]


def core_with(bridge: FakeBridge | None, mode: Mode) -> DiagramCore:
    return DiagramCore(bridge, mode)  # type: ignore[arg-type]


def native_answers() -> dict[str, Any]:
    """What native alone says for FLOWCHART, to build a bridge that agrees with it."""
    native = DiagramCore(None)
    parsed = native.parse("flowchart", FLOWCHART)
    return {
        "detect": "flowchart",
        "parse": parsed,
        "serialize": native.serialize("flowchart", parsed["model"]),
        "portable": native.portable(FLOWCHART),
    }


def test_every_family_is_ported() -> None:
    assert frozenset(KNOWN_FAMILIES) == NATIVE_FAMILIES


# --- bridge mode -------------------------------------------------------------------------------------


def test_bridge_mode_answers_everything_from_the_bridge() -> None:
    bridge = FakeBridge()
    core = core_with(bridge, "bridge")
    assert core.detect(FLOWCHART) == "bridge-family"
    assert core.parse("flowchart", FLOWCHART) == {"model": {"from": "bridge"}}
    assert core.serialize("flowchart", {}) == "from the bridge"
    assert core.empty_dsl("flowchart", "flowchart") == "from the bridge"
    assert core.portable(FLOWCHART) == "from the bridge"
    assert core.detect_and_parse(FLOWCHART) == {"family": "bridge", "model": {}}


# --- native mode -------------------------------------------------------------------------------------


def test_native_mode_answers_ported_operations_without_the_bridge() -> None:
    bridge = FakeBridge()
    core = core_with(bridge, "native")
    assert core.detect(FLOWCHART) == "flowchart"
    parsed = core.parse("flowchart", FLOWCHART)
    assert [n["id"] for n in parsed["model"]["nodes"]] == ["A", "B"]
    assert core.serialize("flowchart", parsed["model"]).startswith("---\ncanvas:")
    assert core.portable(FLOWCHART).startswith("flowchart TD")
    assert core.detect_and_parse(FLOWCHART)["family"] == "flowchart"
    assert core.empty_dsl("flowchart", "flowchart").startswith("flowchart")
    assert bridge.calls == []


def test_native_mode_answers_every_family_without_the_bridge() -> None:
    bridge = FakeBridge()
    core = core_with(bridge, "native")
    assert [n["id"] for n in core.parse("sequence", SEQUENCE)["model"]["nodes"]] == ["A", "B"]
    c4 = core.parse("c4", C4)["model"]
    assert core.serialize("c4", c4).startswith("---\ncanvas:")
    assert core.detect_and_parse(SEQUENCE)["family"] == "sequence"
    assert core.detect_and_parse(C4, "c4")["family"] == "c4"
    assert core.empty_dsl("erd", "erd").startswith("erDiagram")
    assert core.portable(C4, strip_front_matter=True).startswith("C4Context")
    assert bridge.calls == []


def test_native_yaml_errors_become_bridge_errors() -> None:
    core = core_with(FakeBridge(), "native")
    with pytest.raises(BridgeError, match="diagram-core parse"):
        core.parse("flowchart", BAD_FRONT_MATTER)
    with pytest.raises(BridgeError, match="diagram-core detect-and-parse"):
        core.detect_and_parse(BAD_FRONT_MATTER, "flowchart")


def test_a_diagram_that_does_not_parse_is_an_answer_not_an_error() -> None:
    result = core_with(None, "native").parse("flowchart", "flowchart TD\n  A -->\n")
    assert "errors" in result
    assert result["errors"][0]["line"] == 2


def test_detect_and_parse_reports_an_unrecognized_header() -> None:
    core = core_with(FakeBridge(), "native")
    assert core.detect_and_parse("not a diagram") == {
        "family": None,
        "errors": [{"message": "Unrecognized diagram header"}],
    }
    assert core.detect_and_parse(FLOWCHART, "gantt") == {
        "family": "gantt",
        "errors": [{"message": "Unrecognized diagram header"}],
    }


# --- shadow mode -------------------------------------------------------------------------------------


def test_shadow_mode_returns_the_bridges_answer_and_is_quiet_when_they_agree(caplog: pytest.LogCaptureFixture) -> None:
    answers = native_answers()
    core = core_with(FakeBridge(**answers), "shadow")
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        assert core.detect(FLOWCHART) == "flowchart"
        assert core.parse("flowchart", FLOWCHART) == answers["parse"]
        assert core.serialize("flowchart", answers["parse"]["model"]) == answers["serialize"]
        assert core.portable(FLOWCHART) == answers["portable"]
    assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []
    assert {r.__dict__["op"] for r in caplog.records} == {"detect", "parse", "serialize", "portable"}


def test_shadow_mode_logs_a_mismatch_and_still_returns_the_bridges_answer(caplog: pytest.LogCaptureFixture) -> None:
    other = {"model": {"nodes": [], "edges": [], "containers": [], "diagramTypeId": "flowchart"}}
    core = core_with(FakeBridge(parse=other), "shadow")
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        assert core.parse("flowchart", FLOWCHART) == other
    [record] = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert record.name == LOGGER
    assert record.getMessage() == "diagram-core shadow mismatch"
    assert (record.__dict__["op"], record.__dict__["family"], record.__dict__["native"]) == (
        "parse",
        "flowchart",
        "different",
    )


def test_shadow_mismatch_logs_never_contain_the_diagram(caplog: pytest.LogCaptureFixture) -> None:
    core = core_with(FakeBridge(parse={"model": {}}, serialize="x", detect="sequence", portable="x"), "shadow")
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        core.parse("flowchart", FLOWCHART)
        core.serialize("flowchart", core.parse("flowchart", FLOWCHART)["model"])
        core.detect(FLOWCHART)
        core.portable(FLOWCHART)
    assert [r for r in caplog.records if r.levelno == logging.WARNING]
    for record in caplog.records:
        assert SECRET not in record.getMessage()
        assert SECRET not in repr(record.__dict__)


def test_shadow_mode_logs_a_native_error_without_failing_the_request(caplog: pytest.LogCaptureFixture) -> None:
    bridge_answer = {"errors": [{"message": "bridge says no"}]}
    core = core_with(FakeBridge(parse=bridge_answer), "shadow")
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        assert core.parse("flowchart", BAD_FRONT_MATTER) == bridge_answer
    [record] = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert record.__dict__["native"] == "error"
    assert record.__dict__["op"] == "parse"


def test_shadow_error_logs_never_contain_the_diagram(caplog: pytest.LogCaptureFixture) -> None:
    """The YAML error for broken front matter can quote the text around the problem."""
    core = core_with(FakeBridge(parse={"errors": []}), "shadow")
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        core.parse("flowchart", BAD_FRONT_MATTER)
    for record in caplog.records:
        assert SECRET not in record.getMessage()
        assert SECRET not in repr(record.__dict__)


def test_shadow_mode_compares_every_family(caplog: pytest.LogCaptureFixture) -> None:
    native = DiagramCore(None)
    answer = native.parse("sequence", SEQUENCE)
    bridge = FakeBridge(parse=answer)
    core = core_with(bridge, "shadow")
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        assert core.parse("sequence", SEQUENCE) == answer
    assert bridge.calls == ["parse"]
    assert [r.__dict__["family"] for r in caplog.records] == ["sequence"]
    assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []


# --- no bridge ---------------------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["shadow", "bridge", "native"])
def test_without_a_bridge_the_mode_is_native(mode: Mode) -> None:
    core = core_with(None, mode)
    assert core.mode == "native"
    assert core.detect(FLOWCHART) == "flowchart"
    assert core.health() is True
    core.close()


def test_without_a_bridge_unported_operations_raise() -> None:
    core = DiagramCore(None)
    for call in (lambda: core.load_library({}),):
        with pytest.raises(BridgeError, match="not ported to Python yet and no bridge"):
            call()


def test_everything_else_is_delegated_to_the_bridge_and_close_and_health_too() -> None:
    bridge = FakeBridge(load_library={"library": "x"}, health=False)
    core = core_with(bridge, "shadow")
    assert core.load_library({}) == {"library": "x"}
    assert core.health() is False
    core.close()
    assert bridge.closed


# --- standards (canvas-1bty.15.3) --------------------------------------------------------------------------------

RULES: dict[str, Any] = {
    "allowedShapeIds": ["rectangle"],
    "mandatoryShapeIds": [],
    "allowedIconLibraryRefs": [],
    "colorPalette": [],
}
BAD_KIND_RULES: dict[str, Any] = {
    **RULES,
    "elementKinds": [{"id": "End", "label": "x", "shapes": [], "approvedFills": []}],
}


def test_validate_and_check_standard_answer_natively_without_a_bridge() -> None:
    core = DiagramCore(None)
    model = core.parse("flowchart", "flowchart TD\n  A((Start)) --> B\n")["model"]
    [violation] = core.validate(model, RULES)
    assert (violation["elementId"], violation["rule"], violation["severity"]) == ("A", "allowed-shapes", "warning")
    assert core.check_standard(RULES, "flowchart") == []
    [issue] = core.check_standard(BAD_KIND_RULES, "flowchart")
    assert issue["path"] == "elementKinds[0].id"


def test_shadow_mode_compares_validate_and_logs_a_mismatch(caplog: pytest.LogCaptureFixture) -> None:
    model = DiagramCore(None).parse("flowchart", FLOWCHART)["model"]
    bridge = FakeBridge(validate=[{"elementId": "A", "rule": "made-up"}], check_standard=[])
    core = core_with(bridge, "shadow")
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        assert core.validate(model, RULES) == [{"elementId": "A", "rule": "made-up"}]
        assert core.check_standard(RULES, "flowchart") == []
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert [(r.__dict__["op"], r.__dict__["family"]) for r in warnings] == [("validate", "flowchart")]
    assert [r.__dict__["op"] for r in caplog.records if r.levelno == logging.DEBUG] == ["check-standard"]
    for record in caplog.records:
        assert SECRET not in repr(record.__dict__)


def test_a_standard_missing_a_field_is_a_bridge_error_natively_as_in_typescript() -> None:
    core = DiagramCore(None)
    with pytest.raises(BridgeError, match="diagram-core validate: KeyError"):
        core.validate({"nodes": [], "edges": [], "containers": []}, {"elementKinds": []})


def test_shadow_mode_never_fails_a_request_on_an_unexpected_native_error(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*_args: Any) -> Any:
        raise ValueError(f"could not handle {SECRET}")

    monkeypatch.setattr("canvas_api.diagram_core.core.validate", boom)
    core = core_with(FakeBridge(validate=[]), "shadow")
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        assert core.validate({"diagramTypeId": "flowchart", "nodes": []}, RULES) == []
    [record] = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert (record.__dict__["native"], record.__dict__["detail"]) == ("error", "ValueError")
    assert SECRET not in repr(record.__dict__)
    # native mode lets it through (a bug in the port should be loud there)
    with pytest.raises(ValueError):
        core_with(FakeBridge(), "native").validate({"nodes": []}, RULES)


# --- rendering (canvas-1bty.15.4) ---------------------------------------------------------------------------------


def test_render_svg_answers_natively_without_a_bridge() -> None:
    core = DiagramCore(None)
    model = core.parse("flowchart", FLOWCHART)["model"]
    svg = core.render_svg(model, background="#ffffff")
    assert svg.startswith('<svg xmlns="http://www.w3.org/2000/svg"')
    assert '<rect width="100%" height="100%" fill="#ffffff" />' in svg


def test_shadow_mode_compares_render_svg(caplog: pytest.LogCaptureFixture) -> None:
    model = DiagramCore(None).parse("flowchart", FLOWCHART)["model"]
    native = DiagramCore(None).render_svg(model)
    agreeing = core_with(FakeBridge(render_svg=native), "shadow")
    differing = core_with(FakeBridge(render_svg="<svg/>"), "shadow")
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        assert agreeing.render_svg(model) == native
        assert differing.render_svg(model) == "<svg/>"
    assert [(r.levelno, r.__dict__["op"]) for r in caplog.records] == [
        (logging.DEBUG, "render-svg"),
        (logging.WARNING, "render-svg"),
    ]
    for record in caplog.records:
        assert SECRET not in repr(record.__dict__)


# --- templates (canvas-1bty.15.5) ------------------------------------------------------------------------------

TEMPLATE = "# T\n## 3. Services\n| Service |\n|---|\n| Web |\n## 5. Connections\n| From | To |\n|---|---|\n"


def test_compile_template_answers_natively_without_a_bridge() -> None:
    core = DiagramCore(None)
    assert core.compile_template("network", TEMPLATE) == {"dsl": "architecture-beta\n    service web(server)[Web]\n"}
    assert core.compile_template("flowchart", TEMPLATE) == {"unsupported": True}


def test_shadow_mode_compares_compile_template(caplog: pytest.LogCaptureFixture) -> None:
    native = DiagramCore(None).compile_template("network", TEMPLATE)
    agreeing = core_with(FakeBridge(compile_template=native), "shadow")
    differing = core_with(FakeBridge(compile_template={"dsl": "other"}), "shadow")
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        assert agreeing.compile_template("network", TEMPLATE) == native
        assert differing.compile_template("network", TEMPLATE) == {"dsl": "other"}
    assert [(r.levelno, r.__dict__["op"], r.__dict__["family"]) for r in caplog.records] == [
        (logging.DEBUG, "compile-template", "network"),
        (logging.WARNING, "compile-template", "network"),
    ]
