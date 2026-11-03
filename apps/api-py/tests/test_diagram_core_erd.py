"""canvas-1bty.15.2: erDiagram, answered by the native Python diagram-core (erd.py).

Every golden-corpus case detected as erd must produce exactly the family, model, serialized Mermaid and errors the
TypeScript implementation wrote under expected/ (render.svg, violations-* and portable.mmd belong to other parts),
and must be stable. Then a seeded fuzz compares native and the bridge on generated diagrams (skips without Node).
"""

# ruff: noqa: S311 - a seeded generator, not cryptography
from __future__ import annotations

import json
import random
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from canvas_api.diagram_core import canonical_json
from canvas_api.diagram_core.detect import detect_dsl_family
from canvas_api.diagram_core.erd import parse_erd, serialize_erd
from canvas_api.diagram_core.jsvalues import to_js_json
from canvas_api.diagram_core.jsyaml import YamlError
from tests.diagram_bridge import DiagramBridge

CORPUS = Path(__file__).resolve().parents[3] / "packages" / "diagram-core" / "corpus"


def _read(path: Path) -> str:
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def _input(case: str) -> str:
    return _read(CORPUS / "cases" / case / "input.mmd")


CASES = sorted(
    p.name for p in (CORPUS / "cases").iterdir() if p.is_dir() and detect_dsl_family(_input(p.name)) == "erd"
)
COMPARED = {"family.txt", "model.json", "serialized.mmd", "errors.json"}


