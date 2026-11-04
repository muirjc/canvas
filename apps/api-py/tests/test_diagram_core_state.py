"""canvas-bnnh: Mermaid state diagrams, answered by the native Python diagram-core (state.py).

The golden corpus cases are run by test_diagram_core_corpus_native.py (every file, the drawing included). Here: a
seeded fuzz of messy state diagrams comparing native and the TypeScript bridge -- parse, serialize, the drawing
(after Auto Layout, so geometry varies) and the portable export (skips without Node).
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
from canvas_api.diagram_core.state import parse_state, serialize_state
from tests.diagram_bridge import DiagramBridge

core = DiagramCore()

IDS = ["A", "Still", "Moving", "b2", "Ébauche", "x.y", "constructor", "__proto__", "s_1", "Crash", "[*]", "[*]"]
LABELS = ["push", "if n < 0", " spaced ", "émoji 🎨", "a:b", "", "x;y", 'say "hi"', "a%%b"]
CLASSES = ["hot", "cold", "bad"]
PROPS = [
    "fill:#f00",
    "stroke:#00f,stroke-width:2px",
    "fill:white;",
    "font-style:italic",
    "stroke-dasharray:5 5",
    "fill",
]


def _id(rnd: random.Random, states_only: bool = False) -> str:
    choice = rnd.choice(IDS)
    return rnd.choice(IDS[:-2]) if states_only and choice == "[*]" else choice


def _statement(rnd: random.Random, depth: int) -> list[str]:
    r = rnd.random()
    pad = "  " * (depth + 1)
    if r < 0.35:
        cls = f":::{rnd.choice(CLASSES)}" if rnd.random() < 0.1 else ""
        label = f" : {rnd.choice(LABELS)}" if rnd.random() < 0.4 else rnd.choice(["", ":"])
        return [f"{pad}{_id(rnd)}{cls} --> {_id(rnd)}{label}"]
    if r < 0.42:
        return [f'{pad}state "{rnd.choice(LABELS)}" as {_id(rnd, True)}' + rnd.choice(["", " : more"])]
    if r < 0.48:
        return [f"{pad}{_id(rnd, True)} : {rnd.choice(LABELS) or 'text'}"]
    if r < 0.53:
        kind = rnd.choice(["<<choice>>", "<<fork>>", "<<join>>", "[[choice]]", "<<CHOICE>>", "<<history>>"])
        return [f"{pad}state {_id(rnd, True)} {kind}"]
    if r < 0.6 and depth < 3:
        name = rnd.choice(["Comp", "Inner", "Active", "Moving", "A"])
        head = rnd.choice([f"state {name} {{", f'state "Named {name}" as {name} {{'])
        body: list[str] = []
        for _ in range(rnd.randint(0, 5)):
            body += _statement(rnd, depth + 1)
            if rnd.random() < 0.12:
                body.append(f"{pad}  --")
        if rnd.random() < 0.2:
            body.insert(0, f"{pad}  direction {rnd.choice(['LR', 'TB', 'rl'])}")
        return [f"{pad}{head}", *body, *([f"{pad}}}"] if rnd.random() < 0.93 else [])]
    if r < 0.65:
        side = rnd.choice(["left", "right", "LEFT"])
        if rnd.random() < 0.5:
            return [f"{pad}note {side} of {_id(rnd, True)} : {rnd.choice(LABELS) or 'n'}"]
        return [f"{pad}note {side} of {_id(rnd, True)}", f"{pad}  line one: x", f"{pad}  two", f"{pad}end note"]
    if r < 0.69:
        return [f"{pad}classDef {rnd.choice(CLASSES)} {rnd.choice(PROPS)}"]
    if r < 0.72:
        return [f"{pad}class {_id(rnd, True)}, {_id(rnd, True)} {rnd.choice(CLASSES)}"]
    if r < 0.75:
        return [f"{pad}style {_id(rnd, True)},{_id(rnd, True)} {rnd.choice(PROPS)}"]
    if r < 0.78:
        return [f"{pad}{_id(rnd)}:::{rnd.choice(CLASSES)}"]
    if r < 0.81:
        href = rnd.choice(["https://example.org", "/docs/x", "javascript:alert(1)"])
        return [
            rnd.choice([f'{pad}click {_id(rnd, True)} href "{href}"', f'{pad}click {_id(rnd, True)} "{href}" "tip"'])
        ]
    if r < 0.83:
        return [f"{pad}direction " + rnd.choice(["LR", "tb", "Rl", "TD"])]
    if r < 0.86:
        return [rnd.choice([f"{pad}accTitle: t", f"{pad}accDescr: d", f"{pad}accDescr {{", f"{pad}title T"])]
    if r < 0.89:
        return [f"{pad}%% comment", f"{pad}# hash", f"{pad}{_id(rnd, True)} %% trailing"]
    if r < 0.91:
        return [rnd.choice([f"{pad}hide empty description", f"{pad}scale 600 width", f"{pad}%%{{init: {{}}}}%%"])]
    if r < 0.94:
        return [rnd.choice([f"{pad}}}", f"{pad}--", f"{pad}A -> B", f"{pad}[*]", f"{pad}click A call x()"])]
    return [""]


def _diagram(rnd: random.Random) -> str:
    out: list[str] = []
    if rnd.random() < 0.35:
        fm: dict[str, Any] = {}
        if rnd.random() < 0.5:
            fm["title"] = rnd.choice(["Lifecycle", "émoji 🎨"])
        if rnd.random() < 0.7:
            ids = ["A", "Still", "root_start", "Comp", "note1", "Active__region1"]
            fm["canvas"] = {
                "positions": {i: {"x": rnd.randint(0, 900), "y": rnd.choice([40, 40.5])} for i in rnd.sample(ids, 3)},
                "containers": {"Comp": {"x": 10, "y": 20, "width": 300, "height": rnd.choice([200, None])}},
                "styles": {"Still": {"fillColor": "#abcdef"}},
                "edgeStyles": {"e1": {"strokeColor": "#123456"}},
                "pinned": ["A", "ghost"],
            }
        out += ["---", json.dumps(fm), "---"]
    out.append(rnd.choice(["stateDiagram-v2", "stateDiagram", "statediagram-v2"]))
    for _ in range(rnd.randint(0, 14)):
        out += _statement(rnd, 0)
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
        parsed = to_js_json(parse_state(dsl))
    except YamlError:
        with pytest.raises(Exception, match=r".+"):
            bridge.detect_and_parse(dsl, "state")
        return found
    reference = bridge.detect_and_parse(dsl, "state")
    if canonical_json(parsed) != canonical_json({k: v for k, v in reference.items() if k != "family"}):
        found.append("parse")
        return found
    if core.portable(dsl, strip_front_matter=True) != bridge.portable(dsl, strip_front_matter=True):
        found.append("portable")
    if "model" in parsed:
        model = json.loads(json.dumps(parsed["model"]))
        if serialize_state(model) != bridge.serialize("state", model):
            found.append("serialize")
        # As the editor or the AI builds them: some roles and connector scopes missing (canvas-bnnh part 2).
        stripped = json.loads(json.dumps(model))
        for element in [*stripped["nodes"], *stripped["containers"], *stripped["edges"]]:
            if len(json.dumps(element)) % 3 == 0:
                element.pop("role", None)
                element.pop("containerId", None)
        if serialize_state(stripped) != bridge.serialize("state", stripped):
            found.append("serialize (roles/scopes stripped)")
        if core.render_svg(model) != bridge.render_svg(model):
            found.append("render")
        laid = json.loads(json.dumps(to_js_json(core.auto_layout(model, "LR", "state"))))
        if canonical_json(laid) != canonical_json(bridge.auto_layout(model, "LR", "state")):
            found.append("auto-layout")
        elif core.render_svg(laid) != bridge.render_svg(laid):
            found.append("render after Auto Layout")
    return found


@pytest.mark.parametrize("seed", [3, 11, 23, 37, 59])
def test_native_state_matches_the_bridge_on_generated_diagrams(bridge: DiagramBridge, seed: int) -> None:
    rnd = random.Random(seed)
    failures: list[str] = []
    for index in range(80):
        dsl = _diagram(rnd)
        found = _differences(bridge, dsl)
        if found:
            failures.append(f"seed={seed} index={index} differs in {found}:\n{dsl!r}")
    assert not failures, f"{len(failures)} differ; first:\n" + "\n\n".join(failures[:3])
