"""canvas-1bty.15.7 (phase 11g-1): diagram_ops / standard_ops against diagram-core's TypeScript.

tests/data/diagram_ops_vectors.json (see make_diagram_ops_vectors.ts there) holds seeded random sequences of
edits TypeScript applied to corpus diagrams and hand-made models: each step's arguments, the ids it generated,
and a hash of JSON.stringify of the model after it (the whole model after a sequence's last edit), or the error
it threw. Python replays every step with the same ids and must produce the same JSON text, key order included.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

from canvas_api.diagram_core import diagram_ops, standard_ops
from canvas_api.diagram_core.jsvalues import to_js_json

DATA: dict[str, Any] = json.loads((Path(__file__).parent / "data" / "diagram_ops_vectors.json").read_text("utf-8"))


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def _op(name: str) -> Callable[..., Any]:
    module = standard_ops if name in {"addElementOfKind", "applyElementKind", "applyConnectorRule"} else diagram_ops
    return getattr(module, _snake(name))


def _stringify(model: Any) -> str:
    """JSON.stringify(model)."""
    return json.dumps(to_js_json(model), separators=(",", ":"), ensure_ascii=False)


def _digest(model: Any) -> str:
    return hashlib.sha256(_stringify(model).encode("utf-8")).hexdigest()[:16]


def _sequences() -> Iterator[Any]:
    for case in DATA["cases"]:
        for index, steps in enumerate(case["sequences"]):
            yield pytest.param(case["model"], steps, id=f"{case['name']}-{index}")


@pytest.mark.parametrize(("start", "steps"), list(_sequences()))
def test_every_edit_matches_typescript(start: Any, steps: list[Any], monkeypatch: pytest.MonkeyPatch) -> None:
    model = start
    for number, step in enumerate(steps):
        where = f"step {number} {step['op']}{json.dumps(step['args'])[:200]}"
        ids = iter(step.get("ids", []))
        monkeypatch.setattr(diagram_ops, "generate_id", lambda _prefix, ids=ids: next(ids))
        if "error" in step:
            with pytest.raises(ValueError, match=re.escape(step["error"])):
                _op(step["op"])(model, *step["args"])
            return
        result = _op(step["op"])(model, *step["args"])
        if step["op"] == "addElementOfKind":
            assert result["nodeId"] == step["nodeId"], where
            result = result["model"]
        if "model" in step:
            assert _stringify(result) == json.dumps(step["model"], separators=(",", ":"), ensure_ascii=False), where
        assert _digest(result) == step["hash"], where
        model = result


def test_the_vectors_reach_every_edit_and_every_error() -> None:
    ops = {step["op"] for case in DATA["cases"] for steps in case["sequences"] for step in steps}
    exported = {name for name in diagram_ops.__all__ + standard_ops.__all__ if name != "generate_id"}
    assert {_snake(op) for op in ops} == exported
    steps = [step for case in DATA["cases"] for sequence in case["sequences"] for step in sequence]
    errors = {step["error"].split(":")[0] for step in steps if "error" in step}
    assert errors == {"setNodeLink", "updateNodeLabel", "updateContainerLabel"}


def test_generated_ids_look_like_typescript_ones() -> None:
    first, second = diagram_ops.generate_id("n"), diagram_ops.generate_id("n")
    assert re.fullmatch(r"n[0-9a-z]{8}[0-9a-z]{6}", first)
    assert first != second


def test_the_input_model_is_never_changed() -> None:
    model = {
        "diagramTypeId": "flowchart",
        "nodes": [{"id": "a", "label": "A", "shape": "rectangle", "position": {"x": 1, "y": 2}, "containerId": "g"}],
        "edges": [{"id": "e", "sourceId": "a", "targetId": "a"}],
        "containers": [{"id": "g", "label": "G", "position": {"x": 0, "y": 0}, "size": {"width": 9, "height": 9}}],
    }
    frozen = json.dumps(model)
    diagram_ops.move_container(model, "g", {"x": 5, "y": 5})
    diagram_ops.update_node_style(model, "a", {"fillColor": "#fff"})
    diagram_ops.remove_container(model, "g")
    diagram_ops.remove_node(model, "a")
    kind = {"id": "k", "label": "K", "shapes": ["circle"], "approvedFills": ["#000"]}
    standard_ops.apply_element_kind(model, "a", kind)
    assert json.dumps(model) == frozen


def test_a_carriage_return_in_a_link_tooltip_is_refused() -> None:
    model = {"diagramTypeId": "flowchart", "nodes": [{"id": "a", "label": "A"}], "edges": [], "containers": []}
    with pytest.raises(ValueError, match="cannot contain a double-quote or a line break"):
        diagram_ops.set_node_link(model, "a", {"href": "https://example.test/", "tooltip": "a\rb"})


def test_a_blank_first_arrow_still_applies_the_line_style() -> None:
    # `arrow !== undefined` starts the patch, but an empty arrow is falsy and isn't written.
    model = {"diagramTypeId": "flowchart", "nodes": [], "edges": [{"id": "e", "arrow": "both"}], "containers": []}
    rule = {"id": "r", "from": "*", "to": "*", "arrows": [""], "lineStyles": ["dotted"]}
    assert standard_ops.apply_connector_rule(model, "e", rule)["edges"] == [
        {"id": "e", "arrow": "both", "lineStyle": "dotted"}
    ]
