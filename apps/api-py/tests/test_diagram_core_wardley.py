"""canvas-4h1j: Mermaid Wardley maps, answered by the native Python diagram-core (wardley.py, wardley_render.py).

The golden corpus cases are run by test_diagram_core_corpus_native.py (every file, the drawing included). Here: a
seeded fuzz of messy Wardley maps comparing native and the TypeScript bridge -- parse, the portable export,
serialize (as read, with elements moved as the editor would, and with the Wardley data stripped as a generic edit
leaves it) and the drawing (skips without Node).
"""

# ruff: noqa: S311 - a seeded generator, not cryptography
from __future__ import annotations

import json
import random
from collections.abc import Iterator
from typing import Any

import pytest

from canvas_api.diagram_core import DiagramCore, canonical_json
from canvas_api.diagram_core.jsvalues import to_js_json
from canvas_api.diagram_core.jsyaml import YamlError
from canvas_api.diagram_core.wardley import parse_wardley, serialize_wardley, wardley_name, wardley_number
from tests.diagram_bridge import DiagramBridge

core = DiagramCore()

NAMES = [
    "Tea",
    "Cup of Tea",
    "Hot Water",
    "end-user",
    "notebook",
    '"3D Printer"',
    '"Café"',
    "'single q'",
    '"Say \\"hi\\""',
    "R&D (core)",
    "_x-1",
    "constructor",
    '"__proto__"',
    "Builder",
    "Power",
    "Kettle",
]
NUMS = ["0.0", "0.05", "0.5", "0.79", "1.0", "35.0", "99.99", "100.0", "150.0", "1", ".5", "0.123456789"]
GOOD_NUMS = ["0.0", "0.05", "0.5", "0.79", "1.0", "35.0", "0.333", "62.5"]
TEXTS = ['"a note"', "'single'", '"with; semi"', '"émoji 🎨"', '"x %% y"', "unquoted"]
STAGES = ["Genesis", "Custom Built", "Product", '"Q / R"', "_s", "Commodity", "1st"]


def _num(rnd: random.Random) -> str:
    return rnd.choice(GOOD_NUMS) if rnd.random() < 0.9 else rnd.choice(NUMS)


def _pair(rnd: random.Random) -> str:
    return f"[{_num(rnd)}, {_num(rnd)}]" if rnd.random() < 0.95 else rnd.choice(["[0.5,0.5]", "[ 0.5 , 0.5 ]", "[0.5]"])


def _label(rnd: random.Random) -> str:
    if rnd.random() < 0.7:
        return ""
    return rnd.choice([" label [10, -5]", " label[-3,4]", " label [ - 20 , 12 ]", " label [1.5, 2]"])


def _statement(rnd: random.Random) -> list[str]:
    r = rnd.random()
    name = rnd.choice(NAMES)
    if r < 0.25:
        strategy = rnd.choice(["", "", " (build)", " (buy)", " (outsource)", " (market)", " (ecosystem)"])
        inertia = rnd.choice(["", "", " inertia", " (inertia)"])
        tail = f"{_label(rnd)}{strategy}{inertia}" if rnd.random() < 0.95 else f"{strategy}{_label(rnd)}"
        return [f"component {name} {_pair(rnd)}{tail}"]
    if r < 0.32:
        return [f"anchor {name} {_pair(rnd)}"]
    if r < 0.55:
        arrow = rnd.choice(["->", "->", "-->", "-.->", ">", "", "+'flow'>", "+'x'<>", "+''<", "-.-"])
        port = rnd.choice(["", "", "", " +>", " +<", " +<>"])
        to_port = rnd.choice(["", "", "", " +>"])
        label = rnd.choice(["", "", "; reason", "; keep %% this", ";"])
        return [f"{name}{port} {arrow} {rnd.choice(NAMES)}{to_port}{label}"]
    if r < 0.62:
        return [f"evolve {name} {_num(rnd)}"]
    if r < 0.7:
        body = [f"  component {rnd.choice(NAMES)} [{_num(rnd)}]{_label(rnd)}" for _ in range(rnd.randint(0, 3))]
        close = ["}"] if rnd.random() < 0.95 else []
        return [f"pipeline {name} {{", *body, *close]
    if r < 0.76:
        return [f"note {rnd.choice(TEXTS)} {_pair(rnd)}"]
    if r < 0.8:
        return [rnd.choice([f"annotations {_pair(rnd)}", "annotations [1, 0]"])]
    if r < 0.85:
        return [f"annotation {rnd.randint(0, 4)},{_pair(rnd)} {rnd.choice(TEXTS)}"]
    if r < 0.89:
        return [f"{rnd.choice(['accelerator', 'deaccelerator'])} {name} {_pair(rnd)}"]
    if r < 0.92:
        stages = rnd.sample(STAGES, rnd.randint(1, 4))
        parts = [s + rnd.choice(["", "", "@0.25", "@1.0", " / Second"]) for s in stages]
        return [f"evolution {' -> '.join(parts)}"]
    if r < 0.94:
        return [rnd.choice(["size [1100, 800]", "size [800, 500]", "size [1100.5, 800]", "size [200, 96]"])]
    if r < 0.97:
        return [
            rnd.choice(["title A map", "title", "accTitle: t", "accDescr: d", "accDescr {", "accDescr { inline }", "}"])
        ]
    return [rnd.choice(["%% comment", "", "market M [0.5, 0.5]", "A B", "component Tea [0.5, 0.5] %% trailing"])]


