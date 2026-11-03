"""canvas-1bty.15.4: parity fuzz for the SVG renderer. Seeded random models (every shape, container role, edge
style, UML relationship, ER cardinality, anchor, link, icon, legend and colour the renderer branches on) and every
parsed corpus model with a legend and icons switched on, drawn by the native Python renderer and the TypeScript one
(the bridge). The SVG must be identical, byte for byte.

Needs Node and the bridge bundle (skips without, like the other bridge tests). A failure shows the seed and index.
Values TypeScript would throw on (a missing label, a non-string colour) are not generated.
"""

# ruff: noqa: S311 - a seeded generator, not cryptography
from __future__ import annotations

import json
import random
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from canvas_api.diagram_core.svg_render import contrast_text_color, js_hypot, render_to_svg
from tests.diagram_bridge import DiagramBridge

CORPUS = Path(__file__).resolve().parents[3] / "packages" / "diagram-core" / "corpus"
CORPUS_MODELS = [json.loads(p.read_text("utf-8")) for p in sorted((CORPUS / "cases").glob("*/expected/model.json"))]
STANDARDS = [json.loads(p.read_text("utf-8")) for p in sorted((CORPUS / "standards").glob("*.json"))]

SHAPES = [
    "rectangle",
    "rounded-rectangle",
    "circle",
    "diamond",
    "cylinder",
    "stadium",
    "subroutine",
    "double-circle",
    "hexagon",
    "parallelogram",
    "parallelogram-alt",
    "trapezoid",
    "trapezoid-alt",
    "asymmetric",
    "person",
    "icon",
    "mystery",
]
ROLES = ["system", "person", "container", "component", "participant", "actor", "junction", "x"]
CONTAINER_ROLES = [
    None,
    "note",
    "note-left",
    "box",
    "namespace",
    "boundary",
    "system-boundary",
    "deployment-node",
    "loop",
    "group",
]
COLORS = ["#fff", "#FFFFFF", "#1168bd", "#85bbf0", "#000", "#abcd", "#12345678", "red", "", "#zzzzzz", "# f", "#-f0"]
LABELS = [
    "A",
    "Payment Service",
    "",
    "  ",
    "Système <b>&</b> 'q' \"dq\"",
    "Line one<br/>Line two",
    "A really quite long label that will have to wrap over several lines",
    "emoji 😀 width",
    "multi\nline",
]
UML_KINDS = [
    "inheritance",
    "realization",
    "composition",
    "aggregation",
    "association",
    "dependency",
    "link-dashed",
    "link-solid",
    "lollipop-source",
    "lollipop-target",
    "other",
]
ER_TOKENS = ["||", "|o", "o|", "}o", "o{", "}|", "|{", "x|"]
NUMBERS = [0, 1, 10, 40, 120, 0.1, 0.3, 12.5, -15, 1e-7, 123456.789, 7 / 3]
ICONS = {"lib@1@db": "<rect width='48' height='48'/>", "lib@1@q": "<circle r='4'/>", "undefined@1@x": "<g/>"}


def _maybe(rnd: random.Random, p: float = 0.5) -> bool:
    return rnd.random() < p


def _point(rnd: random.Random) -> dict[str, Any]:
    return {"x": rnd.choice(NUMBERS) * rnd.choice([1, 3, 7]), "y": rnd.choice(NUMBERS) * rnd.choice([1, 2, 5])}


def _size(rnd: random.Random) -> dict[str, Any]:
    return {"width": rnd.choice([0, 8, 30, 140, 200.5, 1 / 3]), "height": rnd.choice([0, 6, 22, 60, 99.9])}


def _style(rnd: random.Random) -> dict[str, Any]:
    style: dict[str, Any] = {}
    for key, pool in (
        ("fillColor", COLORS),
        ("strokeColor", COLORS),
        ("strokeWidth", [0, 1, 2.5, 4]),
        ("strokeDasharray", ["", "5,5", "2 1"]),
        ("fontSize", [8, 11, 14, 20, 13.5]),
    ):
        if _maybe(rnd, 0.4):
            style[key] = rnd.choice(pool)
    return style


