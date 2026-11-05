"""canvas-1bty.15.1: parity fuzz. Seeded, generated flowcharts through the native Python diagram-core and through
the TypeScript one (the bridge): detect, parse, serialize, portable (both modes) must be identical.

Needs Node and the bridge bundle (skips without, like the other bridge tests). A failure shows the diagram; the
seed and the index in the failure reproduce it.
"""

# ruff: noqa: S311, E501 - a seeded generator, not cryptography; long literal tables
from __future__ import annotations

import json
import random
from collections.abc import Iterator

import pytest

from canvas_api.diagram_core import canonical_json
from canvas_api.diagram_core.detect import detect_dsl_family
from canvas_api.diagram_core.flowchart import parse_flowchart, serialize_flowchart
from canvas_api.diagram_core.jsvalues import to_js_json
from canvas_api.diagram_core.jsyaml import YamlError
from canvas_api.diagram_core.portable import to_portable_mermaid
from tests.diagram_bridge import DiagramBridge

IDS = ["A", "B", "C", "n1", "n2", "Start", "end_1", "x", "_q", "10", "2", "constructor", "toString", "__proto__"]
SHAPES = [
    ("[", "]"),
    ("(", ")"),
    ("((", "))"),
    ("{", "}"),
    ("[(", ")]"),
    ("([", "])"),
    ("[[", "]]"),
    ("(((", ")))"),
    ("{{", "}}"),
    ("[/", "/]"),
    ("[\\", "\\]"),
    ("[/", "\\]"),
    ("[\\", "/]"),
    (">", "]"),
]
LABELS = [
    "Label",
    "two words",
    "Order: validate",
    "a<br/>b",
    "a <br> b",
    "x|y",
    "émoji 🎨",
    "very long label that should wrap across several lines of the node box",
    "end",
    "A-->B",
    "#hash",
    "it's",
    'say "hi"',
    "1",
    "  spaced  ",
]
CONN = ["-->", "---", "-.->", "-.-", "==>", "===", "<-->", "<-.->", "<==>", "~~~"]
# canvas-sfz7: longer links, and near misses that aren't links.
CONN += [
    "--->",
    "----",
    "-..->",
    "-...-",
    "===>",
    "=====",
    "<--->",
    "<-..->",
    "<====>",
    "~~~~",
    "--",
    "<--",
    "-.",
    "=>",
]
INLINE_CLOSE = {
    "--": ["-->", "--->", "---", "----"],
    "-.": [".->", "..->", ".-", "...-"],
    "==": ["==>", "===>", "===", "===="],
}
TRICKY_EDGES = [
    "A[x]e1@--> B",
    "Ae1@--> B",
    "A((c))e2@-.-> B{d}e3@==> C",
    "A@{ shape: bpmn-gateway }e1@--> B",
    "E --> F ---> G",
    "A --> b c --> B",
    "A ==> x y ==> B",
    "A -.-> x y .-> B",
    "A -..- x .-> B",
    "A -- a --> B --> C",
    "A --- x --> B",
    "A -- x ---> B --> C",
    "A -.- x .-> B",
]
CLASSES = ["primary", "kind_a", "k2"]
# canvas-8wxq: Mermaid 11.3+ `@{ … }` blocks and edge ids.
SHAPE_NAMES = [
    "bpmn-start",
    "bpmn-gateway",
    "bpmn-annotation",
    "rect",
    "cyl",
    "database",
    "diam",
    "doc",
    "cloud",
    "fork",
    "lean-l",
    "trap-t",
    "odd",
    "unknown-x",
    "Hex",
]
LABEL_VALUES = [
    '"Text"',
    r'"say \"hi\""',
    r'"back\\slash"',
    r'"line\nbreak"',
    '"a, b"',
    '"{x}"',
    '"A-->B"',
    "'it''s'",
    "''",
]
BARE_VALUES = ["Bare text", "42", "1.50", "-0", "true", "0.000001", "1234567890", "12.1234567"]
DATA_ENTRIES = [
    lambda r: f"shape: {r.choice(SHAPE_NAMES)}",
    lambda r: f"label: {r.choice(LABEL_VALUES + BARE_VALUES)}",
    lambda r: 'icon: "fa:user"',
    lambda r: (
        f'img: "{r.choice(["https://x.example/a.png", "/a.png", "https://y.example/b.svg", "javascript:alert(1)"])}"'
    ),
    lambda r: f"{r.choice(['h', 'w'])}: {r.choice(['60', '0.5', 'big', '0.000001', '-0', '123456789.123456'])}",
    lambda r: f"{r.choice(['animate', 'flag'])}: {r.choice(['true', 'false'])}",
    lambda r: f"{r.choice(['curve', 'animation'])}: {r.choice(['linear', 'fast', '"natural"'])}",
    lambda r: f"step: {r.randint(-1, 3)}",
    lambda r: r.choice(["constructor: 1", "__proto__: 2"]),
]
BAD_ENTRIES = ["shape: 1", "shape: true", 'shape: "two words"', "shape: -x", "shape", "label:", "9key: x", "a: b c: d"]