def _as_parsed(value: Any) -> Any:
    """A parser-built model as the TypeScript serializer sees it in memory: a None field is undefined (left out
    of the YAML), NaN stays NaN. serialize_erd itself takes models that crossed JSON, where None is null."""
    if isinstance(value, dict):
        return {k: _as_parsed(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_as_parsed(v) for v in value]
    return value


def _outputs(source: str) -> dict[str, str]:
    parsed = parse_erd(source)
    if "model" not in parsed:
        return {"family.txt": "erd\n", "errors.json": canonical_json(to_js_json(parsed))}
    return {
        "family.txt": "erd\n",
        "model.json": canonical_json(to_js_json(parsed["model"])),
        "serialized.mmd": serialize_erd(_as_parsed(parsed["model"])),
    }


def test_the_corpus_covers_erd() -> None:
    assert len(CASES) >= 12
    assert any(c.startswith("error-erd") for c in CASES)


@pytest.mark.parametrize("case", CASES)
def test_corpus_case_native(case: str) -> None:
    expected_dir = CORPUS / "cases" / case / "expected"
    expected = {p.name: _read(p) for p in expected_dir.iterdir() if p.name in COMPARED}
    actual = _outputs(_input(case))
    assert sorted(actual) == sorted(expected)
    for name, content in actual.items():
        assert content == expected[name], f"{case}/expected/{name}"


@pytest.mark.parametrize("case", [c for c in CASES if (CORPUS / "cases" / c / "expected" / "model.json").exists()])
def test_corpus_case_is_stable(case: str) -> None:
    original: dict[str, Any] = _as_parsed(parse_erd(_input(case))["model"])
    serialized = serialize_erd(original)
    once = parse_erd(serialized)
    assert "model" in once, f"{case}: serialized output parses"

    def by_id(items: list[dict[str, Any]]) -> str:
        return canonical_json(to_js_json(sorted(items, key=lambda i: i["id"])))

    assert by_id(once["model"]["nodes"]) == by_id(original["nodes"])
    assert by_id(once["model"]["edges"]) == by_id(original["edges"])
    second = serialize_erd(_as_parsed(once["model"]))
    twice = parse_erd(second)
    assert "model" in twice
    assert serialize_erd(_as_parsed(twice["model"])) == second


def test_serializing_fills_in_what_mermaid_requires() -> None:
    model = {
        "diagramTypeId": "erd",
        "nodes": [
            {"id": "A", "label": "A", "shape": "rectangle", "position": {"x": 1, "y": 2}},
            {"id": "B", "label": "Bee", "shape": "rectangle", "position": {"x": 3, "y": 4}},
        ],
        "edges": [{"id": "e1", "sourceId": "A", "targetId": "B", "label": "   "}],
        "containers": [],
    }
    body = serialize_erd(model).split("---\n")[-1]
    assert body == "erDiagram\nB[Bee]\nA ||--o{ B : relates to\n"


# --- parity fuzz against the bridge ---------------------------------------------------------------------------

IDS = ["CUSTOMER", "ORDER", "o", "A", "line-item", "_x", "9", "B2", "constructor", "toString", "__proto__"]
CARDS = ["||", "|o", "}|", "}o", "o|", "|{", "o{", "{{", "|"]
LINES = ["--", "..", "-", "-.", ""]
LABELS = ["places", '"quoted, label"', '"half', 'say "hi"', "x : y", '""', "  spaced  ", "émoji 🎨", "a%%b"]
TYPES = ["string", "int", "varchar(255)", "date", "x"]
KEYS = ["", " PK", " FK", " UK", " pk, fk", " PK,UK", " XX", " PK , ZZ, uk"]
COMMENTS = ["", ' "note"', ' ""', ' "a, b"']
CLASSES = ["warm", "cool", "k-2"]


def _entity(rnd: random.Random) -> str:
    return rnd.choice(IDS)


def _line(rnd: random.Random) -> list[str]:
    r = rnd.random()
    if r < 0.3:
        cards = f"{rnd.choice(CARDS)}{rnd.choice(LINES)}{rnd.choice(CARDS)}"
        return [f"  {_entity(rnd)} {cards} {_entity(rnd)} : {rnd.choice(LABELS)}"]
    if r < 0.42:
        head = _entity(rnd) + rnd.choice(["", "[Alias Name]", " [x]"])
        body = [
            f"    {rnd.choice(TYPES)} f{k}{rnd.choice(KEYS)}{rnd.choice(COMMENTS)}" for k in range(rnd.randint(0, 3))
        ]
        return [f"  {head} {{", *body, *(["  }"] if rnd.random() < 0.92 else [])]
    if r < 0.5:
        return [f"  {_entity(rnd)}" + rnd.choice(["", "[Label]", "[a b c]"])]
    if r < 0.56:
        props = rnd.choice(["fill:#f00", "stroke:#000,stroke-width:2px", "stroke-width:x", "fill", "color:#fff"])
        return [f"  style {_entity(rnd)} {props}"]
    if r < 0.61:
        return [f"  classDef {rnd.choice(CLASSES)} fill:#{rnd.randint(0, 0xFFF):03x},stroke-dasharray: 5 5;"]
    if r < 0.65:
        return [f"  class {_entity(rnd)},{_entity(rnd)} {rnd.choice(CLASSES)}"]
    if r < 0.69:
        return [f"  {_entity(rnd)}" + rnd.choice(["", "[Lbl]"]) + f":::{rnd.choice(CLASSES)}, {rnd.choice(CLASSES)}"]
    if r < 0.73:
        return ["  direction " + rnd.choice(["LR", "tb", "Rl", "TD"])]
    if r < 0.76:
        return ["  title " + rnd.choice(LABELS)]
    if r < 0.78:
        return ["  accTitle: " + rnd.choice(LABELS)]
    if r < 0.8:
        return ["  accDescr:" + rnd.choice(LABELS)]
    if r < 0.83:
        return ["  %% comment", f"  {_entity(rnd)} %% trailing"]
    if r < 0.85:
        return ["  %%{init: {'theme': 'dark'}}%%"]
    if r < 0.87:
        return ["  }"]
    if r < 0.89:
        return ["  this is not valid ;;"]
    return [""]


def _diagram(rnd: random.Random) -> str:
    out: list[str] = []
    if rnd.random() < 0.3:
        ids = rnd.sample(IDS, rnd.randint(1, 4))
        fm: dict[str, Any] = {
            "canvas": {"positions": {i: {"x": rnd.randint(0, 900), "y": rnd.choice([40, 40.5, 120])} for i in ids}}
        }
        if rnd.random() < 0.5:
            fm["canvas"]["styles"] = {ids[0]: {"fillColor": "#abcdef", "strokeWidth": 2}}
        if rnd.random() < 0.2:
            fm["canvas"]["legend"] = {"visible": False, "title": "Key", "position": {"x": "10", "y": 20}}
        out += ["---", json.dumps(fm), "---"]
    out.append("erDiagram")
    for _ in range(rnd.randint(0, 12)):
        out += _line(rnd)
    return "\n".join(out) + rnd.choice(["\n", "", "\r\n"])


@pytest.fixture(scope="module")
def bridge(bridge_url: str | None) -> Iterator[DiagramBridge]:
    if bridge_url is None:
        pytest.skip("needs node and packages/diagram-bridge/dist/bridge.mjs")
    with DiagramBridge(bridge_url) as client:
        yield client


def _differences(bridge: DiagramBridge, dsl: str) -> list[str]:
    found: list[str] = []
    try:
        parsed = to_js_json(parse_erd(dsl))
    except YamlError:
        with pytest.raises(Exception, match=r".+"):
            bridge.detect_and_parse(dsl, "erd")
        return found
    reference = bridge.detect_and_parse(dsl, "erd")
    if canonical_json(parsed) != canonical_json({k: v for k, v in reference.items() if k != "family"}):
        found.append("parse")
    if "model" in parsed:
        model = json.loads(json.dumps(parsed["model"]))
        if serialize_erd(model) != bridge.serialize("erd", model):
            found.append("serialize")
    return found


@pytest.mark.parametrize("seed", [5, 17, 29, 41])
def test_native_erd_matches_the_bridge_on_generated_diagrams(bridge: DiagramBridge, seed: int) -> None:
    rnd = random.Random(seed)
    failures: list[str] = []
    for index in range(75):
        dsl = _diagram(rnd)
        found = _differences(bridge, dsl)
        if found:
            failures.append(f"seed={seed} index={index} differs in {found}:\n{dsl!r}")
    assert not failures, "\n\n".join(failures[:3])