def random_node(rnd: random.Random, node_id: str, container_ids: list[str]) -> dict[str, Any]:
    node: dict[str, Any] = {"id": node_id, "label": rnd.choice(LABELS), "shape": rnd.choice(SHAPES)}
    node["position"] = _point(rnd)
    if _maybe(rnd, 0.3):
        node["size"] = _size(rnd)
    if _maybe(rnd, 0.5):
        node["role"] = rnd.choice(ROLES)
    if _maybe(rnd, 0.3):
        node["external"] = rnd.choice([True, False])
    if _maybe(rnd, 0.4):
        node["style"] = _style(rnd)
    if _maybe(rnd, 0.3):
        node["icon"] = {"libraryId": "lib", "libraryVersion": "1", "iconId": rnd.choice(["db", "q", "missing"])}
        if _maybe(rnd, 0.1):
            del node["icon"]["libraryId"]
            node["icon"]["iconId"] = "x"
    if _maybe(rnd, 0.25):
        node["technology"] = rnd.choice(["Java", "", "Spring <MVC>"])
    if _maybe(rnd, 0.25):
        node["description"] = rnd.choice(["Handles payments for the whole of the shop front", "", "x"])
    if _maybe(rnd, 0.2):
        node["c4TypeLabel"] = rnd.choice(["Software System", "Container", ""])
    if _maybe(rnd, 0.15):
        node["attributes"] = [
            {"type": "string", "name": "id", "keys": rnd.choice([[], ["PK"], ["PK", "FK"]])}
            | ({"comment": "the id"} if _maybe(rnd) else {})
            for _ in range(rnd.randint(0, 3))
        ]
    if _maybe(rnd, 0.15):
        node["members"] = [
            {"kind": rnd.choice(["attribute", "method"]), "name": "go", "visibility": rnd.choice(["+", "-", ""])}
            | ({"type": "int"} if _maybe(rnd) else {})
            | ({"returnType": "bool", "params": "a, b"} if _maybe(rnd) else {})
            | ({"isStatic": True} if _maybe(rnd, 0.2) else {})
            | ({"isAbstract": True} if _maybe(rnd, 0.2) else {})
            for _ in range(rnd.randint(0, 3))
        ]
    if _maybe(rnd, 0.15):
        node["umlStereotype"] = rnd.choice(["interface", "enum"])
    if _maybe(rnd, 0.2):
        link: dict[str, Any] = {
            "href": rnd.choice(['https://example.com/a?b=1&c="2"', "javascript:alert(1)", "/relative", "mailto:a@b"])
        }
        if _maybe(rnd):
            link["target"] = rnd.choice(["_blank", "_self"])
        if _maybe(rnd):
            link["tooltip"] = rnd.choice(["Open <it>", ""])
        node["link"] = link
    if container_ids and _maybe(rnd, 0.4):
        node["containerId"] = rnd.choice(container_ids)
    return node


def random_edge(rnd: random.Random, index: int, ids: list[str]) -> dict[str, Any]:
    edge: dict[str, Any] = {
        "id": f"e{index}",
        "sourceId": rnd.choice([*ids, "ghost"]) if _maybe(rnd, 0.95) else "ghost",
        "targetId": rnd.choice(ids),
    }
    if _maybe(rnd):
        edge["label"] = rnd.choice(LABELS)
    if _maybe(rnd, 0.4):
        edge["arrow"] = rnd.choice(["target", "source", "both", "none"])
    if _maybe(rnd, 0.4):
        edge["lineStyle"] = rnd.choice(["solid", "dotted", "thick", "invisible"])
    if _maybe(rnd, 0.3):
        edge["style"] = _style(rnd)
    if _maybe(rnd, 0.2):
        edge["technology"] = rnd.choice(["HTTPS", "JDBC & SQL"])
    if _maybe(rnd, 0.2):
        edge["umlRelationKind"] = rnd.choice(UML_KINDS)
    if _maybe(rnd, 0.2):
        edge["erSourceCardinality"] = rnd.choice(ER_TOKENS)
        edge["erTargetCardinality"] = rnd.choice(ER_TOKENS)
    for key in ("sourceCardinality", "targetCardinality"):
        if _maybe(rnd, 0.15):
            edge[key] = rnd.choice(["1", "0..*", "many"])
    for key in ("sourceAnchor", "targetAnchor"):
        if _maybe(rnd, 0.15):
            edge[key] = rnd.choice(["T", "B", "L", "R"])
    for key in ("sourceIsGroup", "targetIsGroup"):
        if _maybe(rnd, 0.15):
            edge[key] = True
    return edge


