"""canvas-p2g8.2: the layout edits behind the AI chat's layout tools (canvas_api/diagram_core/layout_ops.py)."""

from __future__ import annotations

from typing import Any

import pytest

from canvas_api.diagram_core.layout_ops import (
    align_elements,
    bounds_of,
    distribute_elements,
    move_element,
    place_relative,
)


def node(node_id: str, x: float, y: float, width: float = 100, height: float = 50, **extra: Any) -> dict[str, Any]:
    return {
        "id": node_id,
        "label": node_id,
        "shape": "rectangle",
        "position": {"x": x, "y": y},
        "size": {"width": width, "height": height},
        **extra,
    }


def model(*nodes: dict[str, Any], containers: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"diagramTypeId": "flowchart", "nodes": list(nodes), "edges": [], "containers": containers or []}


def positions(m: dict[str, Any]) -> dict[str, tuple[float, float]]:
    return {n["id"]: (n["position"]["x"], n["position"]["y"]) for n in m["nodes"]} | {
        c["id"]: (c["position"]["x"], c["position"]["y"]) for c in m["containers"]
    }


def test_bounds_use_the_drawn_size() -> None:
    m = model(node("a", 10, 20, 80, 40), node("b", 0, 0, **{"size": None}))
    assert bounds_of(m, "a") == {"x": 10, "y": 20, "width": 80, "height": 40}
    b = bounds_of(m, "b")
    assert b is not None and b["width"] > 0 and b["height"] > 0
    assert bounds_of(m, "nope") is None


def test_moving_a_group_takes_its_contents_along_and_leaves_the_input_alone() -> None:
    group = {"id": "g", "label": "G", "position": {"x": 0, "y": 0}, "size": {"width": 300, "height": 200}}
    m = model(node("a", 20, 30, containerId="g"), node("b", 500, 500), containers=[group])
    moved = move_element(m, "g", 100, 50)
    assert positions(moved) == {"a": (120, 80), "b": (500, 500), "g": (100, 50)}
    assert positions(m) == {"a": (20, 30), "b": (500, 500), "g": (0, 0)}
    assert move_element(m, "nope", 1, 1) is m


@pytest.mark.parametrize(
    ("alignment", "expected"),
    [
        ("left", {"a": (0, 0), "b": (0, 100), "c": (0, 300)}),
        ("right", {"a": (250, 0), "b": (150, 100), "c": (200, 300)}),
        ("center", {"a": (125, 0), "b": (75, 100), "c": (100, 300)}),
        ("top", {"a": (0, 0), "b": (50, 0), "c": (200, 0)}),
        ("bottom", {"a": (0, 300), "b": (50, 250), "c": (200, 300)}),
        ("middle", {"a": (0, 150), "b": (50, 125), "c": (200, 150)}),
    ],
)
def test_align_moves_every_element_to_the_outermost_edge_or_the_overall_centre(
    alignment: Any, expected: dict[str, tuple[float, float]]
) -> None:
    # a: 100x50 at (0,0); b: 200x100 at (50,100); c: 150x50 at (200,300). Span x 0..350, y 0..350.
    m = model(node("a", 0, 0), node("b", 50, 100, 200, 100), node("c", 200, 300, 150, 50))
    assert positions(align_elements(m, ["a", "b", "c"], alignment)) == expected


def test_align_needs_two_elements_it_knows() -> None:
    m = model(node("a", 0, 0), node("b", 50, 100))
    assert align_elements(m, ["a", "nope"], "left") is m


def test_distribute_keeps_the_ends_and_makes_the_gaps_equal_whatever_the_order_given() -> None:
    m = model(node("a", 0, 0), node("b", 120, 7, 50), node("c", 400, 9, 100))
    spread = distribute_elements(m, ["c", "a", "b"], "horizontal")
    # Span 0..500, widths 100+50+100 = 250, so two gaps of 125: b at 225; y untouched.
    assert positions(spread) == {"a": (0, 0), "b": (225, 7), "c": (400, 9)}
    down = distribute_elements(model(node("a", 0, 0), node("b", 3, 10), node("c", 5, 300)), ["a", "b", "c"], "vertical")
    assert positions(down) == {"a": (0, 0), "b": (3, 150), "c": (5, 300)}
    assert distribute_elements(m, ["a", "b"], "horizontal") is m


@pytest.mark.parametrize(
    ("side", "expected"),
    [("below", (25, 210)), ("above", (25, -60)), ("right", (210, 75)), ("left", (-160, 75))],
)
def test_place_relative_puts_the_element_beside_the_anchor_centred_on_it(
    side: Any, expected: tuple[float, float]
) -> None:
    # anchor 150x100 at (0,50); the element is 100x50.
    m = model(node("anchor", 0, 50, 150, 100), node("e", 999, 999))
    assert positions(place_relative(m, "e", side, "anchor", 60))["e"] == expected


def test_place_relative_with_an_unknown_element_or_anchor_changes_nothing() -> None:
    m = model(node("a", 0, 0))
    assert place_relative(m, "a", "below", "nope") is m
    assert place_relative(m, "nope", "below", "a") is m
