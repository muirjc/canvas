"""canvas-1bty.15.2: architecture-beta, answered by the native Python diagram-core.

- every architecture case of the golden corpus (packages/diagram-core/corpus) through parse_architecture /
  serialize_architecture, compared with the files the TypeScript implementation wrote, plus the stability check;
- computeArchitectureLayout against TypeScript's results (tests/data/architecture_layout_vectors.json, see
  make_architecture_layout_vectors.ts there);
- a seeded fuzz: generated architecture diagrams through native and through the bridge (skips without Node).
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
from canvas_api.diagram_core.architecture import parse_architecture, serialize_architecture
from canvas_api.diagram_core.architecture_layout import compute_architecture_layout
from canvas_api.diagram_core.detect import detect_dsl_family
from canvas_api.diagram_core.jsvalues import to_js_json
from canvas_api.diagram_core.jsyaml import YamlError
from tests.diagram_bridge import DiagramBridge

CORPUS = Path(__file__).resolve().parents[3] / "packages" / "diagram-core" / "corpus"
VECTORS: list[dict[str, Any]] = json.loads(
    (Path(__file__).parent / "data" / "architecture_layout_vectors.json").read_text("utf-8")
)


def _read(path: Path) -> str:
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def _input(case: str) -> str:
    return _read(CORPUS / "cases" / case / "input.mmd")


CASES = sorted(
    p.name
    for p in (CORPUS / "cases").iterdir()
    if p.is_dir() and detect_dsl_family(_read(p / "input.mmd")) == "architecture"
)


def test_the_corpus_has_architecture_cases() -> None:
    assert len(CASES) >= 12
    assert any(c.startswith("error-") for c in CASES)


@pytest.mark.parametrize("case", CASES)
def test_corpus_case_native(case: str) -> None:
    expected_dir = CORPUS / "cases" / case / "expected"
    compared = {"family.txt", "model.json", "serialized.mmd", "errors.json"}
    expected = {p.name: _read(p) for p in expected_dir.iterdir() if p.name in compared}
    source = _input(case)
    parsed = parse_architecture(source)
    actual = {"family.txt": "architecture\n"}
    if "model" in parsed:
        actual["model.json"] = canonical_json(to_js_json(parsed["model"]))
        actual["serialized.mmd"] = serialize_architecture(parsed["model"])
    else:
        actual["errors.json"] = canonical_json(to_js_json(parsed))
    assert sorted(actual) == sorted(expected)
    for name, content in actual.items():
        assert content == expected[name], f"{case}/expected/{name}"


@pytest.mark.parametrize("case", [c for c in CASES if (CORPUS / "cases" / c / "expected" / "model.json").exists()])
def test_corpus_case_is_stable(case: str) -> None:
    original: dict[str, Any] = parse_architecture(_input(case))["model"]
    serialized = serialize_architecture(original)
    once = parse_architecture(serialized)
    assert "model" in once, f"{case}: serialized output parses"

    def by_id(items: list[dict[str, Any]]) -> str:
        return canonical_json(to_js_json(sorted(items, key=lambda i: i["id"])))

    assert by_id(once["model"]["nodes"]) == by_id(original["nodes"])
    assert by_id(once["model"]["edges"]) == by_id(original["edges"])
    second = serialize_architecture(once["model"])
    twice = parse_architecture(second)
    assert "model" in twice
    assert serialize_architecture(twice["model"]) == second


def test_a_missing_header_is_an_error() -> None:
    assert parse_architecture("service a(server)[A]\narchitecture-beta\n") == {
        "errors": [
            {"line": 1, "content": "service a(server)[A]", "message": 'Expected "architecture-beta" header line'}
        ]
    }


def test_iconify_prefix_letters_are_ascii_only() -> None:
    """JavaScript's /i without the u flag never folds the Kelvin sign onto k: not an iconify reference."""
    kelvin = chr(0x212A)
    model = parse_architecture(f"architecture-beta\nservice a({kelvin}ey:x)[A]\n")["model"]
    assert model["nodes"][0]["icon"] == {"libraryId": "generic", "libraryVersion": "1.0.0", "iconId": f"{kelvin}ey:x"}


@pytest.mark.parametrize("vector", VECTORS, ids=[f"layout-{i}" for i in range(len(VECTORS))])
def test_architecture_layout_matches_typescript(vector: dict[str, Any]) -> None:
    node_positions, container_positions, container_sizes = compute_architecture_layout(
        vector["nodes"], vector["containers"], vector["edges"], vector["alignments"]
    )
    assert node_positions == vector["nodePositions"]
    assert container_positions == vector["containerPositions"]
    assert container_sizes == vector["containerSizes"]


# --- parity fuzz against the bridge ------------------------------------------------------------------------

IDS = ["a", "b", "c", "db", "api", "gw", "g1", "g2", "j1", "x_1", "10"]
GROUPS = ["g1", "g2", "g3", "vpc"]
ICONS = ["server", "database", "disk", "internet", "cloud", "logos:aws-lambda", "MDI:x", "app-services", "", " cloud "]
LABELS = ["A", "two words", "API: v2 (x)", "émoji 🎨", "a]b", "very long label that wraps across lines"]
SIDES = ["", "L", "R", "T", "B"]