def random_model(rnd: random.Random) -> dict[str, Any]:
    container_ids = [f"c{i}" for i in range(rnd.randint(0, 3))]
    containers = []
    for container_id in container_ids:
        container: dict[str, Any] = {"id": container_id, "label": rnd.choice(LABELS), "position": _point(rnd)}
        role = rnd.choice(CONTAINER_ROLES)
        if role is not None:
            container["role"] = role
        if _maybe(rnd, 0.6):
            container["size"] = _size(rnd)
        if _maybe(rnd, 0.3):
            container["style"] = _style(rnd)
        if _maybe(rnd, 0.2):
            container["icon"] = {"libraryId": "lib", "libraryVersion": "1", "iconId": rnd.choice(["db", "nope"])}
        containers.append(container)
    ids = [f"n{i}" for i in range(rnd.randint(0, 6))]
    nodes = [random_node(rnd, node_id, container_ids) for node_id in ids]
    for container in containers:
        if ids and _maybe(rnd, 0.3):
            container["attachedNodeIds"] = [rnd.choice([*ids, "ghost"]) for _ in range(rnd.randint(1, 2))]
    edges = [random_edge(rnd, i, ids) for i in range(rnd.randint(0, 6) if ids else 0)]
    model: dict[str, Any] = {"nodes": nodes, "edges": edges, "containers": containers}
    if _maybe(rnd, 0.9):
        model["diagramTypeId"] = rnd.choice(["flowchart", "c4-context", "c4-container", "architecture", "erd", "uml"])
    if _maybe(rnd, 0.3):
        model["legend"] = random_legend(rnd, ids)
    return model


def random_legend(rnd: random.Random, ids: list[str]) -> dict[str, Any]:
    legend: dict[str, Any] = {"visible": rnd.choice([True, True, False])}
    if _maybe(rnd):
        legend["title"] = rnd.choice(["Key", "  Legend  ", "", "A much longer legend title"])
    if _maybe(rnd, 0.3):
        legend["position"] = _point(rnd)
    if _maybe(rnd, 0.5):
        legend["extras"] = [
            {
                "id": f"x{i}",
                "label": rnd.choice(["Database", "Queue", "Flow &c"]),
                "sample": rnd.choice(
                    [
                        {"kind": "shape", "shape": rnd.choice(SHAPES), "fill": rnd.choice(COLORS)},
                        {"kind": "shape", "shape": "person", "stroke": "#333333"},
                        {"kind": "connector", "lineStyle": rnd.choice(["solid", "dotted", "thick", "invisible"])},
                        {"kind": "connector", "arrow": rnd.choice(["target", "source", "both", "none"])},
                        {"kind": "connector", "stroke": "#ff0000", "lineStyle": "dotted", "arrow": "both"},
                    ]
                ),
            }
            for i in range(rnd.randint(0, 3))
        ]
    return legend


@pytest.fixture(scope="module")
def bridge(bridge_url: str | None) -> Iterator[DiagramBridge]:
    if bridge_url is None:
        pytest.skip("needs node and packages/diagram-bridge/dist/bridge.mjs")
    with DiagramBridge(bridge_url) as client:
        yield client


def _render_both(
    bridge: DiagramBridge, model: dict[str, Any], rules: Any, background: Any
) -> tuple[str | None, str | None]:
    """(native, bridge); an error is "error" on either side, which still has to match."""
    try:
        mine: str | None = render_to_svg(model, ICONS, standard_rules=rules, background=background)
    except (KeyError, TypeError, AttributeError):
        mine = "error"
    try:
        theirs: str | None = bridge.render_svg(model, icons=ICONS, standard_rules=rules, background=background)
    except Exception:
        theirs = "error"
    return mine, theirs


