"""canvas-1bty.15.4: the two layout modules the SVG renderer uses, against TypeScript's results.

- compute_sequence_layout (sequence-layout.ts) on every sequence case of the golden corpus plus hand-made models;
- compute_legend_entries / legend_layout (legend.ts) on corpus and hand-made models x standards x legend settings
  x content bounds.

Vectors: tests/data/render_layout_vectors.json, written by make_render_layout_vectors.ts (see its header). The
models in it were parsed by TypeScript, so these tests don't depend on the Python parsers.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from canvas_api.diagram_core import canonical_json
from canvas_api.diagram_core.jsvalues import to_js_json
from canvas_api.diagram_core.legend import LEGEND_METRICS, compute_legend_entries, legend_layout
from canvas_api.diagram_core.sequence_layout import SELF_MESSAGE_LOOP_WIDTH, compute_sequence_layout

VECTORS: dict[str, Any] = json.loads((Path(__file__).parent / "data" / "render_layout_vectors.json").read_text("utf-8"))
MAP_FIELDS = ("lifelines", "messages", "activations", "blocks", "notes", "boxes")


def _as_vector(layout: dict[str, Any]) -> dict[str, Any]:
    """The layout as the generator wrote it: each Map as [id, value] pairs, in insertion order."""
    out = {key: [[k, v] for k, v in layout[key].items()] for key in MAP_FIELDS}
    out["diagramWidth"] = layout["diagramWidth"]
    out["diagramHeight"] = layout["diagramHeight"]
    return out


def test_the_vectors_cover_enough() -> None:
    names = [v["name"] for v in VECTORS["sequence"]]
    assert sum(n.startswith("sequence-") for n in names) >= 13
    assert sum(bool(v["entries"]) for v in VECTORS["legend"]) >= 300
    assert sum(v["layouts"] is not None for v in VECTORS["legend"]) >= 200


@pytest.mark.parametrize("vector", VECTORS["sequence"], ids=[v["name"] for v in VECTORS["sequence"]])
def test_sequence_layout_matches_typescript(vector: dict[str, Any]) -> None:
    before = canonical_json(vector["model"])
    actual = to_js_json(_as_vector(compute_sequence_layout(vector["model"])))
    assert canonical_json(actual) == canonical_json(vector["layout"])
    # Same key order inside each Map, too (canonical_json sorts object keys, not these pairs).
    for key in MAP_FIELDS:
        assert [pair[0] for pair in actual[key]] == [pair[0] for pair in vector["layout"][key]], key
    assert canonical_json(vector["model"]) == before, "the model is not mutated"


def test_sequence_constants() -> None:
    assert SELF_MESSAGE_LOOP_WIDTH == 50
    assert LEGEND_METRICS["padding"] == 12 and LEGEND_METRICS["offset"] == 24


def _legend_id(vector: dict[str, Any]) -> str:
    return f"{VECTORS['legendModels'][vector['model']]['name']}-v{vector['variant']}-{vector['rules']}"


@pytest.mark.parametrize("vector", VECTORS["legend"], ids=[_legend_id(v) for v in VECTORS["legend"]])
def test_legend_matches_typescript(vector: dict[str, Any]) -> None:
    model = dict(VECTORS["legendModels"][vector["model"]]["model"])
    variant = VECTORS["legendVariants"][vector["variant"]]
    if variant is not None:
        model["legend"] = variant
    rules = None if vector["rules"] is None else VECTORS["standards"][vector["rules"]]
    entries = compute_legend_entries(model, rules)
    assert canonical_json(to_js_json(entries)) == canonical_json(vector["entries"])

    layouts = []
    for bounds in VECTORS["boundsList"]:
        layout = legend_layout(model, entries, bounds)
        if layout is not None:
            for i, row in enumerate(layout["rows"]):
                assert row["entry"] is entries[i]
            layout = {**layout, "rows": [{**row, "entry": i} for i, row in enumerate(layout["rows"])]}
        layouts.append(layout)
    expected = vector["layouts"] if vector["layouts"] is not None else [None] * len(VECTORS["boundsList"])
    assert canonical_json(to_js_json(layouts)) == canonical_json(expected)
