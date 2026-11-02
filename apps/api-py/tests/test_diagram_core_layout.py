"""canvas-1bty.15.1: sizes, containment layout and the JavaScript value helpers against the TypeScript results.

tests/data/layout_vectors.json (see make_layout_vectors.ts there) holds what nodeSize, splitLabelLines and
computeContainmentLayout return in TypeScript for a spread of inputs. No Node needed to run these.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest

from canvas_api.diagram_core.containment_layout import compute_containment_layout
from canvas_api.diagram_core.jsvalues import js_number_value, js_parse_float, js_parse_int, to_js_json
from canvas_api.diagram_core.sizes import node_size, split_label_lines

DATA: dict[str, Any] = json.loads((Path(__file__).parent / "data" / "layout_vectors.json").read_text("utf-8"))


@pytest.mark.parametrize("case", DATA["sizes"], ids=lambda c: c[0]["id"])
def test_node_size_matches_typescript(case: list[Any]) -> None:
    node, expected = case
    assert node_size(node) == expected


@pytest.mark.parametrize("case", DATA["lines"], ids=lambda c: f"{c[0][:12]!r}-{c[1]}-{c[2]}")
def test_split_label_lines_matches_typescript(case: list[Any]) -> None:
    label, max_width, font_size, expected = case
    assert split_label_lines(label, max_width, font_size) == expected


@pytest.mark.parametrize("case", DATA["layouts"], ids=[f"layout-{i}" for i in range(len(DATA["layouts"]))])
def test_containment_layout_matches_typescript(case: dict[str, Any]) -> None:
    node_positions, container_positions, container_sizes = compute_containment_layout(case["nodes"], case["containers"])
    assert node_positions == case["nodePositions"]
    assert container_positions == case["containerPositions"]
    assert container_sizes == case["containerSizes"]


def test_a_group_encloses_its_children_at_every_depth() -> None:
    nodes = [{"id": "n", "label": "N", "shape": "rectangle", "containerId": "c"}]
    containers = [{"id": "a", "label": "A"}, {"id": "b", "label": "B", "parentContainerId": "a"}]
    containers.append({"id": "c", "label": "C", "parentContainerId": "b"})
    node_positions, container_positions, sizes = compute_containment_layout(nodes, containers)
    for outer, inner in (("a", "b"), ("b", "c")):
        assert container_positions[outer]["x"] < container_positions[inner]["x"]
        assert container_positions[outer]["y"] < container_positions[inner]["y"]
        assert (
            container_positions[outer]["x"] + sizes[outer]["width"]
            > container_positions[inner]["x"] + sizes[inner]["width"]
        )
        assert (
            container_positions[outer]["y"] + sizes[outer]["height"]
            > container_positions[inner]["y"] + sizes[inner]["height"]
        )
    assert container_positions["c"]["x"] < node_positions["n"]["x"]


# --- JavaScript value helpers -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("12px", 12.0),
        ("  3.5em", 3.5),
        (".5", 0.5),
        ("-2e2x", -200.0),
        ("1e", 1.0),
        ("+7", 7.0),
        ("Infinity", math.inf),
    ],
)
def test_parse_float(text: str, expected: float) -> None:
    assert js_parse_float(text) == expected


@pytest.mark.parametrize("text", ["", "thick", "px2", ".", "-", "e5", "x1F"])
def test_parse_float_without_a_number_is_nan(text: str) -> None:
    assert math.isnan(js_parse_float(text))


def test_parse_int() -> None:
    assert js_parse_int("  42abc") == 42.0
    assert js_parse_int("-3.9") == -3.0
    assert math.isnan(js_parse_int("abc"))
    assert math.isnan(js_parse_int(""))


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, 0.0),
        (True, 1.0),
        (False, 0.0),
        (2.5, 2.5),
        ("", 0.0),
        ("  \n ", 0.0),
        (" 12 ", 12.0),
        ("0x1F", 31.0),
        ("0b101", 5.0),
        ("0o17", 15.0),
        ("1e3", 1000.0),
        ("-Infinity", -math.inf),
        ([], 0.0),
        (["7"], 7.0),
    ],
)
def test_number_value(value: Any, expected: float) -> None:
    assert js_number_value(value) == expected


@pytest.mark.parametrize("value", ["12px", "abc", "1,5", {}, [1, 2], "0xZZ", "--1", "1.2.3"])
def test_number_value_nan(value: Any) -> None:
    assert math.isnan(js_number_value(value))


def test_to_js_json() -> None:
    value = {
        "a": 40.0,
        "b": 1.5,
        "c": math.nan,
        "d": None,
        "e": [1.0, None, (2.0,)],
        "f": {"g": math.inf, "h": 2**60 + 0.0},
    }
    assert to_js_json(value) == {"a": 40, "b": 1.5, "c": None, "e": [1, None, [2]], "f": {"g": None, "h": 2.0**60}}
    assert to_js_json(True) is True
    assert to_js_json(0.0) == 0
