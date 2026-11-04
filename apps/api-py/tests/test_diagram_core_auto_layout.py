"""canvas-p2g8.2: Auto Layout, answered by the native Python diagram-core (diagram_core/auto_layout.py and its dagre
port, diagram_core/dagre/), held to TypeScript's answer exactly -- the AI chat's arrange tool must leave a diagram
where the editor's Auto Layout button would.

- tests/data/auto_layout_vectors.json (make_auto_layout_vectors.ts there): autoLayout on every corpus case in every
  direction its family offers, plus seeded random models; and dagre.layout on random flat graphs;
- a seeded fuzz: random models through native and through the bridge, whole models compared (skips without Node).

Numbers are compared as the JSON text JavaScript would write.
"""

# ruff: noqa: S311 - a seeded generator, not cryptography
from __future__ import annotations

import copy
import json
import random
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from canvas_api.diagram_core import canonical_json
from canvas_api.diagram_core.auto_layout import (
    auto_layout,
    auto_layout_uses_direction,
    js_round,
    supports_auto_layout,
)
from canvas_api.diagram_core.dagre import Graph, layout
from canvas_api.diagram_core.jsvalues import to_js_json
from tests.diagram_bridge import DiagramBridge

VECTORS: dict[str, Any] = json.loads((Path(__file__).parent / "data" / "auto_layout_vectors.json").read_text("utf-8"))
MODELS: list[dict[str, Any]] = VECTORS["models"]
DAGRE: list[dict[str, Any]] = VECTORS["dagre"]


def _projection(model: dict[str, Any]) -> dict[str, Any]:
    return {
        "direction": model.get("direction"),
        "nodes": [[n["id"], n.get("position")] for n in model["nodes"]],
        "containers": [[c["id"], c.get("position"), c.get("size")] for c in model["containers"]],
    }


def _text(value: Any) -> str:
    return canonical_json(to_js_json(value))


def test_the_vectors_cover_the_corpus_and_every_family() -> None:
    corpus = {v["name"] for v in MODELS if not v["name"].startswith("random-")}
    assert len(corpus) >= 100
    assert {v["family"] for v in MODELS} == {"flowchart", "c4", "erd", "uml", "architecture", "sequence"}
    assert len(DAGRE) >= 300


@pytest.mark.parametrize("vector", MODELS, ids=[f"{v['name']}-{v['direction']}" for v in MODELS])
def test_auto_layout_matches_typescript(vector: dict[str, Any]) -> None:
    model = vector["model"]
    before = json.dumps(model)
    laid = auto_layout(model, vector["direction"], vector["family"])
    assert _text(_projection(laid)) == _text(vector["expected"])
    assert json.dumps(model) == before, "the input model is left as it was"


@pytest.mark.parametrize("vector", DAGRE, ids=[f"dagre-{i}" for i in range(len(DAGRE))])
def test_dagre_matches_typescript(vector: dict[str, Any]) -> None:
    g = Graph()
    g.label = dict(vector["graph"])
    for v, width, height in vector["nodes"]:
        g.set_node(v, {"width": width, "height": height})
    for v, w in vector["edges"]:
        g.set_edge(v, w)
    layout(g)
    actual = [[g.node(v)["x"], g.node(v)["y"]] for v, _, _ in vector["nodes"]]
    assert _text(actual) == _text(vector["expected"])


def test_auto_layout_only_moves_things() -> None:
    """Positions, group sizes and the direction change; nothing else does."""
    vector = next(v for v in MODELS if v["family"] == "flowchart" and v["model"]["containers"] and v["model"]["edges"])
    model = vector["model"]
    laid = auto_layout(model, "LR", "flowchart")
    assert laid["direction"] == "LR"
    assert laid["edges"] == model["edges"]

    def unplaced(node: dict[str, Any]) -> dict[str, Any]:
        return {k: v for k, v in node.items() if k != "position"}

    for before, after in zip(model["nodes"], laid["nodes"], strict=True):
        assert unplaced(after) == unplaced(before)


def test_families_and_directions() -> None:
    assert [f for f in ("flowchart", "c4", "erd", "uml", "architecture", "sequence") if supports_auto_layout(f)] == [
        "flowchart",
        "c4",
        "erd",
        "uml",
        "architecture",
    ]
    assert not supports_auto_layout("constructor")
    assert not auto_layout_uses_direction("architecture")
    assert auto_layout_uses_direction("c4")
    model = {"diagramTypeId": "sequence", "nodes": [], "edges": [], "containers": []}
    assert auto_layout(model, "LR", "sequence") is model
    assert auto_layout({**model, "diagramTypeId": "c4"}, "LR", "c4") == {**model, "diagramTypeId": "c4"}
    assert auto_layout({**model, "diagramTypeId": "erd"}, None, "erd")["direction"] == "TD"


def test_math_round_rounds_halves_up() -> None:
    assert [js_round(x) for x in (0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 0.49999999999999994, 2.4)] == [
        1,
        2,
        3,
        0,
        -1,
        -2,
        0,
        2,
    ]