def shape_data(rnd: random.Random) -> str:
    entries = [rnd.choice(DATA_ENTRIES)(rnd) for _ in range(rnd.randint(0, 3))]
    if rnd.random() < 0.08:
        entries.insert(rnd.randint(0, len(entries)), rnd.choice(BAD_ENTRIES))
    return "@{" + rnd.choice([" ", "", "  "]) + ", ".join(entries) + rnd.choice([" }", "}"])


def edge_id(rnd: random.Random) -> str:
    r = rnd.random()
    # Mermaid 12.3: no space is fine after a shape (`A[x]e1@-->`), not after a bare id (`Ae1@` is one name).
    return f" e{rnd.randint(1, 3)}@" if r < 0.25 else f"e{rnd.randint(1, 3)}@" if r < 0.33 else " "


def ident(rnd: random.Random) -> str:
    return rnd.choice(IDS)


def token(rnd: random.Random) -> str:
    i = ident(rnd)
    if rnd.random() < 0.15:
        return i + (":::" + rnd.choice(CLASSES) if rnd.random() < 0.2 else "") + shape_data(rnd)
    if rnd.random() < 0.35:
        o, c = rnd.choice(SHAPES)
        i += f"{o}{rnd.choice(LABELS)}{c}"
    if rnd.random() < 0.1:
        i += ":::" + rnd.choice(CLASSES)
    return i


def line(rnd: random.Random) -> str:
    r = rnd.random()
    if r < 0.25:
        return token(rnd)
    if r < 0.45:
        return f"{token(rnd)}{edge_id(rnd)}{rnd.choice(CONN)} {token(rnd)}"
    if r < 0.52:
        return f"{token(rnd)}{edge_id(rnd)}{rnd.choice(CONN)}|{rnd.choice(LABELS)}| {token(rnd)}"
    if r < 0.57:
        return f"{token(rnd)}{edge_id(rnd)}-- {rnd.choice(LABELS)} --> {token(rnd)}"
    if r < 0.6:
        return f"{token(rnd)} -. {rnd.choice(LABELS)} .-> {token(rnd)}"
    if r < 0.63:
        opener = rnd.choice(list(INLINE_CLOSE))
        if rnd.random() < 0.5:
            return rnd.choice(TRICKY_EDGES)
        return (
            f"{token(rnd)}{edge_id(rnd)}{opener} {rnd.choice(LABELS)} {rnd.choice(INLINE_CLOSE[opener])} {token(rnd)}"
        )
    if r < 0.68:
        return f"{token(rnd)}{edge_id(rnd)}{rnd.choice(CONN)} {token(rnd)}{edge_id(rnd)}{rnd.choice(CONN)} {token(rnd)}"
    if r < 0.72:
        return f"{token(rnd)} {rnd.choice(CONN)} {token(rnd)} & {token(rnd)}"
    if r < 0.75:
        return f"style {ident(rnd)} fill:#{rnd.randint(0, 0xFFFFFF):06x},stroke:#333,stroke-width:{rnd.choice(['2px', '1.5', 'x', ''])}"
    if r < 0.78:
        return f"classDef {rnd.choice(CLASSES)} fill:#f9f,stroke-dasharray: 5 5;"
    if r < 0.8:
        return f"class {ident(rnd)},{ident(rnd)} {rnd.choice(CLASSES)}"
    if r < 0.82:
        return f"{ident(rnd)}:::{rnd.choice(CLASSES)}"
    if r < 0.84:
        return f"linkStyle {rnd.choice(['default', '0', '0,1', '5'])} stroke:#f00,stroke-width:3px"
    if r < 0.86:
        return (
            f'click {ident(rnd)} href "{rnd.choice(["https://x.example/a", "/docs/x", "javascript:alert(1)", " javascript:x", "mailto:a@b", "http://", "x.html"])}"'
            + rnd.choice(["", ' "tip"', ' "tip" _blank', " _blank"])
        )
    if r < 0.87:
        return f"click {ident(rnd)} call fn()"
    if r < 0.88:
        return "title " + rnd.choice(LABELS)
    if r < 0.89:
        return "accTitle: " + rnd.choice(LABELS)
    if r < 0.9:
        return "accDescr: " + rnd.choice(LABELS)
    if r < 0.91:
        return "%% a comment"
    if r < 0.92:
        return f"{token(rnd)} --> {token(rnd)} %% trailing"
    if r < 0.93:
        return "%%{init: {'theme': 'dark'}}%%"
    if r < 0.955:
        return f"{rnd.choice([ident(rnd), 'e1', 'e2', 'e3', 'S1'])}{shape_data(rnd)}"
    if r < 0.96:
        return "this is not valid ;;"
    return ""


