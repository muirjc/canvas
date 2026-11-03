"""canvas-1bty.15.2: the native Python sequence family (sequence.py) against the TypeScript one.

The golden corpus's sequence cases (and error-sequence-*) must parse and serialize to exactly the files the
TypeScript implementation wrote; a seeded fuzz compares native and the bridge on generated diagrams (skips without
Node and the bridge bundle, like the other bridge tests).
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
from canvas_api.diagram_core.sequence import parse_sequence, serialize_sequence
from tests.diagram_bridge import DiagramBridge

CORPUS = Path(__file__).resolve().parents[3] / "packages" / "diagram-core" / "corpus"


def _read(path: Path) -> str:
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def _input(case: str) -> str:
    return _read(CORPUS / "cases" / case / "input.mmd")


CASES = sorted(
    p.name for p in (CORPUS / "cases").iterdir() if p.is_dir() and detect_dsl_family(_input(p.name)) == "sequence"
)


def test_the_corpus_has_sequence_cases() -> None:
    assert len(CASES) >= 15
    assert any(c.startswith("error-") for c in CASES)


@pytest.mark.parametrize("case", CASES)
def test_corpus_case_native(case: str) -> None:
    source = _input(case)
    expected_dir = CORPUS / "cases" / case / "expected"
    parsed = parse_sequence(source)
    actual = {"family.txt": "sequence\n"}
    if "model" in parsed:
        actual["model.json"] = canonical_json(to_js_json(parsed["model"]))
        actual["serialized.mmd"] = serialize_sequence(parsed["model"])
    else:
        actual["errors.json"] = canonical_json(to_js_json(parsed))
    expected_names = {
        p.name
        for p in expected_dir.iterdir()
        if p.name not in ("render.svg", "portable.mmd") and not p.name.startswith("violations-")
    }
    assert sorted(actual) == sorted(expected_names)
    for name, content in actual.items():
        assert content == _read(expected_dir / name), f"{case}/expected/{name}"


@pytest.mark.parametrize("case", [c for c in CASES if (CORPUS / "cases" / c / "expected" / "model.json").exists()])
def test_corpus_case_is_stable(case: str) -> None:
    original: dict[str, Any] = parse_sequence(_input(case))["model"]
    serialized = serialize_sequence(original)
    once = parse_sequence(serialized)
    assert "model" in once, f"{case}: serialized output parses"

    def by_id(items: list[dict[str, Any]]) -> str:
        return canonical_json(to_js_json(sorted(items, key=lambda i: i["id"])))

    assert by_id(once["model"]["nodes"]) == by_id(original["nodes"])
    assert by_id(once["model"]["edges"]) == by_id(original["edges"])
    second = serialize_sequence(once["model"])
    twice = parse_sequence(second)
    assert "model" in twice
    assert serialize_sequence(twice["model"]) == second


def test_an_explicit_autonumber_without_numbers_round_trips() -> None:
    """`{start: undefined, step: undefined}` is truthy in JavaScript (an empty dict is falsy in Python)."""
    model = parse_sequence("sequenceDiagram\nautonumber\nA->>B: x\n")["model"]
    assert to_js_json(model)["sequenceAutonumber"] == {}
    assert "autonumber\n" in serialize_sequence(to_js_json(model))


# --- parity fuzz against the bridge -----------------------------------------------------------------------------

IDS = ["A", "B", "C", "Alice", "bob_2", "_x", "10", "constructor", "toString", "__proto__"]
LABELS = ["hi", "two words", "with: colon", "émoji 🎨", "a<br/>b", "  spaced  ", "x %% y", "1", "end", "#hash"]
ARROWS = ["->", "-->", "->>", "-->>", "-x", "--x", "-)", "--)", "<<->>", "<<-->>", "=>", "-->>>"]
BLOCKS = ["loop", "alt", "opt", "par", "critical", "break", "rect"]


def _id(rnd: random.Random) -> str:
    return rnd.choice(IDS)


def _line(rnd: random.Random, in_block: str | None) -> str:
    r = rnd.random()
    sp = rnd.choice(["", " ", "  "])
    if r < 0.35:
        sign = rnd.choice(["", "", "+", "-", " + "])
        return f"{_id(rnd)}{sp}{rnd.choice(ARROWS)}{sign}{sp}{_id(rnd)}{sp}:{sp}{rnd.choice(LABELS)}"
    if r < 0.45:
        alias = rnd.choice(["", f" as {rnd.choice(LABELS)}", " as", " AS x"])
        return f"{rnd.choice(['participant', 'actor', 'Participant'])} {_id(rnd)}{alias}"
    if r < 0.55:
        where = rnd.choice(["left of", "right of", "over", "Over", "left  of"])
        ids = ",".join(_id(rnd) for _ in range(rnd.randint(1, 3)))
        return f"{rnd.choice(['Note', 'note'])} {where} {ids}{sp}:{sp}{rnd.choice([*LABELS, ''])}"
    if r < 0.62:
        return f"{rnd.choice(['activate', 'deactivate', 'destroy'])} {_id(rnd)}"
    if r < 0.66:
        alias = rnd.choice(["", f" as {rnd.choice(LABELS)}"])
        return f"create {rnd.choice(['participant', 'actor'])} {_id(rnd)}{alias}"
    if r < 0.7 and in_block:
        return rnd.choice(["else", "else otherwise", "and", "and more", "option", "option x"])
    if r < 0.74:
        return rnd.choice(["autonumber", "autonumber off", "autonumber 3 2", "autonumber 0.5 1.25", "autonumber 1"])
    if r < 0.77:
        return rnd.choice(["title " + rnd.choice(LABELS), "accTitle: t", "accDescr : d", "%% comment"])
    if r < 0.79:
        return "%%{init: {'theme': 'dark'}}%%"
    if r < 0.81:
        return "end"
    if r < 0.83:
        return "this is not valid ;;"
    return f"{_id(rnd)}->>{_id(rnd)}: {rnd.choice(LABELS)} %% trailing"


def diagram(rnd: random.Random) -> str:
    out: list[str] = []
    if rnd.random() < 0.25:
        fm: dict[str, Any] = {"canvas": {"styles": {_id(rnd): {"fillColor": "#abcdef", "strokeWidth": 2}}}}
        if rnd.random() < 0.5:
            fm["canvas"]["edgeStyles"] = {f"e{rnd.randint(1, 3)}": {"strokeColor": "#f00"}}
        if rnd.random() < 0.3:
            fm["canvas"]["positions"] = {"A": {"x": 1, "y": 2}}
        out += ["---", json.dumps(fm), "---"]
    if rnd.random() < 0.95:
        out.append("sequenceDiagram")
    stack: list[str] = []
    for _ in range(rnd.randint(0, 16)):
        r = rnd.random()
        if r < 0.1:
            kw = rnd.choice(BLOCKS)
            arg = rnd.choice(["", " " + rnd.choice(LABELS), " rgb(1, 2, 3)"])
            out.append("  " * len(stack) + kw + arg)
            stack.append(kw)
        elif r < 0.17 and stack:
            stack.pop()
            out.append("  " * len(stack) + "end")
        elif r < 0.2 and not stack:
            color = rnd.choice(["", " rgb(9,9,9)", " rgba(1, 2, 3, 0.5)", " transparent", " Aqua"])
            title = rnd.choice(["", " Team", " Big team"])
            out.append(f"box{color}{title}")
            for _ in range(rnd.randint(0, 2)):
                out.append(f"  {rnd.choice(['participant', 'actor'])} {_id(rnd)}{rnd.choice(['', ' as Box member'])}")
            if rnd.random() < 0.9:
                out.append("end")
        else:
            out.append("  " * len(stack) + _line(rnd, stack[-1] if stack else None))
    if rnd.random() < 0.9:
        out += ["end"] * len(stack)
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
        parsed = to_js_json(parse_sequence(dsl))
    except YamlError:
        with pytest.raises(Exception, match=r".+"):
            bridge.parse("sequence", dsl)
        return found
    reference = bridge.parse("sequence", dsl)
    if canonical_json(parsed) != canonical_json(reference):
        found.append("parse")
    if "model" in parsed:
        model = json.loads(json.dumps(parsed["model"]))
        if serialize_sequence(model) != bridge.serialize("sequence", model):
            found.append("serialize")
    return found


@pytest.mark.parametrize("seed", [5, 15, 25, 35])
def test_native_sequence_matches_the_bridge_on_generated_diagrams(bridge: DiagramBridge, seed: int) -> None:
    rnd = random.Random(seed)
    failures: list[str] = []
    parsed_ok = 0
    for index in range(75):
        dsl = diagram(rnd)
        if "model" in parse_sequence(dsl):
            parsed_ok += 1
        found = _differences(bridge, dsl)
        if found:
            failures.append(f"seed={seed} index={index} differs in {found}:\n{dsl!r}")
    assert not failures, "\n\n".join(failures[:3])
    assert parsed_ok >= 5, "the generator should produce some diagrams that parse"
