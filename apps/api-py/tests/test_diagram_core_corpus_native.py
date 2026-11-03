"""canvas-1bty.15.1-.15.3: the golden corpus, answered by the native Python diagram-core (no Node, no bridge).

Every case, in every family, must produce exactly the files the TypeScript implementation wrote under expected/,
the drawing (render.svg) included.
Mirrors packages/diagram-core/tests/contract/golden-corpus.test.ts.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from canvas_api.diagram_core import DiagramCore, canonical_json
from canvas_api.diagram_core.core import KNOWN_FAMILIES, PARSERS, SERIALIZERS
from canvas_api.diagram_core.jsvalues import to_js_json
from canvas_api.diagram_core.standards import validate

CORPUS = Path(__file__).resolve().parents[3] / "packages" / "diagram-core" / "corpus"
CASES = sorted(p.name for p in (CORPUS / "cases").iterdir() if p.is_dir())
STANDARDS: dict[str, dict[str, Any]] = {
    p.stem: json.loads(p.read_text("utf-8")) for p in (CORPUS / "standards").iterdir() if p.suffix == ".json"
}
core = DiagramCore()


def _read(path: Path) -> str:
    # newline="" keeps CRLF exactly as the TypeScript test reads the file.
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def _input(case: str) -> str:
    return _read(CORPUS / "cases" / case / "input.mmd")


def _as_parsed(value: Any) -> Any:
    """A parser-built model as the TypeScript serializer sees it in memory: a None field is undefined (left out),
    NaN stays NaN. The serializers themselves take models that crossed JSON, where None is null and kept."""
    if isinstance(value, dict):
        return {k: _as_parsed(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_as_parsed(v) for v in value]
    return value


def _outputs(source: str, standards: list[str] | None = None) -> dict[str, str]:
    family = core.detect(source)
    if family is None:
        return {"errors.json": canonical_json({"errors": [{"message": "Unrecognized diagram header"}]})}
    parsed = core.parse(family, source)
    if "model" not in parsed:
        return {"family.txt": f"{family}\n", "errors.json": canonical_json(parsed)}
    # Serialize and validate the model as the parser built it (a NaN stays NaN; as JSON it would be null).
    model = _as_parsed(PARSERS[family](source)["model"])
    files = {
        "family.txt": f"{family}\n",
        "model.json": canonical_json(parsed["model"]),
        "serialized.mmd": core.serialize(family, model),
        "portable.mmd": core.portable(source, strip_front_matter=True),
        "render.svg": core.render_svg(model) + "\n",
    }
    for standard in standards or []:
        files[f"violations-{standard}.json"] = canonical_json(to_js_json(validate(model, STANDARDS[standard])))
    return files


def test_the_corpus_covers_every_family_and_errors() -> None:
    families = {core.detect(_input(c)) for c in CASES}
    assert families >= set(KNOWN_FAMILIES)
    for family in KNOWN_FAMILIES:
        assert sum(1 for c in CASES if core.detect(_input(c)) == family) >= 8, family
    assert any(c.startswith("error-") for c in CASES)


@pytest.mark.parametrize("case", CASES)
def test_corpus_case_native(case: str) -> None:
    case_dir = CORPUS / "cases" / case
    expected = {p.name: _read(p) for p in (case_dir / "expected").iterdir()}
    meta = json.loads((case_dir / "case.json").read_text("utf-8")) if (case_dir / "case.json").exists() else {}
    actual = _outputs(_input(case), meta.get("standards"))
    assert sorted(actual) == sorted(expected)
    for name, content in actual.items():
        assert content == expected[name], f"{case}/expected/{name}"


@pytest.mark.parametrize("case", [c for c in CASES if (CORPUS / "cases" / c / "expected" / "model.json").exists()])
def test_corpus_case_is_stable(case: str) -> None:
    """Corpus README: the serialized output keeps every node and edge, and serializing again changes nothing."""
    source = _input(case)
    family = core.detect(source)
    assert family is not None
    parse, serialize = PARSERS[family], SERIALIZERS[family]
    original: dict[str, Any] = parse(source)["model"]
    serialized = serialize(_as_parsed(original))
    once = parse(serialized)
    assert "model" in once, f"{case}: serialized output parses"

    def by_id(items: list[dict[str, Any]]) -> str:
        return canonical_json(to_js_json(sorted(items, key=lambda i: i["id"])))

    assert by_id(once["model"]["nodes"]) == by_id(original["nodes"])
    assert by_id(once["model"]["edges"]) == by_id(original["edges"])
    second = serialize(_as_parsed(once["model"]))
    twice = parse(second)
    assert "model" in twice
    assert serialize(_as_parsed(twice["model"])) == second