def _map(rnd: random.Random) -> str:
    out: list[str] = []
    if rnd.random() < 0.15:
        out += ["---", json.dumps({"title": rnd.choice(["Front", "émoji 🎨"])}), "---"]
    if rnd.random() < 0.1:
        out.append('%%{init: {"theme": "neutral"}}%%')
    out.append(rnd.choice(["wardley-beta", "wardley-beta", "wardley-beta", "  wardley-beta  ", "Wardley-Beta"]))
    # Mostly components first, so links and pipelines have something to name.
    for _ in range(rnd.randint(0, 5)):
        out.append(f"component {rnd.choice(NAMES)} [{rnd.choice(GOOD_NUMS)}, {rnd.choice(GOOD_NUMS)}]")
    # Half the maps keep only the statements that leave them readable, so saving and drawing get exercised too.
    valid_only = rnd.random() < 0.5
    for _ in range(rnd.randint(0, 14)):
        lines = [f"  {line}" if rnd.random() < 0.3 else line for line in _statement(rnd)]
        if valid_only and "model" not in parse_wardley("\n".join([*out, *lines]) + "\n"):
            continue
        out += lines
    return "\n".join(out) + rnd.choice(["\n", "", "\r\n"])


def _moved(model: dict[str, Any], rnd: random.Random) -> dict[str, Any]:
    """Some nodes dragged, renamed or added as a generic edit would (no Wardley data)."""
    edited = json.loads(json.dumps(model))
    for node in edited["nodes"]:
        r = rnd.random()
        if r < 0.3:
            node["position"] = {"x": rnd.uniform(-50, 1200), "y": rnd.choice([rnd.uniform(-50, 900), 300])}
        elif r < 0.4:
            node["label"] = rnd.choice(["Renamed", "notebook", "a/b", "  spaced  "])
        elif r < 0.45:
            node.pop("wardley", None)
    if rnd.random() < 0.3:
        edited["nodes"].append({"id": "n9", "label": "Added", "shape": "circle", "position": {"x": 400, "y": 250}})
    for edge in edited["edges"]:
        if rnd.random() < 0.2:
            edge["lineStyle"] = rnd.choice(["dotted", "solid"])
        if rnd.random() < 0.1:
            edge.pop("wardley", None)
    return edited


@pytest.fixture(scope="module")
def bridge(bridge_url: str | None) -> Iterator[DiagramBridge]:
    if bridge_url is None:
        pytest.skip("needs node and packages/diagram-bridge/dist/bridge.mjs")
    with DiagramBridge(bridge_url) as client:
        yield client


def _differences(bridge: DiagramBridge, dsl: str, rnd: random.Random) -> list[str]:
    found: list[str] = []
    try:
        parsed = to_js_json(parse_wardley(dsl))
    except YamlError:
        with pytest.raises(Exception, match=r".+"):
            bridge.detect_and_parse(dsl, "wardley")
        return found
    reference = bridge.detect_and_parse(dsl, "wardley")
    if canonical_json(parsed) != canonical_json({k: v for k, v in reference.items() if k != "family"}):
        found.append("parse")
        return found
    if core.portable(dsl, strip_front_matter=True) != bridge.portable(dsl, strip_front_matter=True):
        found.append("portable")
    if "model" in parsed:
        model = json.loads(json.dumps(parsed["model"]))
        if serialize_wardley(model) != bridge.serialize("wardley", model):
            found.append("serialize")
        if core.render_svg(model) != bridge.render_svg(model):
            found.append("render")
        edited = _moved(model, rnd)
        if serialize_wardley(edited) != bridge.serialize("wardley", edited):
            found.append("serialize (edited)")
        if core.render_svg(edited) != bridge.render_svg(edited):
            found.append("render (edited)")
    return found


@pytest.mark.parametrize("seed", [5, 17, 29, 43, 61])
def test_native_wardley_matches_the_bridge_on_generated_maps(bridge: DiagramBridge, seed: int) -> None:
    rnd = random.Random(seed)
    failures: list[str] = []
    parsed = 0
    for index in range(80):
        dsl = _map(rnd)
        if "model" in parse_wardley(dsl):
            parsed += 1
        found = _differences(bridge, dsl, rnd)
        if found:
            failures.append(f"seed={seed} index={index} differs in {found}:\n{dsl!r}")
    assert not failures, f"{len(failures)} differ; first:\n" + "\n\n".join(failures[:3])
    # The generator must reach both outcomes.
    assert 10 < parsed < 75, parsed


@pytest.mark.parametrize(
    ("name", "written"),
    [
        ("Tea", "Tea"),
        ("Cup of Tea", "Cup of Tea"),
        ("end-user", "end-user"),
        ("notebook", '"notebook"'),
        ("Builder", "Builder"),
        ("3D Printer", '"3D Printer"'),
        ("Node.js", '"Node.js"'),
        ("Café", '"Café"'),
        ('Say "hi"', '"Say \\"hi\\""'),
        ("_private", '"_private"'),
        ("A->B", '"A->B"'),
    ],
)
def test_names_are_quoted_only_when_mermaid_would_misread_them(name: str, written: str) -> None:
    assert wardley_name(name) == written


@pytest.mark.parametrize(
    ("value", "written"), [(0.5, "0.5"), (1.0, "1.0"), (0, "0.0"), (35.0, "35.0"), (1e-7, "0.0000001")]
)
def test_coordinates_are_always_written_as_decimals(value: float, written: str) -> None:
    assert wardley_number(value) == written


def test_a_moved_component_is_written_at_its_new_place() -> None:
    model = parse_wardley("wardley-beta\ncomponent A [0.5, 0.5]\ncomponent B [35.0, 50.0]\n")["model"]
    model["nodes"][0]["position"] = {"x": 48 + 0.25 * 804, "y": 600 - 48 - 0.75 * 504}
    text = serialize_wardley(model)
    assert "component A [0.75, 0.25]" in text
    assert "component B [35.0, 50.0]" in text
