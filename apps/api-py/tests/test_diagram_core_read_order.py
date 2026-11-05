"""canvas-ra0g: in_read_order puts nodes and containers in the order reading their written text back gives."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from canvas_api.diagram_core.c4 import parse_c4, serialize_c4
from canvas_api.diagram_core.read_order import in_read_order


def _node(id_: str, **extra: Any) -> dict[str, Any]:
    return {"id": id_, "label": id_, "shape": "rectangle", **extra}


def _model(nodes: list[str], containers: list[str] | None = None) -> dict[str, Any]:
    return {
        "diagramTypeId": "flowchart",
        "nodes": [_node(n) for n in nodes],
        "edges": [{"id": "e1", "sourceId": nodes[0], "targetId": nodes[1]}],
        "containers": [{"id": c, "label": c} for c in containers or []],
        "standardVersionId": "sv-1",
    }


def _reads_back(node_ids: list[str], container_ids: list[str] | None = None) -> Callable[[str], dict[str, Any]]:
    model = _model(["x", "y"])
    model["nodes"] = [_node(n) for n in node_ids]
    model["containers"] = [{"id": c, "label": c} for c in container_ids or []]
    return lambda _dsl: {"model": model}


def _write(_model: dict[str, Any]) -> str:
    return "text"


def _ids(items: list[dict[str, Any]]) -> list[str]:
    return [i["id"] for i in items]


def test_sorts_nodes_and_containers_into_the_parsed_order() -> None:
    out = in_read_order(_model(["a", "b", "c"], ["g1", "g2"]), _reads_back(["c", "a", "b"], ["g2", "g1"]), _write)
    assert _ids(out["nodes"]) == ["c", "a", "b"]
    assert _ids(out["containers"]) == ["g2", "g1"]


def test_uses_the_first_place_an_id_comes() -> None:
    out = in_read_order(_model(["a", "b", "c"]), _reads_back(["b", "c", "b", "a"]), _write)
    assert _ids(out["nodes"]) == ["b", "c", "a"]


def test_items_the_parse_lacks_go_last_in_their_own_order() -> None:
    out = in_read_order(_model(["a", "x1", "b", "x2"]), _reads_back(["b", "a"]), _write)
    assert _ids(out["nodes"]) == ["b", "a", "x1", "x2"]


def test_items_sharing_an_id_keep_their_order() -> None:
    m = _model(["a", "b"])
    m["nodes"] = [_node("a", label="first"), _node("b"), _node("a", label="second")]
    out = in_read_order(m, _reads_back(["b", "a"]), _write)
    assert [n["label"] for n in out["nodes"]] == ["b", "first", "second"]


def test_text_that_does_not_read_back_leaves_the_model_as_it_is() -> None:
    m = _model(["a", "b"])
    out = in_read_order(m, lambda _dsl: {"errors": [{"line": 1, "content": "", "message": "bad"}]}, _write)
    assert out is m


def test_other_fields_stay_and_the_original_model_is_written() -> None:
    m = _model(["a", "b"])
    written: list[dict[str, Any]] = []

    def write(model: dict[str, Any]) -> str:
        written.append(model)
        return "text"

    out = in_read_order(m, _reads_back(["b", "a"]), write)
    assert len(written) == 1 and written[0] is m
    assert out["edges"] is m["edges"]
    assert out["standardVersionId"] == "sv-1"
    assert out["diagramTypeId"] == "flowchart"
    assert _ids(m["nodes"]) == ["a", "b"]  # input not mutated


_DSL = """C4Container
    Person(u, "User")
    System_Boundary(b, "Shop") {
      Container(web, "Web")
      Container(api, "API")
    }
    ContainerDb(db, "DB")
    Rel(u, web, "uses")
    Rel(web, api, "calls")
    Rel(api, db, "reads")
"""


def test_a_model_in_a_different_order_from_its_grouped_text_saves_the_same_text_twice() -> None:
    parsed = parse_c4(_DSL)
    assert "model" in parsed
    model = {
        **parsed["model"],
        "nodes": list(reversed(parsed["model"]["nodes"])),
        "containers": list(reversed(parsed["model"]["containers"])),
    }
    first = serialize_c4(model)
    reparsed = parse_c4(first)
    assert "model" in reparsed
    assert serialize_c4(reparsed["model"]) == first
