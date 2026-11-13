"""canvas-4h1j.2: wardley_ops against diagram-core's TypeScript (model/wardley-ops.ts).

tests/data/wardley_ops_vectors.json (see make_wardley_ops_vectors.ts there) holds seeded random sequences of Wardley
map edits TypeScript applied to the Wardley corpus diagrams and an empty map: each step's arguments, the ids it
generated, and a hash of JSON.stringify of the model after it (the whole model after a sequence's last edit), or the
error it threw. Python replays every step with the same ids and must produce the same JSON text, key order included.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

from canvas_api.diagram_core import diagram_ops, wardley_ops
from canvas_api.diagram_core.jsvalues import to_js_json
from canvas_api.diagram_core.wardley import parse_wardley, serialize_wardley

DATA: dict[str, Any] = json.loads((Path(__file__).parent / "data" / "wardley_ops_vectors.json").read_text("utf-8"))


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def _op(name: str) -> Callable[..., Any]:
    return getattr(diagram_ops if name == "updateNodeLabel" else wardley_ops, _snake(name))


def _stringify(model: Any) -> str:
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
        if "model" in step:
            assert _stringify(result) == json.dumps(step["model"], separators=(",", ":"), ensure_ascii=False), where
        assert _digest(result) == step["hash"], where
        model = result


def test_the_vectors_reach_every_edit() -> None:
    ops = {step["op"] for case in DATA["cases"] for steps in case["sequences"] for step in steps}
    exported = {name for name in wardley_ops.__all__ if not name.isupper() and name != "wardley_name_taken"}
    assert {_snake(op) for op in ops} - {"update_node_label"} == exported


def _map(text: str) -> dict[str, Any]:
    return parse_wardley(text)["model"]


def test_a_moved_component_is_written_where_it_was_put() -> None:
    model = _map("wardley-beta\ncomponent Tea [0.5, 0.5]\ncomponent Kettle [35.0, 50.0]\n")
    moved = wardley_ops.move_wardley_element(model, "Tea", {"visibility": 0.904, "evolution": 1.3})
    text = serialize_wardley(moved)
    assert "component Tea [0.9, 1.0]" in text
    assert "component Kettle [35.0, 50.0]" in text


def test_moving_a_pipeline_parent_moves_its_pipeline() -> None:
    model = _map("wardley-beta\ncomponent Kettle [0.5, 0.4]\npipeline Kettle {\n  component Electric [0.6]\n}\n")
    moved = wardley_ops.move_wardley_element(model, "Kettle", {"visibility": 0.3, "evolution": 0.5})
    text = serialize_wardley(moved)
    assert "component Kettle [0.3, 0.5]" in text
    assert "component Electric [0.7]" in text
    reread = _map(text)
    child = next(n for n in reread["nodes"] if n["label"] == "Electric")
    assert child["wardley"]["visibility"] == 0.3


def test_a_pipeline_component_moves_along_the_evolution_axis_only() -> None:
    model = _map("wardley-beta\ncomponent Kettle [0.5, 0.4]\npipeline Kettle {\n  component Electric [0.6]\n}\n")
    moved = wardley_ops.move_wardley_element(model, "Kettle_Electric", {"visibility": 0.9, "evolution": 0.8})
    child = next(n for n in moved["nodes"] if n["id"] == "Kettle_Electric")
    assert child["wardley"] == {"visibility": 0.5, "evolution": 0.8}


def test_new_components_get_distinct_names() -> None:
    model = _map("wardley-beta\ncomponent New Component [0.5, 0.5]\n")
    added = wardley_ops.add_wardley_element(model, {"kind": "component"})
    assert [n["label"] for n in added["nodes"]] == ["New Component", "New Component 2"]
    assert wardley_ops.wardley_name_taken(added, added["nodes"][1]["id"], "New Component")
    assert not wardley_ops.wardley_name_taken(added, added["nodes"][1]["id"], "Kettle")


def test_removing_a_pipeline_parent_removes_its_pipeline() -> None:
    model = _map(
        "wardley-beta\ncomponent Kettle [0.5, 0.4]\ncomponent Tea [0.9, 0.5]\npipeline Kettle {\n"
        "  component Electric [0.6]\n}\nTea -> Kettle_Electric\n"
    )
    removed = wardley_ops.remove_wardley_element(model, "Kettle")
    assert [n["id"] for n in removed["nodes"]] == ["Tea"]
    assert removed["containers"] == []
    assert removed["edges"] == []


def test_the_markings_are_written_back() -> None:
    model = _map("wardley-beta\ncomponent Tea [0.5, 0.5]\n")
    marked = wardley_ops.set_wardley_markings(model, "Tea", {"strategy": "buy", "inertia": True, "evolve": 0.8})
    text = serialize_wardley(marked)
    assert "component Tea [0.5, 0.5] (buy) (inertia)" in text
    assert "evolve Tea 0.8" in text
    cleared = wardley_ops.set_wardley_markings(marked, "Tea", {"strategy": None, "inertia": False, "evolve": None})
    assert "(buy)" not in serialize_wardley(cleared)
    assert "evolve" not in serialize_wardley(cleared)


def test_a_flow_is_written_as_a_port() -> None:
    model = _map("wardley-beta\ncomponent A [0.5, 0.5]\ncomponent B [0.4, 0.6]\nA -> B\n")
    flowing = wardley_ops.set_wardley_link_flow(model, "e1", "+>")
    assert "A +> B" in serialize_wardley(flowing)
    assert "A -> B" in serialize_wardley(wardley_ops.set_wardley_link_flow(flowing, "e1", None))
