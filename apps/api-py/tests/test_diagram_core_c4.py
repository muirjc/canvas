"""canvas-1bty.15.2: C4 diagrams, answered by the native Python diagram-core (c4.py).

Every golden-corpus case whose family is c4 must produce exactly the family, model, serialized Mermaid and errors
the TypeScript implementation wrote under expected/ (render.svg, violations-* and portable.mmd belong to other
ports), and must be stable through a round trip. Then a seeded fuzz compares native and the bridge (needs Node and
the bridge bundle; skips without).
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
from canvas_api.diagram_core.c4 import parse_c4, serialize_c4
from canvas_api.diagram_core.detect import detect_dsl_family
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
    p.name for p in (CORPUS / "cases").iterdir() if p.is_dir() and detect_dsl_family(_read(p / "input.mmd")) == "c4"
)
COMPARED = ("family.txt", "model.json", "serialized.mmd", "errors.json")


def _outputs(source: str) -> dict[str, str]:
    parsed = parse_c4(source)
    if "model" not in parsed:
        return {"family.txt": "c4\n", "errors.json": canonical_json(to_js_json(parsed))}
    return {
        "family.txt": "c4\n",
        "model.json": canonical_json(to_js_json(parsed["model"])),
        "serialized.mmd": serialize_c4(parsed["model"]),
    }


def test_the_corpus_has_c4_cases() -> None:
    assert len(CASES) >= 15
    assert any(c.startswith("error-") for c in CASES)


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
    original: dict[str, Any] = parse_c4(_input(case))["model"]
    once = parse_c4(serialize_c4(original))
    assert "model" in once, f"{case}: serialized output parses"

    def by_id(items: list[dict[str, Any]]) -> str:
        return canonical_json(to_js_json(sorted(items, key=lambda i: i["id"])))

    assert by_id(once["model"]["nodes"]) == by_id(original["nodes"])
    assert by_id(once["model"]["edges"]) == by_id(original["edges"])
    second = serialize_c4(once["model"])
    twice = parse_c4(second)
    assert "model" in twice
    assert serialize_c4(twice["model"]) == second


# --- parity fuzz against the bridge -------------------------------------------------------------------------------

IDS = ["a", "b", "c", "api", "db", "q1", "_x", "N2"]
ELEMENTS = [
    "Person",
    "Person_Ext",
    "System",
    "System_Ext",
    "SystemDb",
    "SystemDb_Ext",
    "SystemQueue",
    "SystemQueue_Ext",
    "Container",
    "Container_Ext",
    "ContainerDb",
    "ContainerDb_Ext",
    "ContainerQueue",
    "ContainerQueue_Ext",
    "Component",
    "Component_Ext",
    "ComponentDb",
    "ComponentDb_Ext",
    "ComponentQueue",
    "ComponentQueue_Ext",
]
RELS = ["Rel", "BiRel", "Rel_Back", "Rel_U", "Rel_D", "Rel_L", "Rel_R", "Rel_Up", "Rel_Down", "Rel_Left", "Rel_Right"]
BOUNDARIES = [
    "Boundary",
    "System_Boundary",
    "Container_Boundary",
    "Enterprise_Boundary",
    "Deployment_Node",
    "Node",
    "Node_L",
    "Node_R",
]
TEXTS = ["Label", "", "two words", "a, b", "émoji 🎨", "it's", "50%", "  spaced  "]
HEADERS = ["C4Context", "C4Container", "C4Component", "C4Dynamic", "C4Deployment"]


def _quoted(rnd: random.Random) -> str:
    return f'"{rnd.choice(TEXTS)}"'


def _extra_args(rnd: random.Random) -> str:
    out = ""
    for _ in range(rnd.choice([0, 0, 1, 2, 3, 4])):
        r = rnd.random()
        if r < 0.6:
            out += f", {_quoted(rnd)}"
        else:
            name = rnd.choice(["tags", "descr", "techn", "type", "sprite", "link", "x"])
            out += f"{rnd.choice([', ', ',', ' , '])}${name}={_quoted(rnd)}"
    return out


def _line(rnd: random.Random) -> str:
    r = rnd.random()
    if r < 0.35:
        return f"{rnd.choice(ELEMENTS)}({rnd.choice(IDS)}, {_quoted(rnd)}{_extra_args(rnd)})"
    if r < 0.6:
        return f"{rnd.choice(RELS)}({rnd.choice(IDS)}, {rnd.choice(IDS)}, {_quoted(rnd)}{_extra_args(rnd)})"
    if r < 0.66:
        args = rnd.choice(
            ['"#f00", "#fff", "#000"', '$bgColor="red"', '$borderColor="blue", $fontColor="x"', '"", "", "#111"', "x"]
        )
        return f"UpdateElementStyle({rnd.choice(IDS)}, {args})"
    if r < 0.71:
        args = rnd.choice(['"red", "blue", "-40", "60"', '$lineColor="green"', '$textColor="a"', '"a", ""'])
        return f"UpdateRelStyle({rnd.choice(IDS)}, {rnd.choice(IDS)}, {args})"
    if r < 0.73:
        return 'UpdateLayoutConfig($c4ShapeInRow="3")'
    if r < 0.75:
        return f"Lay_{rnd.choice('UDLRX')}({rnd.choice(IDS)}, {rnd.choice(IDS)})"
    if r < 0.78:
        return "title " + rnd.choice([*TEXTS, "Title"])
    if r < 0.8:
        return "accTitle: Acc"
    if r < 0.82:
        return "accDescr: Described"
    if r < 0.84:
        return "%% comment"
    if r < 0.86:
        return "%%{init: {'theme': 'dark'}}%%"
    if r < 0.88:
        return f'System({rnd.choice(IDS)}, "A") %% trailing'
    if r < 0.9:
        return "not valid"
    if r < 0.92:
        return "}"
    return ""


def _diagram(rnd: random.Random) -> str:
    out: list[str] = []
    if rnd.random() < 0.35:
        ids = rnd.sample(IDS, rnd.randint(1, 4))
        canvas: dict[str, Any] = {
            "positions": {i: {"x": rnd.randint(0, 900), "y": rnd.choice([40, 40.5])} for i in ids},
        }
        if rnd.random() < 0.5:
            canvas["styles"] = {ids[0]: rnd.choice([{"fillColor": "#abcdef", "strokeWidth": 2}, "red", 3])}
        if rnd.random() < 0.4:
            canvas["edgeStyles"] = {"e1": {"strokeColor": "#123"}}
        if rnd.random() < 0.4:
            canvas["containers"] = {
                "B1": {"x": 10, "y": 20, "width": 300, "height": 200},
                "B2": {"x": 1, "y": 2},
            }
        if rnd.random() < 0.15:
            canvas = {"containers": {"B1": {"x": 3, "y": 4}}}
        if rnd.random() < 0.2:
            canvas["legend"] = {"visible": False, "title": "Key"}
        out += ["---", json.dumps({"canvas": canvas}), "---"]
    if rnd.random() < 0.95:
        out.append(rnd.choice(HEADERS))
    depth = 0
    for _ in range(rnd.randint(0, 16)):
        r = rnd.random()
        if r < 0.1:
            out.append(
                "  " * depth
                + f"{rnd.choice(BOUNDARIES)}(B{rnd.randint(1, 3)}, {_quoted(rnd)}{_extra_args(rnd)})"
                + rnd.choice([" {", "{", "  {"])
            )
            depth += 1
        elif r < 0.17 and depth:
            out.append("  " * (depth - 1) + "}")
            depth -= 1
        else:
            out.append("  " * depth + _line(rnd))
    out += ["}"] * depth if rnd.random() < 0.9 else []
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
        parsed = to_js_json(parse_c4(dsl))
    except YamlError:
        with pytest.raises(Exception, match=r".+"):
            bridge.parse("c4", dsl)
        return found
    reference = bridge.parse("c4", dsl)
    if canonical_json(parsed) != canonical_json(reference):
        found.append("parse")
    if "model" in parsed:
        model = json.loads(json.dumps(parsed["model"]))
        if serialize_c4(model) != bridge.serialize("c4", model):
            found.append("serialize")
    return found


@pytest.mark.parametrize("seed", [4, 44, 444, 4444])
def test_native_c4_matches_the_bridge_on_generated_diagrams(bridge: DiagramBridge, seed: int) -> None:
    rnd = random.Random(seed)
    failures: list[str] = []
    for index in range(100):
        dsl = _diagram(rnd)
        found = _differences(bridge, dsl)
        if found:
            failures.append(f"seed={seed} index={index} differs in {found}:\n{dsl!r}")
    assert not failures, "\n\n".join(failures[:3])
