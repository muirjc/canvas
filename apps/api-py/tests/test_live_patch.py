"""canvas-vvi: live co-editing's change format against diagram-core's TypeScript (src/live/model-patch.ts).

tests/data/live_patch_vectors.json (see make_live_patch_vectors.ts there) holds seeded random edits to corpus
diagrams as the patches TypeScript's diffModels made of them. Python applies each patch and must produce the
same JSON text, key order included: the live hub and every browser have to end on the same model.
"""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from canvas_api.diagram_core.live_patch import MAX_ITEMS, apply_patch, patch_problem

DATA: dict[str, Any] = json.loads((Path(__file__).parent / "data" / "live_patch_vectors.json").read_text("utf-8"))


def _stringify(model: Any) -> str:
    return json.dumps(model, separators=(",", ":"), ensure_ascii=False)


def _digest(model: Any) -> str:
    return hashlib.sha256(_stringify(model).encode("utf-8")).hexdigest()[:16]


@pytest.mark.parametrize("case", DATA["cases"], ids=lambda case: case["name"])
def test_every_patch_matches_typescript(case: dict[str, Any]) -> None:
    model = case["start"]
    for index, step in enumerate(case["steps"]):
        assert patch_problem(step["patch"]) is None, index
        before = copy.deepcopy(model)
        model = apply_patch(model, step["patch"])
        assert _digest(model) == step["digest"], index
        assert before == copy.deepcopy(before)
    assert _stringify(model) == _stringify(case["end"])


def test_the_vectors_reach_every_part_of_a_patch() -> None:
    seen: set[str] = set()
    for case in DATA["cases"]:
        for step in case["steps"]:
            patch = step["patch"]
            seen.update(f"top.{key}" for key in patch if key in ("set", "unset"))
            for collection in ("nodes", "edges", "containers"):
                seen.update(f"{collection}.{key}" for key in patch.get(collection, {}))
    expected = {"top.set", "top.unset"} | {
        f"{collection}.{key}"
        for collection in ("nodes", "edges", "containers")
        for key in ("added", "removed", "changed", "order")
    }
    assert expected <= seen


def test_the_input_model_is_left_alone() -> None:
    model = {"diagramTypeId": "flowchart", "nodes": [{"id": "a", "label": "A"}], "edges": [], "containers": []}
    before = copy.deepcopy(model)
    apply_patch(model, {"set": {"title": "T"}, "nodes": {"changed": [{"id": "a", "set": {"label": "B"}}]}})
    assert model == before


def test_a_change_to_a_removed_element_is_dropped() -> None:
    model = {"diagramTypeId": "flowchart", "nodes": [{"id": "a"}], "edges": [], "containers": []}
    assert apply_patch(model, {"nodes": {"changed": [{"id": "gone", "set": {"label": "x"}}]}}) == model


@pytest.mark.parametrize(
    "patch",
    [
        None,
        [],
        {"nodes": []},
        {"extra": {}},
        {"set": {"diagramTypeId": "erd"}},
        {"set": {"nodes": []}},
        {"unset": ["edges"]},
        {"unset": "title"},
        {"nodes": {"added": [{"label": "no id"}]}},
        {"nodes": {"added": [{"id": ""}]}},
        {"nodes": {"added": [{"id": 3}]}},
        {"nodes": {"added": ["a"]}},
        {"nodes": {"removed": [1]}},
        {"nodes": {"order": "a"}},
        {"nodes": {"changed": [{"id": "a", "set": {"id": "b"}}]}},
        {"nodes": {"changed": [{"id": "a", "unset": ["id"]}]}},
        {"nodes": {"changed": [{"id": "a", "other": 1}]}},
        {"nodes": {"changed": [{"id": "a", "set": []}]}},
        {"nodes": {"moved": []}},
        {"nodes": {"removed": ["x"] * (MAX_ITEMS + 1)}},
        {"nodes": {"added": [{"id": "x" * 201}]}},
    ],
)
def test_a_malformed_patch_is_refused(patch: Any) -> None:
    assert patch_problem(patch) is not None


def test_a_well_formed_patch_passes() -> None:
    patch = {
        "set": {"title": "T", "legend": {"visible": True}},
        "unset": ["direction"],
        "nodes": {
            "added": [{"id": "n1", "label": "New"}],
            "removed": ["n2"],
            "changed": [{"id": "n3", "set": {"position": {"x": 1, "y": 2}}, "unset": ["style"]}],
            "order": ["n3", "n1"],
        },
    }
    assert patch_problem(patch) is None
