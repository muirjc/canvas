"""canvas-1bty.15.1: the golden corpus, answered by the native Python diagram-core (no Node, no bridge).

Every case whose family is ported (flowchart, and inputs that don't parse at all) must produce exactly the files the
TypeScript implementation wrote under expected/ -- except render.svg, which is the renderer's (not ported yet).
Mirrors packages/diagram-core/tests/contract/golden-corpus.test.ts.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from canvas_api.diagram_core import DiagramCore, canonical_json
from canvas_api.diagram_core.core import NATIVE_FAMILIES
from canvas_api.diagram_core.flowchart import parse_flowchart, serialize_flowchart
from canvas_api.diagram_core.jsvalues import to_js_json

CORPUS = Path(__file__).resolve().parents[3] / "packages" / "diagram-core" / "corpus"
CASES = sorted(p.name for p in (CORPUS / "cases").iterdir() if p.is_dir())
core = DiagramCore(None)


def _read(path: Path) -> str:
    # newline="" keeps CRLF exactly as the TypeScript test reads the file.
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def _input(case: str) -> str:
    return _read(CORPUS / "cases" / case / "input.mmd")


def _native_case(case: str) -> bool:
    family = core.detect(_input(case))
    return family is None or family in NATIVE_FAMILIES


def _outputs(source: str) -> dict[str, str]:
    family = core.detect(source)
    if family is None:
        return {"errors.json": canonical_json({"errors": [{"message": "Unrecognized diagram header"}]})}
    parsed = core.parse(family, source)
    if "model" not in parsed:
        return {"family.txt": f"{family}\n", "errors.json": canonical_json(parsed)}
    # Serialize the model as the parser built it (a NaN stays NaN; as JSON it would be null).
    return {
        "family.txt": f"{family}\n",
        "model.json": canonical_json(parsed["model"]),
        "serialized.mmd": core.serialize(family, parse_flowchart(source)["model"]),
        "portable.mmd": core.portable(source, strip_front_matter=True),
    }


NATIVE_CASES = [c for c in CASES if _native_case(c)]


def test_the_corpus_has_flowchart_and_error_cases() -> None:
    assert len(NATIVE_CASES) >= 30
    assert any(c.startswith("error-") for c in NATIVE_CASES)


@pytest.mark.parametrize("case", NATIVE_CASES)
def test_corpus_case_native(case: str) -> None:
    expected_dir = CORPUS / "cases" / case / "expected"
    # render.svg is the renderer's and violations-*.json the validator's: neither is ported yet.
    expected = {
        p.name: _read(p)
        for p in expected_dir.iterdir()
        if p.name != "render.svg" and not p.name.startswith("violations-")
    }
    actual = _outputs(_input(case))
    assert sorted(actual) == sorted(expected)
    for name, content in actual.items():
        assert content == expected[name], f"{case}/expected/{name}"


@pytest.mark.parametrize(
    "case", [c for c in NATIVE_CASES if (CORPUS / "cases" / c / "expected" / "model.json").exists()]
)
def test_corpus_case_is_stable(case: str) -> None:
    """Corpus README: the serialized output keeps every node and edge, and serializing again changes nothing."""
    source = _input(case)
    original: dict[str, Any] = parse_flowchart(source)["model"]
    serialized = serialize_flowchart(original)
    once = parse_flowchart(serialized)
    assert "model" in once, f"{case}: serialized output parses"

    def by_id(items: list[dict[str, Any]]) -> str:
        return canonical_json(to_js_json(sorted(items, key=lambda i: i["id"])))

    assert by_id(once["model"]["nodes"]) == by_id(original["nodes"])
    assert by_id(once["model"]["edges"]) == by_id(original["edges"])
    second = serialize_flowchart(once["model"])
    twice = parse_flowchart(second)
    assert "model" in twice
    assert serialize_flowchart(twice["model"]) == second