def _endpoint(rnd: random.Random, source: bool) -> str:
    ident = rnd.choice(IDS)
    group = "{group}" if rnd.random() < 0.15 else ""
    side = rnd.choice(SIDES)
    if not side:
        return ident + group
    return f"{ident}{group}:{side}" if source else f"{side}:{ident}{group}"


def _line(rnd: random.Random) -> str:
    r = rnd.random()
    in_clause = f" in {rnd.choice(GROUPS)}" if rnd.random() < 0.4 else ""
    if r < 0.15:
        return f"group {rnd.choice(GROUPS)}({rnd.choice(ICONS)})[{rnd.choice(LABELS)}]{in_clause}"
    if r < 0.4:
        return f"service {rnd.choice(IDS)}({rnd.choice(ICONS)})[{rnd.choice(LABELS)}]{in_clause}"
    if r < 0.47:
        return f"junction {rnd.choice(IDS)}{in_clause}"
    if r < 0.75:
        space = rnd.choice([" ", "", "  "])
        return f"{_endpoint(rnd, True)}{space}{rnd.choice(['-->', '<--', '--'])}{space}{_endpoint(rnd, False)}"
    if r < 0.82:
        return f"align {rnd.choice(['row', 'column'])} " + " ".join(rnd.sample(IDS + GROUPS, rnd.randint(1, 4)))
    if r < 0.85:
        return "title " + rnd.choice(LABELS)
    if r < 0.87:
        return "accTitle: " + rnd.choice(LABELS)
    if r < 0.89:
        return "accDescr: " + rnd.choice(LABELS)
    if r < 0.91:
        return "%% a comment"
    if r < 0.93:
        return "%%{init: {'theme': 'dark'}}%%"
    if r < 0.95:
        return "service broken"
    return ""


def _diagram(rnd: random.Random) -> str:
    out: list[str] = []
    if rnd.random() < 0.35:
        ids = rnd.sample(IDS, rnd.randint(1, 4))
        canvas: dict[str, Any] = {}
        if rnd.random() < 0.7:
            canvas["positions"] = {i: {"x": rnd.randint(0, 900), "y": rnd.choice([40, 40.5])} for i in ids}
        if rnd.random() < 0.4:
            canvas["containers"] = {rnd.choice(GROUPS): {"x": 10, "y": 20, "width": 300, "height": 200}}
        if rnd.random() < 0.4:
            canvas["icons"] = {
                ids[0]: rnd.choice(
                    [
                        {"libraryId": "generic", "libraryVersion": "1.0.0", "iconId": "database"},
                        {"libraryId": "aws-icons", "libraryVersion": "2024.1-placeholder", "iconId": "ec2"},
                        {"libraryId": "azure-icons", "libraryVersion": "2024.1", "iconId": "vm"},
                    ]
                )
            }
        if rnd.random() < 0.3:
            canvas["kinds"] = {ids[0]: "frontend"}
        if rnd.random() < 0.3:
            canvas["styles"] = {ids[0]: {"fillColor": "#abcdef"}}
        if rnd.random() < 0.15:
            canvas["legend"] = {"title": "Key", "position": {"x": 1, "y": 2}}
        out += ["---", json.dumps({"canvas": canvas} if rnd.random() < 0.9 else {}), "---"]
    if rnd.random() < 0.95:
        out.append("architecture-beta")
    out += [rnd.choice(["", "  "]) + _line(rnd) for _ in range(rnd.randint(0, 14))]
    return "\n".join(out) + rnd.choice(["\n", "", "\r\n"])


@pytest.fixture(scope="module")
def bridge(bridge_url: str | None) -> Iterator[DiagramBridge]:
    if bridge_url is None:
        pytest.skip("needs node and packages/diagram-bridge/dist/bridge.mjs")
    with DiagramBridge(bridge_url) as client:
        yield client


def _differences(bridge: DiagramBridge, dsl: str) -> list[str]:
    try:
        parsed = to_js_json(parse_architecture(dsl))
    except YamlError:
        with pytest.raises(Exception, match=r".+"):
            bridge.parse("architecture", dsl)
        return []
    found: list[str] = []
    if canonical_json(parsed) != canonical_json(bridge.parse("architecture", dsl)):
        found.append("parse")
    if "model" in parsed:
        model = json.loads(json.dumps(parsed["model"]))
        serialized = serialize_architecture(model)
        if serialized != bridge.serialize("architecture", model):
            found.append("serialize")
        again = to_js_json(parse_architecture(serialized))
        if canonical_json(again) != canonical_json(bridge.parse("architecture", serialized)):
            found.append("reparse")
    return found


@pytest.mark.parametrize("seed", [5, 17, 29, 41])
def test_native_architecture_matches_the_bridge_on_generated_diagrams(bridge: DiagramBridge, seed: int) -> None:
    rnd = random.Random(seed)
    failures: list[str] = []
    for index in range(75):
        dsl = _diagram(rnd)
        found = _differences(bridge, dsl)
        if found:
            failures.append(f"seed={seed} index={index} differs in {found}:\n{dsl!r}")
    assert not failures, "\n\n".join(failures[:3])