@pytest.mark.parametrize("seed", [1, 7, 42, 2026])
def test_native_render_matches_the_bridge(bridge: DiagramBridge, seed: int) -> None:
    rnd = random.Random(seed)
    failures: list[str] = []
    for index in range(150):
        model = random_model(rnd)
        rules = rnd.choice([None, *STANDARDS])
        background = rnd.choice([None, None, "#ffffff", "#0d1117", "white", "#12345", ""])
        mine, theirs = _render_both(bridge, model, rules, background)
        if mine != theirs:
            failures.append(f"seed={seed} index={index}\nmodel={json.dumps(model)}\nmine={mine}\ntheirs={theirs}")
    assert not failures, "\n\n".join(failures[:2])


@pytest.mark.parametrize("index", range(len(CORPUS_MODELS)))
def test_every_corpus_model_with_a_legend_and_icons(bridge: DiagramBridge, index: int) -> None:
    model = json.loads(json.dumps(CORPUS_MODELS[index]))
    model["legend"] = {"visible": True, "title": "Key"}
    for node in model["nodes"]:
        if node.get("icon"):
            node["icon"] = {"libraryId": "lib", "libraryVersion": "1", "iconId": "db"}
    for rules in STANDARDS:
        mine, theirs = _render_both(bridge, model, rules, "#ffffff")
        assert mine == theirs


@pytest.mark.parametrize(
    ("dx", "dy", "v8"),
    [
        (3, 4, 5),
        (1e-300, 1e-300, 1.4142135623730952e-300),
        (1e300, 1e300, 1.4142135623730952e300),
        (0.1, 0.2, 0.223606797749979),
        (7, -24, 25),
        (1 / 3, 2 / 3, 0.7453559924999299),
        # Python's math.hypot gives a different last bit for these (and for about a third of random inputs).
        (-499.9921736307406, -0.00036846221185683374, 499.9921736308764),
        (-0.00004529553837855139, 0.0017886471686831896, 0.0017892206068105163),
        (-0.000011649792251014053, 0.19416372067954546, 0.19416372102903828),
        (0, 0, 0),
        (0, -5, 5),
    ],
)
def test_hypot_is_v8s(dx: float, dy: float, v8: float) -> None:
    """Math.hypot as Node computes it; edge geometry is printed, so the last bit shows in the SVG."""
    assert js_hypot(dx, dy) == v8


@pytest.mark.parametrize(
    ("fill", "text"),
    [("#ffffff", "#000000"), ("#08427b", "#ffffff"), ("#85bbf0", "#000000"), ("#fff", "#000000"), ("red", "#ffffff")],
)
def test_contrast_text_color(fill: str, text: str) -> None:
    """ "red" reads as hex "rreedd": "rr" is NaN, so the luminance is NaN and the text white, as in TypeScript."""
    assert contrast_text_color(fill) == text


def test_icon_artwork_is_clipped_to_its_box() -> None:
    """canvas-1bty.20: artwork reaching outside the 48x48 icon space can't paint over the rest of the diagram
    (resvg clips the nested svg too: the PNG export draws it only inside the icon's box)."""
    art = '<rect x="-500" y="-500" width="2000" height="2000" fill="red" />'
    clipped = f'<svg x="0" y="0" width="48" height="48" viewBox="0 0 48 48" overflow="hidden">{art}</svg>'
    icon = {"libraryId": "l", "libraryVersion": "1", "iconId": "i"}
    node_model = {
        "diagramTypeId": "flowchart",
        "nodes": [{"id": "A", "label": "A", "shape": "icon", "position": {"x": 0, "y": 0}, "icon": icon}],
        "edges": [],
        "containers": [],
    }
    group = {"id": "g", "label": "G", "position": {"x": 0, "y": 0}, "size": {"width": 300, "height": 200}, "icon": icon}
    group_model = {"diagramTypeId": "architecture", "nodes": [], "edges": [], "containers": [group]}
    for model in (node_model, group_model):
        assert render_to_svg(model, {"l@1@i": art}).count(clipped) == 1