def diagram(rnd: random.Random) -> str:
    out = []
    if rnd.random() < 0.3:
        ids = rnd.sample(IDS, rnd.randint(1, 5))
        fm = {"canvas": {"positions": {i: {"x": rnd.randint(0, 900), "y": rnd.choice([40, 40.5, 120])} for i in ids}}}
        if rnd.random() < 0.5:
            fm["canvas"]["styles"] = {ids[0]: {"fillColor": "#abcdef", "strokeWidth": 2}}
        if rnd.random() < 0.3:
            fm["canvas"]["containers"] = {"S1": {"x": 10, "y": 20, "width": 300, "height": 200}}
        if rnd.random() < 0.2:
            fm["canvas"]["icons"] = {
                ids[0]: {"libraryId": "aws-icons", "libraryVersion": "2024.1-placeholder", "iconId": "ec2"}
            }
        if rnd.random() < 0.2:
            fm["canvas"]["legend"] = {
                "visible": rnd.choice([True, False]),
                "title": "Key",
                "position": {"x": "10", "y": 20},
                "hidden": ["kind:a", 3],
                "labels": {"kind:a": "A!", "b": ""},
                "extra": [
                    {"id": "e1", "label": "Thing", "sample": {"kind": "shape", "shape": "rectangle", "fill": "#fff"}},
                    {"id": "e2", "label": "L", "sample": {"kind": "line", "arrow": "both"}},
                    {"bad": 1},
                ],
            }
        out += ["---", json.dumps(fm), "---"]
    if rnd.random() < 0.95:
        out.append(rnd.choice(["flowchart TD", "graph LR", "flowchart rl", "flowchart BT", "FLOWCHART TB"]))
    depth = 0
    for _ in range(rnd.randint(0, 14)):
        r = rnd.random()
        if r < 0.08:
            out.append(f"subgraph S{rnd.randint(1, 3)}" + rnd.choice(["", " [Group label]", "[x]"]))
            depth += 1
        elif r < 0.14 and depth:
            out.append("end")
            depth -= 1
        elif r < 0.16 and depth:
            out.append("direction " + rnd.choice(["LR", "td"]))
        else:
            out.append(("  " * depth) + line(rnd))
    out += ["end"] * depth if rnd.random() < 0.9 else []
    for _ in range(rnd.choice([0, 0, 1, 2])):
        out.append(f"e{rnd.randint(1, 3)}{shape_data(rnd)}")
    return "\n".join(out) + rnd.choice(["\n", "", "\r\n"])


