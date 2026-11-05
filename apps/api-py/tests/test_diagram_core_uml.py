"""canvas-1bty.15.2: the uml family (Mermaid classDiagram), native Python against the TypeScript diagram-core.

1. Every golden-corpus case whose family is uml must produce exactly the family.txt, model.json, serialized.mmd
   and errors.json the TypeScript implementation wrote (render.svg, violations-* and portable.mmd are other
   ports'), and must be stable over round trips.
2. Seeded, generated class diagrams through parse_uml/serialize_uml and through the bridge must be identical
   (needs Node and the bridge bundle; skips without, like the other bridge tests). This also covers inputs the
   corpus can't, since detection reads the raw first line: a comment or %%{init}%% before the header.
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
from canvas_api.diagram_core.jsvalues import to_js_json
from canvas_api.diagram_core.jsyaml import YamlError
from canvas_api.diagram_core.portable import to_portable_mermaid
from canvas_api.diagram_core.uml import parse_uml, serialize_uml
from tests.diagram_bridge import DiagramBridge

CORPUS = Path(__file__).resolve().parents[3] / "packages" / "diagram-core" / "corpus"


def _read(path: Path) -> str:
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def _input(case: str) -> str:
    return _read(CORPUS / "cases" / case / "input.mmd")


CASES = sorted(
    p.name for p in (CORPUS / "cases").iterdir() if p.is_dir() and detect_dsl_family(_input(p.name)) == "uml"
)


def _raw(value: Any) -> Any:
    """A parser's model as the TypeScript serializer sees it before any JSON: undefined fields (None here) are
    absent, a NaN stays NaN. (serialize_uml takes JSON-shaped models, where None is JSON's null.)"""
    if isinstance(value, dict):
        return {k: _raw(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_raw(v) for v in value]
    return value


def _outputs(source: str) -> dict[str, str]:
    parsed = parse_uml(source)
    if "model" not in parsed:
        return {"family.txt": "uml\n", "errors.json": canonical_json(to_js_json(parsed))}
    return {
        "family.txt": "uml\n",
        "model.json": canonical_json(to_js_json(parsed["model"])),
        "serialized.mmd": serialize_uml(_raw(parsed["model"])),
    }


def test_the_corpus_covers_uml() -> None:
    assert len(CASES) >= 15
    assert sum(c.startswith("error-uml") for c in CASES) >= 3


@pytest.mark.parametrize("case", CASES)
def test_corpus_case_native(case: str) -> None:
    expected_dir = CORPUS / "cases" / case / "expected"
    actual = _outputs(_input(case))
    expected = {p.name: _read(p) for p in expected_dir.iterdir() if p.name in actual or p.name == "errors.json"}
    assert sorted(actual) == sorted(expected)
    for name, content in actual.items():
        assert content == expected[name], f"{case}/expected/{name}"


@pytest.mark.parametrize("case", [c for c in CASES if (CORPUS / "cases" / c / "expected" / "model.json").exists()])
def test_corpus_case_is_stable(case: str) -> None:
    original: dict[str, Any] = _raw(parse_uml(_input(case))["model"])
    serialized = serialize_uml(original)
    once = parse_uml(serialized)
    assert "model" in once, f"{case}: serialized output parses"

    def by_id(items: list[dict[str, Any]]) -> str:
        return canonical_json(to_js_json(sorted(items, key=lambda i: i["id"])))

    assert by_id(once["model"]["nodes"]) == by_id(original["nodes"])
    assert by_id(once["model"]["edges"]) == by_id(original["edges"])
    second = serialize_uml(_raw(once["model"]))
    twice = parse_uml(second)
    assert "model" in twice
    assert serialize_uml(_raw(twice["model"])) == second


def test_direction_folds_ascii_only() -> None:
    """JavaScript's /i (no u flag) doesn't fold U+0130 or U+0131 to "i"; Python's re.IGNORECASE alone would."""
    assert "errors" in parse_uml("classDiagram\n  d\u0130rection LR\n")
    assert "errors" in parse_uml("classDiagram\n  d\u0131rection LR\n")
    assert parse_uml("classDiagram\n  DIRECTION lr\n")["model"]["direction"] == "LR"


# --- parity fuzz against the bridge -----------------------------------------------------------------------------

IDS = ["A", "B", "Cat", "dog_2", "_x", "10", "Order", "Z9", "constructor", "toString", "__proto__"]
TOKENS = ["<|--", "*--", "o--", "-->", "--", "..>", "..|>", "..", "()--", "--()", "<|..", "->"]
LABELS = ["feeds", "has many", "a : b", "x", "émoji 🎨", "  spaced  "]
CARDS = ["1", "*", "0..1", "many", "", "1..n"]
MEMBERS = [
    "+String name",
    "-int age$",
    "#List~T~ items",
    "~Map~string, int~ cache",
    "+speak() String*",
    "+grow(int years) void",
    "-audit()",
    "count$",
    "field*",
    "+create()$",
    "<<abstract>>",
    "+broken(",
    "-",
    "+(x)",
    "  +  spaced  (  a , b )  R  ",
    "plain",
    "%% a comment",
    "+x %% trailing",
]
NAMESPACES = ["N", "Outer", "A.B", "A.B.C", 'L["Label"]', 'A.D["Deep"]', "Pkg"]


def _rel(rnd: random.Random) -> str:
    source, target = rnd.choice(IDS), rnd.choice(IDS)
    left = f' "{rnd.choice(CARDS)}"' if rnd.random() < 0.2 else ""
    right = f'"{rnd.choice(CARDS)}" ' if rnd.random() < 0.2 else ""
    label = f" : {rnd.choice(LABELS)}" if rnd.random() < 0.3 else ""
    return f"{source}{left} {rnd.choice(TOKENS)} {right}{target}{label}"


def _line(rnd: random.Random) -> list[str]:
    r = rnd.random()
    cid = rnd.choice(IDS)
    generic = rnd.choice(["", "", "~T~", "~Key, Value~"])
    stereo = rnd.choice(["", "", " <<interface>>", " <<service>>"])
    # canvas-8wxq: class display labels.
    generic += rnd.choice(["", "", '["A label"]', '["x * y"]', '[""]'])
    if r < 0.25:
        return [_rel(rnd)]
    if r < 0.35:
        return [f"class {cid}{generic}{stereo}"]
    if r < 0.45:
        body = [f"  {rnd.choice(MEMBERS)}" for _ in range(rnd.randint(0, 4))]
        return [f"class {cid}{generic}{stereo} {{", *body, *(["}"] if rnd.random() < 0.95 else [])]
    if r < 0.5:
        return [f"<<{rnd.choice(['enumeration', 'abstract'])}>> {cid}"]
    if r < 0.55:
        return [f'note for {cid} "{rnd.choice(LABELS)}"']
    if r < 0.58:
        return [f'note "{rnd.choice(LABELS)}"']
    if r < 0.62:
        return [
            f"classDef {rnd.choice(['hot', 'cool'])} fill:#f00,stroke:#900,stroke-width:{rnd.choice(['2px', 'x'])};"
        ]
    if r < 0.66:
        return [f"class {cid},{rnd.choice(IDS)} {rnd.choice(['hot', 'cool', 'none'])}"]
    if r < 0.69:
        return [f"{cid}:::{rnd.choice(['hot', 'cool'])}"]
    if r < 0.72:
        return [f"style {cid} fill:#{rnd.randint(0, 0xFFFFFF):06x},stroke-dasharray: 5 5"]
    if r < 0.74:
        return ["direction " + rnd.choice(["LR", "rl", "TB", "bt", "XY"])]
    if r < 0.76:
        return ["title " + rnd.choice(LABELS)]
    if r < 0.77:
        return ["accTitle: " + rnd.choice(LABELS)]
    if r < 0.78:
        return ["accDescr: " + rnd.choice(LABELS)]
    if r < 0.8:
        return ["%%{init: {'theme': 'dark'}}%%"]
    if r < 0.82:
        return ["%% a comment"]
    if r < 0.84:
        return [f"class {cid} %% trailing"]
    if r < 0.86:
        return ["not valid ;;"]
    if r < 0.87:
        return ["}"]
    return [""]


def diagram(rnd: random.Random) -> str:
    out: list[str] = []
    if rnd.random() < 0.3:
        ids = rnd.sample(IDS, rnd.randint(1, 4))
        canvas: dict[str, Any] = {
            "positions": {i: {"x": rnd.randint(0, 900), "y": rnd.choice([40, 40.5])} for i in ids}
        }
        if rnd.random() < 0.5:
            canvas["styles"] = {ids[0]: {"fillColor": "#abcdef", "strokeWidth": 2}}
        if rnd.random() < 0.5:
            canvas["containers"] = {
                "N": {"x": 10, "y": 20, "width": 300, "height": 200},
                "note1": {"x": 5, "y": 6},
                "A.B": {"x": 1, "y": 2, "width": 3},
            }
        if rnd.random() < 0.2:
            canvas["legend"] = {"visible": False, "title": "Key", "labels": {"kind:a": "A"}}
        if rnd.random() < 0.15:
            canvas = {"containers": canvas.get("containers", {"N": {"x": 1, "y": 2}})}
        out += ["---", json.dumps({"canvas": canvas}), "---"]
    if rnd.random() < 0.1:
        out.append(rnd.choice(["%% before the header", "%%{init: {}}%%", "class A"]))
    if rnd.random() < 0.95:
        out.append(rnd.choice(["classDiagram", "classDiagram %% comment", "  classDiagram  "]))
    depth = 0
    for _ in range(rnd.randint(0, 14)):
        r = rnd.random()
        if r < 0.1:
            out.append(("  " * depth) + f"namespace {rnd.choice(NAMESPACES)} {{")
            depth += 1
        elif r < 0.17 and depth:
            out.append(("  " * (depth - 1)) + "}")
            depth -= 1
        else:
            out += [("  " * depth) + text for text in _line(rnd)]
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
        parsed = to_js_json(parse_uml(dsl))
    except YamlError:
        with pytest.raises(Exception, match=r".+"):
            bridge.detect_and_parse(dsl, "uml")
        return found
    reference = bridge.detect_and_parse(dsl, "uml")
    if canonical_json(parsed) != canonical_json({k: v for k, v in reference.items() if k != "family"}):
        found.append("parse")
    if "model" in parsed:
        model = json.loads(json.dumps(parsed["model"]))
        if serialize_uml(model) != bridge.serialize("uml", model):
            found.append("serialize")
        # canvas-0t84: the export rewrites forms Mermaid refuses, on typed and on saved text.
        for text in (dsl, serialize_uml(model)):
            for strip in (False, True):
                if to_portable_mermaid(text, strip) != bridge.portable(text, strip_front_matter=strip):
                    found.append(f"portable(strip={strip})")
    return found


@pytest.mark.parametrize("seed", [101, 202, 303, 404])
def test_native_uml_matches_the_bridge_on_generated_diagrams(bridge: DiagramBridge, seed: int) -> None:
    rnd = random.Random(seed)
    failures: list[str] = []
    for index in range(75):
        dsl = diagram(rnd)
        found = _differences(bridge, dsl)
        if found:
            failures.append(f"seed={seed} index={index} differs in {found}:\n{dsl!r}")
    assert not failures, "\n\n".join(failures[:3])