def test_an_earlier_layout_changes_nothing() -> None:
    """dagre's useDynamic is off: the answer depends on the diagram alone (canvas-p2g8.2)."""

    def node(i: str) -> dict[str, Any]:
        return {"id": i, "label": i, "shape": "rectangle", "position": {"x": 0, "y": 0}}

    def edge(s: str, t: str) -> dict[str, Any]:
        return {"id": s + t, "sourceId": s, "targetId": t}

    x = {"diagramTypeId": "flowchart", "nodes": [node(i) for i in "SAB"], "edges": [], "containers": []}
    x["edges"] = [edge("S", "A"), edge("S", "B"), edge("A", "B")]
    first = _projection(auto_layout(x, "TD"))
    auto_layout({**x, "nodes": [node("B"), node("A")], "edges": [edge("B", "A")]}, "TD")
    assert _projection(auto_layout(x, "TD")) == first
    assert first["nodes"] == [["S", {"x": 40, "y": 40}], ["A", {"x": 93, "y": 160}], ["B", {"x": 40, "y": 280}]]


# --- parity fuzz against the bridge ------------------------------------------------------------------------

ODD_IDS = ["constructor", "__proto__", "toString", "0", "10", "a->b", "a", "b", "x y", "Ünï", "\U0001d4b3", "z"]
SHAPES = ["rectangle", "rounded-rectangle", "diamond", "circle", "cylinder", "icon", "person", "hexagon"]
LABELS = ["A", "", "Two words", "A label long enough to wrap over several lines of text", "a<br/>b"]
SIZES = [{"width": 0, "height": 0}, {"width": 3, "height": 400}, {"width": 2.5, "height": 13.7}, None]
DIRECTIONS = [None, "TD", "LR", "BT", "RL", "TB"]
FAMILIES = ["flowchart", "flowchart", "c4", "erd", "uml", "architecture"]


def _random_model(rnd: random.Random) -> tuple[dict[str, Any], str | None, str]:
    def ident(prefix: str, i: int) -> str:
        return rnd.choice(ODD_IDS) if rnd.random() < 0.25 else f"{prefix}{i}"

    node_ids = list(dict.fromkeys(ident("n", i) for i in range(rnd.randint(0, 18))))
    group_ids = list(dict.fromkeys(ident("g", i) for i in range(rnd.choice([0, 0, rnd.randint(1, 7)]))))
    containers: list[dict[str, Any]] = []
    for gid in group_ids:
        c: dict[str, Any] = {"id": gid, "label": gid}
        if rnd.random() < 0.7:
            c["parentContainerId"] = rnd.choice([*group_ids, "nowhere"])
        if rnd.random() < 0.4:
            c["direction"] = rnd.choice(["TD", "LR", "BT", "RL", "XX"])
        if (size := rnd.choice(SIZES)) is not None:
            c["size"] = size
        containers.append(c)
    nodes: list[dict[str, Any]] = []
    for nid in node_ids:
        n: dict[str, Any] = {"id": nid, "label": rnd.choice(LABELS), "shape": rnd.choice(SHAPES)}
        n["position"] = {"x": rnd.randint(0, 300), "y": rnd.randint(0, 300)}
        if group_ids and rnd.random() < 0.65:
            n["containerId"] = rnd.choice([*group_ids, "nowhere"])
        if rnd.random() < 0.1 and (size := rnd.choice(SIZES)) is not None:
            n["size"] = size
        nodes.append(n)
    ends = [*node_ids, *node_ids, *group_ids, "ghost", ""]
    acyclic = rnd.random() < 0.5
    edges: list[dict[str, Any]] = []
    for i in range(rnd.randint(0, 2 * len(node_ids) + 3)):
        s, t = rnd.choice(ends), rnd.choice(ends)
        if acyclic and s in node_ids and t in node_ids and node_ids.index(s) > node_ids.index(t):
            s, t = t, s
        edges.append({"id": f"e{i}", "sourceId": s, "targetId": t})
    family = rnd.choice(FAMILIES)
    model: dict[str, Any] = {"diagramTypeId": family, "nodes": nodes, "edges": edges, "containers": containers}
    if rnd.random() < 0.3:
        model["direction"] = rnd.choice(["TD", "LR"])
    return model, rnd.choice(DIRECTIONS), family


@pytest.fixture(scope="module")
def bridge(bridge_url: str | None) -> Iterator[DiagramBridge]:
    if bridge_url is None:
        pytest.skip("needs node and packages/diagram-bridge/dist/bridge.mjs")
    with DiagramBridge(bridge_url) as client:
        yield client


@pytest.mark.parametrize("seed", [3, 11, 23, 47])
def test_native_auto_layout_matches_the_bridge(bridge: DiagramBridge, seed: int) -> None:
    rnd = random.Random(seed)
    failures: list[str] = []
    for index in range(150):
        model, direction, family = _random_model(rnd)
        native = _text(auto_layout(copy.deepcopy(model), direction, family))
        if native != _text(bridge.auto_layout(model, direction, family)):
            failures.append(f"seed={seed} index={index} family={family} direction={direction}:\n{json.dumps(model)}")
    assert not failures, "\n\n".join(failures[:2])
