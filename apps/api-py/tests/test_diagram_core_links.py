"""canvas-8uh1.1: drill-down links (`diagramRef`, front matter `canvas.links`) answered natively, against the
TypeScript bridge.

The golden corpus's `<family>-diagram-links` cases pin reading and writing. Here: a seeded fuzz that links random
elements of every corpus diagram (and renames some, which moves a Wardley map's link with the name) and compares
the saved text and what it reads back to, with TypeScript's (skips without Node).
"""

# ruff: noqa: S311 - a seeded generator, not cryptography
from __future__ import annotations

import json
import random
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from canvas_api.diagram_core import DiagramCore, canonical_json, diagram_ops
from canvas_api.diagram_core.core import PARSERS, SERIALIZERS
from canvas_api.diagram_core.detect import detect_dsl_family
from canvas_api.diagram_core.jsvalues import to_js_json
from tests.diagram_bridge import DiagramBridge

CASES = Path(__file__).resolve().parents[3] / "packages" / "diagram-core" / "corpus" / "cases"
TARGETS = ["7b0c2f9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", "other_diagram", "d-1"]
core = DiagramCore()


def _corpus() -> Iterator[tuple[str, str, dict[str, Any]]]:
    for case in sorted(CASES.iterdir()):
        text = (case / "input.mmd").read_text("utf-8")
        family = detect_dsl_family(text)
        if family is None:
            continue
        parsed = PARSERS[family](text)
        if "model" in parsed:
            yield case.name, family, json.loads(json.dumps(to_js_json(parsed["model"])))


def _strip_none(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _strip_none(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_strip_none(v) for v in value]
    return value


@pytest.fixture(scope="module")
def bridge(bridge_url: str | None) -> Iterator[DiagramBridge]:
    if bridge_url is None:
        pytest.skip("needs node and packages/diagram-bridge/dist/bridge.mjs")
    with DiagramBridge(bridge_url) as client:
        yield client


def _linked(model: dict[str, Any], rnd: random.Random) -> dict[str, Any]:
    elements = [e["id"] for e in [*model["nodes"], *model["containers"]]]
    for element_id in rnd.sample(elements, min(len(elements), rnd.randint(1, 4))):
        model = diagram_ops.set_diagram_link(model, element_id, rnd.choice(TARGETS))
    for node in model["nodes"]:
        if rnd.random() < 0.2:
            model = diagram_ops.update_node_label(model, node["id"], rnd.choice(["Renamed", "Kettle", "a b"]))
    return model


@pytest.mark.parametrize("seed", [3, 11])
def test_links_save_and_read_back_as_typescript_does(bridge: DiagramBridge, seed: int) -> None:
    rnd = random.Random(seed)
    failures: list[str] = []
    linked_count = 0
    for name, family, model in _corpus():
        edited = _strip_none(_linked(model, rnd))
        text = SERIALIZERS[family](edited)
        if text != bridge.serialize(family, edited):
            failures.append(f"{name}: serialize")
            continue
        if "links:" in text:
            linked_count += 1
        reference = bridge.detect_and_parse(text, family)
        reread = PARSERS[family](text)
        if canonical_json(to_js_json(reread)) != canonical_json({k: v for k, v in reference.items() if k != "family"}):
            failures.append(f"{name}: parse")
    assert not failures, failures[:5]
    assert linked_count > 50, linked_count


def test_a_portable_export_leaves_the_links_out() -> None:
    text = "---\ncanvas:\n  links:\n    A: d-1\n---\nflowchart TD\n  A --> B\n"
    assert "links" not in core.portable(text, strip_front_matter=True)


BASE = "https://canvas.example.com/?a=1&diagramId="


@pytest.mark.parametrize("seed", [5, 17])
def test_exports_link_as_typescript_does(bridge: DiagramBridge, seed: int) -> None:
    """canvas-8uh1.4: the SVG wraps linked elements in `<a href>`; flowchart and state exports get click lines."""
    rnd = random.Random(seed)
    failures: list[str] = []
    anchors = clicks = 0
    for name, family, model in _corpus():
        edited = _strip_none(_linked(model, rnd))
        svg = core.render_svg(edited, diagram_link_base=BASE)
        if svg != bridge.render_svg(edited, diagram_link_base=BASE):
            failures.append(f"{name}: svg")
        anchors += svg.count('<a href="https://canvas.example.com/')
        text = SERIALIZERS[family](edited)
        for strip in (True, False):
            portable = core.portable(text, strip_front_matter=strip, diagram_link_base=BASE)
            if portable != bridge.portable(text, strip_front_matter=strip, diagram_link_base=BASE):
                failures.append(f"{name}: portable strip={strip}")
            clicks += portable.count('href "https://canvas.example.com/')
    assert not failures, failures[:5]
    assert anchors > 50 and clicks > 10, (anchors, clicks)


def test_an_svg_links_only_with_a_base_and_never_over_a_shapes_own_link() -> None:
    target = "11111111-2222-4333-8444-555555555555"
    text = f'---\ncanvas:\n  links:\n    A: {target}\n    B: {target}\n---\nflowchart TD\n  A --> B\n  click B href "https://example.com/own"\n'
    model = core.parse("flowchart", text)["model"]
    assert "<a " not in core.render_svg(model).replace('<a href="https://example.com/own">', "")
    svg = core.render_svg(model, diagram_link_base=BASE)
    assert svg.count(f'href="https://canvas.example.com/?a=1&amp;diagramId={target}"') == 1
    assert 'href="https://example.com/own"' in svg
    assert "<a " not in core.render_svg(model, diagram_link_base="javascript:alert(1)//").replace(
        '<a href="https://example.com/own">', ""
    )
