"""canvas-8uh1.6: frames (other diagrams drawn over a diagram, front matter `canvas.frames`) answered natively,
against the TypeScript bridge: a seeded fuzz adds frames to every corpus diagram and compares the saved text, what
it reads back to, the drawing (frame contents of every kind) and the Mermaid export. Plus the frame edits."""

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
TARGETS = ["11111111-2222-4333-8444-555555555555", "d-2", "d-3", "d-4"]
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


def _framed(model: dict[str, Any], rnd: random.Random) -> dict[str, Any]:
    frames = []
    for i in range(rnd.randint(1, 3)):
        frames.append(
            {
                "id": rnd.choice([f"f{i + 1}", f"f{i + 1}", "frame_a", "bad id", "f1"]),
                "diagramId": rnd.choice([*TARGETS, "not a diagram!"]),
                "position": {"x": rnd.choice([0, 40, 512.5, -30, 1200]), "y": rnd.choice([0, 80, 33.25, 900])},
                "size": {"width": rnd.choice([360, 160, 0.5, 0, 1000]), "height": rnd.choice([240, 100, 75.5, -1])},
            }
        )
    return {**model, "frames": frames}


def _contents(rnd: random.Random, inner_svgs: list[str]) -> dict[str, Any]:
    contents: dict[str, Any] = {}
    for target in TARGETS:
        kind = rnd.choice(["available", "available", "unavailable", "deleted", "missing", "absent", "no-svg"])
        name = rnd.choice(
            ["Payments containers", "A very long diagram title that will not fit in a small frame", "<&>"]
        )
        if kind == "available":
            contents[target] = {"name": name, "status": "available", "svg": rnd.choice(inner_svgs)}
        elif kind == "no-svg":
            contents[target] = {"name": name, "status": "available"}
        elif kind != "absent":
            contents[target] = {"status": kind}
    return contents


@pytest.mark.parametrize("seed", [2, 13])
def test_frames_save_read_draw_and_export_as_typescript_does(bridge: DiagramBridge, seed: int) -> None:
    rnd = random.Random(seed)
    corpus = list(_corpus())
    inner_svgs = [core.render_svg(model) for _, _, model in corpus[:6]] + ["<svg>not ours</svg>"]
    failures: list[str] = []
    drawn_frames = 0
    for name, family, model in corpus:
        edited = _strip_none(_framed(model, rnd))
        text = SERIALIZERS[family](edited)
        if text != bridge.serialize(family, edited):
            failures.append(f"{name}: serialize")
            continue
        reference = bridge.detect_and_parse(text, family)
        reread = PARSERS[family](text)
        if canonical_json(to_js_json(reread)) != canonical_json({k: v for k, v in reference.items() if k != "family"}):
            failures.append(f"{name}: parse")
            continue
        read_model = json.loads(json.dumps(to_js_json(reread["model"])))
        contents = _contents(rnd, inner_svgs)
        base = rnd.choice([None, "https://canvas.example.com/?diagramId="])
        svg = core.render_svg(read_model, frame_contents=contents, diagram_link_base=base)
        if svg != bridge.render_svg(read_model, frame_contents=contents, diagram_link_base=base):
            failures.append(f"{name}: svg")
        drawn_frames += svg.count('class="diagram-frame"')
        for strip in (True, False):
            if core.portable(text, strip_front_matter=strip) != bridge.portable(text, strip_front_matter=strip):
                failures.append(f"{name}: portable strip={strip}")
    assert not failures, failures[:5]
    assert drawn_frames > 100, drawn_frames


def _flow() -> dict[str, Any]:
    model: dict[str, Any] = core.parse("flowchart", "flowchart TD\n  A --> B\n")["model"]
    return model


def test_frame_edits() -> None:
    one = diagram_ops.add_frame(_flow(), {"diagramId": "d-1"})
    assert one["frames"] == [
        {"id": "f1", "diagramId": "d-1", "position": {"x": 40, "y": 40}, "size": {"width": 360, "height": 240}}
    ]
    two = diagram_ops.add_frame(
        one, {"diagramId": "d-2", "position": {"x": 500, "y": 10}, "size": {"width": 50, "height": 900}}
    )
    assert two["frames"][1] == {
        "id": "f2",
        "diagramId": "d-2",
        "position": {"x": 500, "y": 10},
        "size": {"width": 160, "height": 900},
    }
    moved = diagram_ops.update_frame(two, "f1", {"position": {"x": 1, "y": 2}, "size": {"width": 10, "height": 10}})
    assert moved["frames"][0]["position"] == {"x": 1, "y": 2}
    assert moved["frames"][0]["size"] == {"width": 160, "height": 100}
    assert diagram_ops.update_frame(two, "f2", {"diagramId": "d-9"})["frames"][1]["diagramId"] == "d-9"
    gone = diagram_ops.remove_frame(diagram_ops.remove_frame(two, "f1"), "f2")
    assert "frames" not in gone
    assert diagram_ops.next_frame_id(diagram_ops.remove_frame(two, "f1")) == "f1"
    with pytest.raises(ValueError, match="no frame"):
        diagram_ops.update_frame(two, "f9", {})
    with pytest.raises(ValueError, match="not a diagram id"):
        diagram_ops.add_frame(one, {"diagramId": "bad id"})


def test_the_mermaid_export_notes_frames() -> None:
    text = core.serialize("flowchart", diagram_ops.add_frame(_flow(), {"diagramId": "d-1"}))
    for strip in (True, False):
        exported = core.portable(text, strip_front_matter=strip)
        assert exported.endswith("%% This diagram embeds other diagrams (Canvas frames), which Mermaid can't show.\n")
    assert "Canvas frames" not in core.portable("flowchart TD\n  A --> B\n")