@pytest.fixture(scope="module")
def bridge(bridge_url: str | None) -> Iterator[DiagramBridge]:
    if bridge_url is None:
        pytest.skip("needs node and packages/diagram-bridge/dist/bridge.mjs")
    with DiagramBridge(bridge_url) as client:
        yield client


def _differences(bridge: DiagramBridge, dsl: str) -> list[str]:
    """Names of the operations where native and the bridge disagree for this diagram."""
    found: list[str] = []
    try:
        parsed = to_js_json(parse_flowchart(dsl))
        mine_family = detect_dsl_family(dsl)
    except YamlError:
        # Bad front matter: the TypeScript side throws too (the bridge reports an error).
        with pytest.raises(Exception, match=r".+"):
            bridge.detect_and_parse(dsl, "flowchart")
        return found
    reference = bridge.detect_and_parse(dsl, "flowchart")
    if mine_family != bridge.detect(dsl):
        found.append("detect")
    if canonical_json(parsed) != canonical_json({k: v for k, v in reference.items() if k != "family"}):
        found.append("parse")
    if "model" in parsed:
        # The model as it crosses the bridge (JSON: a NaN is null), serialized by both.
        model = json.loads(json.dumps(parsed["model"]))
        if serialize_flowchart(model) != bridge.serialize("flowchart", model):
            found.append("serialize")
        # Edited in Canvas after reading: shapes changed, odd labels, and edge ids and options the parser would
        # refuse (a model can be built without it).
        for index, node in enumerate(model["nodes"]):
            node["shape"] = ["hexagon", "rectangle", "icon", "cylinder", "fork-bar"][index % 5]
            if index % 3 == 0:
                node["label"] = 'cr\r "q" \\ end'
            if index % 4 == 1:
                node["mermaidData"] = {"img": "javascript:x", "9bad": 1, "w": 1e-7, "ok": "yes"}
        for index, edge in enumerate(model["edges"]):
            edge["mermaidId"] = ["e1", "e1", "bad id", None, "e2"][index % 5]
            edge["mermaidData"] = {"animate": True, "n": 0.000001} if index % 2 else None
            edge["mermaidLength"] = [3, None, 0, 2.5, 1001, "4", True, 1000, 2.0][index % 9]
        if serialize_flowchart(model) != bridge.serialize("flowchart", model):
            found.append("serialize-reshaped")
        if to_portable_mermaid(dsl, False) != bridge.portable(dsl):
            found.append("portable")
        if to_portable_mermaid(dsl, True) != bridge.portable(dsl, strip_front_matter=True):
            found.append("portable-strip")
    return found


@pytest.mark.parametrize("seed", [11, 22, 33, 44])
def test_native_flowchart_matches_the_bridge_on_generated_diagrams(bridge: DiagramBridge, seed: int) -> None:
    rnd = random.Random(seed)
    failures: list[str] = []
    for index in range(75):
        dsl = diagram(rnd)
        found = _differences(bridge, dsl)
        if found:
            failures.append(f"seed={seed} index={index} differs in {found}:\n{dsl!r}")
    assert not failures, "\n\n".join(failures[:3])


HEADERS = [
    "flowchart TD",
    "graph lr",
    "C4Dynamic",
    "sequenceDiagram",
    "erDiagram",
    "classDiagram",
    "architecture-beta",
    "stateDiagram-v2",
    "pie",
]
BEFORE_HEADER = [
    "",
    "%%{init: {'theme': 'dark'}}%%",
    "  %%{init: {}}%%  ",
    "%%{x}%%\n%%{y}%%",
    "%% a comment",
    "%%{not closed",
    "%%{a\u2028b}%%",
    "%%{}%%x",
    "\n\n%%{init: {}}%%\n",
]


@pytest.mark.parametrize("header", HEADERS)
def test_detection_passes_over_config_directives_as_typescript_does(bridge: DiagramBridge, header: str) -> None:
    """canvas-zayd: a `%%{...}%%` line before the header is passed over; a comment or anything else isn't."""
    for before in BEFORE_HEADER:
        for front_matter in ("", "---\ncanvas: {}\n---\n"):
            dsl = f"{front_matter}{before}\n{header}\n"
            assert detect_dsl_family(dsl) == bridge.detect(dsl), repr(dsl)
