"""Mermaid Wardley maps (packages/diagram-core/src/dsl/wardley.ts and model/wardley-geometry.ts, canvas-4h1j).

A line-by-line port: the same regular expressions (`$` as `\\Z`, JavaScript's `.` and `\\w` spelled out), tried in
the same order, the same merging of repeated names, ids, pipeline boxes and canonical writing. Parse returns
{"model": ...} or {"errors": [...]}, never raises (bad YAML front matter excepted, as in TypeScript). See
wardley.ts for how the syntax maps onto the model.
"""

from __future__ import annotations

import math
import re
from typing import Any

from canvas_api.diagram_core.front_matter import (
    apply_frames,
    apply_links,
    join_front_matter,
    split_front_matter,
    with_frames,
    with_links,
)
from canvas_api.diagram_core.jsvalues import js_template, js_truthy
from canvas_api.diagram_core.model import create_empty_diagram_model
from canvas_api.github.jstext import JS_WHITESPACE, js_number, js_trim

__all__ = [
    "WARDLEY_DEFAULT_HEIGHT",
    "WARDLEY_DEFAULT_WIDTH",
    "WARDLEY_HEADER",
    "WARDLEY_PADDING",
    "lay_out_pipelines",
    "parse_wardley",
    "serialize_wardley",
    "wardley_coordinates_at",
    "wardley_frame",
    "wardley_name",
    "wardley_number",
    "wardley_percent",
    "wardley_pipeline_box",
    "wardley_point",
    "wardley_positions_from_coordinates",
    "wardley_x",
    "wardley_y",
]

Model = dict[str, Any]

# --- geometry (model/wardley-geometry.ts) -----------------------------------------------------------------------

WARDLEY_DEFAULT_WIDTH = 900
WARDLEY_DEFAULT_HEIGHT = 600
WARDLEY_PADDING = 48


def _js_round(x: float) -> float:
    """Math.round: halves go up (towards +Infinity)."""
    if not math.isfinite(x):
        return x
    floor = math.floor(x)
    return float(floor + 1 if x - floor >= 0.5 else floor)


def _div(a: float, b: float) -> float:
    if b == 0:
        if a == 0 or a != a:
            return math.nan
        negative = (a < 0) != (math.copysign(1.0, b) < 0)
        return -math.inf if negative else math.inf
    return a / b


def _nan(*values: float) -> bool:
    return any(v != v for v in values)


def _js_min(a: float, b: float) -> float:
    return math.nan if _nan(a, b) else min(a, b)


def _js_max(a: float, b: float) -> float:
    return math.nan if _nan(a, b) else max(a, b)


def _settings(model: Model) -> dict[str, Any]:
    value = model.get("wardley")
    return value if isinstance(value, dict) else {}


def wardley_frame(model: Model) -> dict[str, float]:
    size = _settings(model).get("size")
    size = size if isinstance(size, dict) else {}
    width = size.get("width")
    height = size.get("height")
    width = WARDLEY_DEFAULT_WIDTH if width is None else width
    height = WARDLEY_DEFAULT_HEIGHT if height is None else height
    padding = WARDLEY_PADDING
    return {
        "width": width,
        "height": height,
        "padding": padding,
        "chartWidth": width - padding * 2,
        "chartHeight": height - padding * 2,
    }


def wardley_percent(value: float) -> float:
    """Mermaid's toPercent: 0-1 is a fraction, anything above 1 is already a percentage."""
    return value * 100 if value <= 1 else value


def wardley_x(frame: dict[str, float], evolution: float) -> float:
    return frame["padding"] + (wardley_percent(evolution) / 100) * frame["chartWidth"]


def wardley_y(frame: dict[str, float], visibility: float) -> float:
    return frame["height"] - frame["padding"] - (wardley_percent(visibility) / 100) * frame["chartHeight"]


def wardley_point(frame: dict[str, float], point: dict[str, Any]) -> dict[str, float]:
    return {"x": wardley_x(frame, point["evolution"]), "y": wardley_y(frame, point["visibility"])}


def wardley_coordinates_at(frame: dict[str, float], position: dict[str, Any]) -> dict[str, float]:
    def fraction(value: float) -> float:
        return _js_min(1, _js_max(0, _js_round(value * 100) / 100))

    return {
        "visibility": fraction(_div(frame["height"] - frame["padding"] - position["y"], frame["chartHeight"])),
        "evolution": fraction(_div(position["x"] - frame["padding"], frame["chartWidth"])),
    }


# --- syntax -----------------------------------------------------------------------------------------------------

WARDLEY_HEADER = "wardley-beta"
DOT = "[^\\n\\r\\u2028\\u2029]"  # JavaScript's .
QUOTED = "\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'"
BARE = "[A-Za-z](?:[A-Za-z0-9_()&]|-(?!>))*(?:[ \\t]+[A-Za-z(](?:[A-Za-z0-9_()&]|-(?!>))*)*"
UNDERSCORE_ID = "_(?:[-A-Za-z0-9_]*[A-Za-z0-9_])?"
NAME = f"({QUOTED}|{BARE}|{UNDERSCORE_ID})"
NUM = "([0-9]+\\.[0-9]+)"
INT = "(0|[1-9][0-9]*)"
NUM_OR_INT = "([0-9]+\\.[0-9]+|0|[1-9][0-9]*)"
S = "[ \\t]*"


def _pair(value: str) -> str:
    return f"\\[{S}{value}{S},{S}{value}{S}\\]"


LABEL = f"(?:{S}label{S}\\[{S}(-?){S}{INT}{S},{S}(-?){S}{INT}{S}\\])?"
_DOTS = "[^\\n\\r\\u2028\\u2029]"

TITLE = re.compile(f"^title(?:[ \\t]+({_DOTS}*))?\\Z")
ACC_TITLE = re.compile(f"^accTitle[ \\t]*:({_DOTS}*)\\Z")
ACC_DESCR = re.compile(f"^accDescr[ \\t]*:({_DOTS}*)\\Z")
ACC_DESCR_BLOCK = re.compile(f"^accDescr[ \\t]*\\{{({_DOTS}*)\\Z")
CONFIG_DIRECTIVE = re.compile(f"^%%\\{{{_DOTS}*\\}}%%\\Z")
COMMENT_TAIL = re.compile(f"[ \\t]*%%{_DOTS}*\\Z")
SIZE = re.compile(f"^size{S}{_pair(INT)}\\Z")
EVOLUTION = re.compile(f"^evolution[ \\t]+({_DOTS}+)\\Z")
STAGE = re.compile(f"^{NAME}(?:{S}@{S}{NUM})?(?:{S}/{S}{NAME})?")
ANCHOR = re.compile(f"^anchor[ \\t]+{NAME}{S}{_pair(NUM)}\\Z")
COMPONENT = re.compile(
    f"^component[ \\t]+{NAME}{S}{_pair(NUM)}{LABEL}(?:{S}\\({S}(build|buy|outsource|market){S}\\))?"
    f"(?:{S}(inertia|\\({S}inertia{S}\\)))?\\Z"
)
PIPELINE = re.compile(f"^pipeline[ \\t]+{NAME}{S}\\{{\\Z")
PIPELINE_COMPONENT = re.compile(f"^component[ \\t]+{NAME}{S}\\[{S}{NUM}{S}\\]{LABEL}\\Z")
EVOLVE = re.compile(f"^evolve[ \\t]+{NAME}[ \\t]+{NUM}\\Z")
NOTE = re.compile(f"^note{S}({QUOTED}){S}{_pair(NUM)}\\Z")
ANNOTATIONS = re.compile(f"^annotations{S}{_pair(NUM_OR_INT)}\\Z")
ANNOTATION = re.compile(f"^annotation[ \\t]+{INT}{S},{S}{_pair(NUM_OR_INT)}{S}({QUOTED})\\Z")
ACCELERATOR = re.compile(f"^(accelerator|deaccelerator)[ \\t]+{NAME}{S}{_pair(NUM)}\\Z")
PORT = "(\\+<>|\\+>|\\+<)"
ARROW = "(->|-->|-\\.->|>|\\+'[^']*'(?:<>|<|>))"
LINK = re.compile(f"^{NAME}{S}{PORT}?{S}{ARROW}?{S}{NAME}{S}{PORT}?\\Z")
BARE_NAME = re.compile(f"^(?:{BARE})\\Z")
FLOW_ARROW = re.compile("^\\+'([^']*)'(<>|<|>)\\Z")
DECIMAL_HINT_STATEMENT = re.compile(
    "^(?:anchor|component|note|annotations?|accelerator|deaccelerator|evolve)\\b", re.ASCII
)
DECIMAL_HINT_NUMBER = re.compile("(?:^|[^0-9.])(?:\\.[0-9]|[0-9]+(?![0-9.]))")
LABEL_PART = re.compile("label[ \\t]*\\[[^\\]]*\\]")
ANNOTATION_NUMBER = re.compile("^annotation[ \\t]+[0-9]+")
LINE_BREAKS = re.compile("\\r?\\n")
_LEADING_SPACE = re.compile(f"^[{JS_WHITESPACE}]+")
_TRAILING_SPACE = re.compile(f"[{JS_WHITESPACE}]+\\Z")

RESERVED_PREFIXES = [
    "wardley-beta", "size", "evolution", "anchor", "component", "label", "inertia", "evolve", "pipeline", "note",
    "annotations", "annotation", "accelerator", "deaccelerator", "build", "buy", "outsource", "market",
    "title", "accTitle", "accDescr",
]  # fmt: skip
_ESCAPES = {"b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t", "v": "\v", "0": "\0"}
OTHER_ROLES = {"note", "annotation", "accelerator", "deaccelerator"}


def _trim_start(text: str) -> str:
    return _LEADING_SPACE.sub("", text)


def _trim_end(text: str) -> str:
    return _TRAILING_SPACE.sub("", text)


def _unquote(token: str) -> str:
    if not (token.startswith('"') or token.startswith("'")):
        return token
    out = []
    i = 1
    while i < len(token) - 1:
        c = token[i]
        if c == "\\":
            i += 1
            nxt = token[i]
            out.append(_ESCAPES.get(nxt, nxt))
        else:
            out.append(c)
        i += 1
    return "".join(out)


def _split_line(line: str) -> tuple[str, str | None]:
    quote = ""
    i = 0
    while i < len(line):
        c = line[i]
        if quote:
            if c == "\\":
                i += 1
            elif c == quote:
                quote = ""
            i += 1
            continue
        if c in ('"', "'"):
            if c == "'" and i > 0 and line[i - 1] == "+":
                close = line.find("'", i + 1)
                if close != -1:
                    i = close + 1
                    continue
            quote = c
            i += 1
            continue
        if c == ";":
            return js_trim(line[:i]), js_trim(line[i + 1 :])
        if c == "%" and line[i + 1 : i + 2] == "%":
            return js_trim(line[:i]), None
        i += 1
    return js_trim(line), None


def _offset(negative: str | None, value: str) -> float:
    return (-1 if negative else 1) * float(value)


def _out_of_range(value: float) -> bool:
    percent = wardley_percent(value)
    return percent < 0 or percent > 100


def _n(value: float) -> str:
    """`${value}` for a number."""
    return js_template(value)


def _error(lines: list[str], index: int, message: str) -> dict[str, Any]:
    return {"line": index + 1, "content": lines[index], "message": message}


def parse_wardley(dsl: str) -> dict[str, Any]:
    front_matter, body = split_front_matter(dsl)
    lines = LINE_BREAKS.split(body)
    errors: list[dict[str, Any]] = []

    def fail(index: int, message: str) -> None:
        errors.append(_error(lines, index, message))

    header_seen = False
    fm_title = front_matter.get("title") if isinstance(front_matter, dict) else None
    title: str | None = fm_title if isinstance(fm_title, str) else None
    acc_title: str | None = None
    acc_descr: str | None = None
    config_directive: str | None = None
    size: dict[str, float] | None = None
    stages: list[dict[str, Any]] | None = None
    components: list[dict[str, Any]] = []
    notes: list[dict[str, Any]] = []
    pipelines: list[dict[str, Any]] = []
    links: list[dict[str, Any]] = []
    evolves: list[dict[str, Any]] = []
    annotations_box: dict[str, float] | None = None
    annotations: list[dict[str, Any]] = []
    accelerators: list[dict[str, Any]] = []
    open_pipeline: dict[str, Any] | None = None
    open_acc_descr: list[str] | None = None

    def check_point(index: int, what: str, point: dict[str, float]) -> bool:
        for axis in ("visibility", "evolution"):
            value = point[axis]
            if _out_of_range(value):
                fail(index, f"{what} {axis} must be between 0-1 (decimal) or 0-100 (percentage). Received: {_n(value)}")
                return False
        return True

    for i, raw in enumerate(lines):
        trimmed = js_trim(raw)
        if open_acc_descr is not None:
            close = trimmed.find("}")
            if close == -1:
                open_acc_descr.append(trimmed)
                continue
            open_acc_descr.append(trimmed[:close])
            acc_descr = js_trim("\n".join(open_acc_descr))
            open_acc_descr = None
            if js_trim(trimmed[close + 1 :]):
                fail(i, 'Nothing may follow the "}" of an accDescr block')
            continue
        if not trimmed:
            continue
        if CONFIG_DIRECTIVE.match(trimmed):
            config_directive = trimmed
            continue
        if trimmed.startswith("%%"):
            if not header_seen:
                fail(i, f'Expected "{WARDLEY_HEADER}" header line')
            continue
        if not header_seen:
            if COMMENT_TAIL.sub("", trimmed, count=1) == WARDLEY_HEADER:
                header_seen = True
            else:
                fail(i, f'Expected "{WARDLEY_HEADER}" header line')
            continue

        uncommented = COMMENT_TAIL.sub("", trimmed, count=1)
        if m := TITLE.match(uncommented):
            title = js_trim(m.group(1) or "") or None
            continue
        if m := ACC_TITLE.match(uncommented):
            acc_title = js_trim(m.group(1)) or None
            continue
        if m := ACC_DESCR_BLOCK.match(trimmed):
            rest = m.group(1)
            close = rest.find("}")
            if close == -1:
                open_acc_descr = [js_trim(rest)] if js_trim(rest) else []
            else:
                acc_descr = js_trim(rest[:close]) or None
            continue
        if m := ACC_DESCR.match(uncommented):
            acc_descr = js_trim(m.group(1)) or None
            continue

        code, label = _split_line(trimmed)
        if not code:
            continue

        if open_pipeline is not None:
            if code == "}" and label is None:
                if not open_pipeline["children"]:
                    fail(i, f'Pipeline "{open_pipeline["parent"]}" needs at least one component')
                open_pipeline = None
                continue
            if label is None and (m := PIPELINE_COMPONENT.match(code)):
                evolution = float(m.group(2))
                if _out_of_range(evolution):
                    fail(
                        i,
                        f'Pipeline component "{_unquote(m.group(1))}" evolution must be between 0-1 (decimal) or'
                        f" 0-100 (percentage). Received: {_n(evolution)}",
                    )
                    continue
                child: dict[str, Any] = {"name": _unquote(m.group(1)), "evolution": evolution}
                if m.group(4) is not None:
                    child["labelOffset"] = {"x": _offset(m.group(3), m.group(4)), "y": _offset(m.group(5), m.group(6))}
                open_pipeline["children"].append(child)
                continue
            fail(
                i,
                f'Expected "component Name [evolution]" or "}}" inside pipeline "{open_pipeline["parent"]}": "{code}"',
            )
            continue

        if label is None:
            if m := SIZE.match(code):
                size = {"width": float(m.group(1)), "height": float(m.group(2))}
                continue
            if m := EVOLUTION.match(code):
                parsed = _read_stages(m.group(1))
                if isinstance(parsed, str):
                    fail(i, parsed)
                else:
                    stages = parsed
                continue
            if m := ANCHOR.match(code):
                point = {"visibility": float(m.group(2)), "evolution": float(m.group(3))}
                if check_point(i, f'Anchor "{_unquote(m.group(1))}"', point):
                    components.append({"kind": "anchor", "name": _unquote(m.group(1)), "point": point})
                continue
            if m := COMPONENT.match(code):
                point = {"visibility": float(m.group(2)), "evolution": float(m.group(3))}
                if not check_point(i, f'Component "{_unquote(m.group(1))}"', point):
                    continue
                statement: dict[str, Any] = {"kind": "component", "name": _unquote(m.group(1)), "point": point}
                if m.group(5) is not None:
                    statement["labelOffset"] = {
                        "x": _offset(m.group(4), m.group(5)),
                        "y": _offset(m.group(6), m.group(7)),
                    }
                if m.group(8):
                    statement["strategy"] = m.group(8)
                if m.group(9):
                    statement["inertia"] = True
                components.append(statement)
                continue
            if m := PIPELINE.match(code):
                open_pipeline = {"parent": _unquote(m.group(1)), "line": i, "children": []}
                pipelines.append(open_pipeline)
                continue
            if m := EVOLVE.match(code):
                target = float(m.group(2))
                if _out_of_range(target):
                    fail(
                        i,
                        f'Evolve target for "{_unquote(m.group(1))}" must be between 0-1 (decimal) or 0-100'
                        f" (percentage). Received: {_n(target)}",
                    )
                else:
                    evolves.append({"name": _unquote(m.group(1)), "target": target, "line": i})
                continue
            if m := NOTE.match(code):
                point = {"visibility": float(m.group(2)), "evolution": float(m.group(3))}
                if check_point(i, f'Note "{_unquote(m.group(1))}"', point):
                    notes.append({"text": _unquote(m.group(1)), "point": point})
                continue
            if m := ANNOTATIONS.match(code):
                point = {"visibility": float(m.group(1)), "evolution": float(m.group(2))}
                if check_point(i, "Annotations box", point) and annotations_box is None:
                    annotations_box = point
                continue
            if m := ANNOTATION.match(code):
                point = {"visibility": float(m.group(2)), "evolution": float(m.group(3))}
                if check_point(i, f"Annotation {m.group(1)}", point):
                    annotations.append({"number": float(m.group(1)), "point": point, "text": _unquote(m.group(4))})
                continue
            if m := ACCELERATOR.match(code):
                kind = m.group(1)
                point = {"visibility": float(m.group(3)), "evolution": float(m.group(4))}
                what = f'{"Accelerator" if kind == "accelerator" else "Deaccelerator"} "{_unquote(m.group(2))}"'
                if check_point(i, what, point):
                    accelerators.append({"kind": kind, "name": _unquote(m.group(2)), "point": point})
                continue
        if m := LINK.match(code):
            from_token, from_port, arrow_token, to_token, to_port = m.groups()
            if not arrow_token and not from_port and _is_bare(from_token) and _is_bare(to_token):
                fail(i, f'Could not read "{code}" as a link: put an arrow (->) between the names, or quote them')
                continue
            data: dict[str, Any] = {}
            if from_port:
                data["fromPort"] = from_port
            if arrow_token:
                flow = FLOW_ARROW.match(arrow_token)
                if flow:
                    data["flowArrow"] = {"label": flow.group(1), "flow": f"+{flow.group(2)}"}
                else:
                    data["arrow"] = arrow_token
            if to_port:
                data["toPort"] = to_port
            link: dict[str, Any] = {"from": _unquote(from_token), "to": _unquote(to_token), "data": data}
            if label:
                link["label"] = label
            links.append(link)
            continue
        if DECIMAL_HINT_STATEMENT.match(code) and DECIMAL_HINT_NUMBER.search(
            ANNOTATION_NUMBER.sub("", LABEL_PART.sub("", code, count=1), count=1)
        ):
            fail(
                i,
                f'Could not interpret line as a Wardley map statement: "{trimmed}" (coordinates are written as'
                " decimals, such as 0.5 or 1.0)",
            )
            continue
        fail(i, f'Could not interpret line as a Wardley map statement: "{trimmed}"')
    if open_pipeline is not None:
        fail(open_pipeline["line"], f'Pipeline "{open_pipeline["parent"]}" is missing its closing "}}"')
    if open_acc_descr is not None:
        errors.append({"line": len(lines), "content": "", "message": 'An accDescr block is missing its closing "}"'})
    if not header_seen and not errors:
        errors.append(
            {"line": 1, "content": lines[0] if lines else "", "message": f'Expected "{WARDLEY_HEADER}" header line'}
        )
    if errors:
        return {"errors": errors}

    model = create_empty_diagram_model("wardley")
    model["title"] = title
    model["accTitle"] = acc_title
    model["accDescr"] = acc_descr
    model["mermaidConfigDirective"] = config_directive
    settings: dict[str, Any] = {}
    if size:
        settings["size"] = size
    if stages:
        settings["stages"] = stages
    if annotations_box:
        settings["annotationsBox"] = annotations_box
    if settings:
        model["wardley"] = settings
    frame = wardley_frame(model)

    nodes: dict[str, dict[str, Any]] = {}

    def add_node(node_id: str, label: str, role: str, data: dict[str, Any]) -> dict[str, Any]:
        existing = nodes.get(node_id)
        wardley = dict(data)
        if data.get("labelOffset") is None and existing is not None and existing["wardley"].get("labelOffset"):
            wardley["labelOffset"] = existing["wardley"]["labelOffset"]
        node = {
            "id": node_id,
            "label": label,
            "shape": "circle",
            "role": role,
            "position": wardley_point(frame, data),
            "wardley": wardley,
        }
        nodes[node_id] = node
        return node

    ordered = [c for c in components if c["kind"] == "anchor"] + [c for c in components if c["kind"] == "component"]
    for statement in ordered:
        data = dict(statement["point"])
        for key in ("labelOffset", "strategy", "inertia"):
            if key in statement:
                data[key] = statement[key]
        add_node(statement["name"], statement["name"], statement["kind"], data)
    containers: list[dict[str, Any]] = []
    piped: set[str] = set()
    for pipeline in pipelines:
        parent = nodes.get(pipeline["parent"])
        line = pipeline["line"]
        if parent is None:
            return {
                "errors": [
                    _error(
                        lines,
                        line,
                        f'Pipeline "{pipeline["parent"]}" must reference an existing component with coordinates.',
                    )
                ]
            }
        if parent["id"] in piped:
            return {"errors": [_error(lines, line, f'Component "{pipeline["parent"]}" already has a pipeline')]}
        piped.add(parent["id"])
        container_id = _unique_id(f"~pipeline:{parent['id']}", nodes, containers)
        for child in pipeline["children"]:
            data = {"visibility": parent["wardley"]["visibility"], "evolution": child["evolution"]}
            if "labelOffset" in child:
                data["labelOffset"] = child["labelOffset"]
            node = add_node(f"{parent['id']}_{child['name']}", child["name"], "pipeline-component", data)
            node["containerId"] = container_id
        containers.append(
            {
                "id": container_id,
                "label": "",
                "role": "pipeline",
                "attachedNodeIds": [parent["id"]],
                "position": {"x": 0, "y": 0},
            }
        )

    def resolve(name: str) -> str:
        if name in nodes:
            return name
        for node_id, node in nodes.items():
            if node["label"] == name:
                return node_id
        return name

    edges: list[dict[str, Any]] = []
    for index, link in enumerate(links):
        edge: dict[str, Any] = {
            "id": f"e{index + 1}",
            "sourceId": resolve(link["from"]),
            "targetId": resolve(link["to"]),
        }
        if link.get("label"):
            edge["label"] = link["label"]
        if link["data"].get("arrow") == "-.->":
            edge["lineStyle"] = "dotted"
        edge["wardley"] = link["data"]
        edges.append(edge)
    for evolve in evolves:
        target_node = nodes.get(resolve(evolve["name"]))
        if target_node is None:
            return {
                "errors": [_error(lines, evolve["line"], f'evolve: there is no component named "{evolve["name"]}"')]
            }
        target_node["wardley"]["evolve"] = evolve["target"]

    extra: list[dict[str, Any]] = []

    def add_extra(base: str, role: str, label: str, data: dict[str, Any]) -> None:
        node_id = _unique_id(base, nodes, containers, extra)
        extra.append(
            {
                "id": node_id,
                "label": label,
                "shape": "circle" if role == "annotation" else "rectangle",
                "role": role,
                "position": wardley_point(frame, data),
                "wardley": data,
            }
        )

    for index, note in enumerate(notes):
        add_extra(f"~note{index + 1}", "note", note["text"], dict(note["point"]))
    for index, annotation in enumerate(annotations):
        add_extra(
            f"~annotation{index + 1}",
            "annotation",
            annotation["text"],
            {**annotation["point"], "number": annotation["number"]},
        )
    counts = {"accelerator": 0, "deaccelerator": 0}
    for item in accelerators:
        counts[item["kind"]] += 1
        add_extra(f"~{item['kind']}{counts[item['kind']]}", item["kind"], item["name"], dict(item["point"]))

    model["nodes"] = [*nodes.values(), *extra]
    model["edges"] = edges
    model["containers"] = containers
    lay_out_pipelines(model, frame)
    apply_links(front_matter, model)
    apply_frames(front_matter, model)
    return {"model": model}


def _unique_id(base: str, *taken: Any) -> str:
    def used(candidate: str) -> bool:
        return any(candidate in t if isinstance(t, dict) else any(x["id"] == candidate for x in t) for t in taken)

    candidate = base
    n = 2
    while used(candidate):
        candidate = f"{base}~{n}"
        n += 1
    return candidate


def _is_bare(token: str) -> bool:
    return not (token.startswith('"') or token.startswith("'"))


def _read_stages(text: str) -> list[dict[str, Any]] | str:
    stages: list[dict[str, Any]] = []
    rest = text
    while True:
        m = STAGE.match(rest)
        if not m:
            return f'Could not read the evolution stage "{rest}"'
        stage: dict[str, Any] = {"name": js_trim(_unquote(m.group(1)))}
        if m.group(2) is not None:
            stage["boundary"] = float(m.group(2))
        if m.group(3) is not None:
            stage["secondName"] = js_trim(_unquote(m.group(3)))
        stages.append(stage)
        rest = _trim_start(rest[len(m.group(0)) :])
        if not rest:
            break
        if not rest.startswith("->"):
            return f'Expected "->" between evolution stages, at "{rest}"'
        rest = _trim_start(rest[2:])
    if len(stages) < 2:
        return 'An evolution needs at least two stages ("A -> B")'
    return stages


def wardley_pipeline_box(
    model: Model, container: dict[str, Any], frame: dict[str, float] | None = None
) -> dict[str, Any] | None:
    children = [n for n in model["nodes"] if n.get("containerId") == container["id"]]
    if not children:
        return None
    min_x = math.inf
    max_x = -math.inf
    for child in children:
        min_x = _js_min(min_x, child["position"]["x"])
        max_x = _js_max(max_x, child["position"]["x"])
    y = children[-1]["position"]["y"]
    height = 6 * 4
    top = y - height / 2
    return {
        "x": min_x - 15,
        "y": top,
        "width": max_x - min_x + 30,
        "height": height,
        "parent": {"x": (min_x + max_x) / 2, "y": top - (6 * 1.6) / 6},
    }


def lay_out_pipelines(model: Model, frame: dict[str, float] | None = None) -> None:
    for container in model["containers"]:
        if container.get("role") != "pipeline":
            continue
        box = wardley_pipeline_box(model, container, frame)
        if box is None:
            continue
        container["position"] = {"x": box["x"], "y": box["y"]}
        container["size"] = {"width": box["width"], "height": box["height"]}


def wardley_number(value: float) -> str:
    """A decimal as wardley-beta writes coordinates (`0.5`, `1.0`; never an exponent)."""
    text = js_template(value)
    if "e" in text.lower():
        text = f"{value:.20f}".rstrip("0")
    if "." not in text:
        text += ".0"
    if text.endswith("."):
        text += "0"
    return text


def _quoted(text: str) -> str:
    escaped = (
        text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    )
    return f'"{escaped}"'


def wardley_name(name: str) -> str:
    """A name as Mermaid reads it: unquoted when it can be, else in double quotes."""
    if BARE_NAME.match(name) and not any(name.startswith(word) for word in RESERVED_PREFIXES):
        return name
    return _quoted(name)


def _finite(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def _saved_point(node: dict[str, Any], frame: dict[str, float]) -> dict[str, float]:
    data = node.get("wardley")
    if isinstance(data, dict) and _finite(data.get("visibility")) and _finite(data.get("evolution")):
        drawn = wardley_point(frame, data)
        if abs(drawn["x"] - node["position"]["x"]) < 1e-6 and abs(drawn["y"] - node["position"]["y"]) < 1e-6:
            return {"visibility": data["visibility"], "evolution": data["evolution"]}
    return wardley_coordinates_at(frame, node["position"])


def _saved_evolution(node: dict[str, Any], frame: dict[str, float]) -> float:
    data = node.get("wardley")
    if (
        isinstance(data, dict)
        and _finite(data.get("evolution"))
        and abs(wardley_x(frame, data["evolution"]) - node["position"]["x"]) < 1e-6
    ):
        return float(data["evolution"])
    return wardley_coordinates_at(frame, node["position"])["evolution"]


def _pair_text(point: dict[str, float]) -> str:
    return f"[{wardley_number(point['visibility'])}, {wardley_number(point['evolution'])}]"


def _label_part(offset: Any) -> str:
    if not js_truthy(offset):
        return ""
    return f" label [{_n(_js_round(offset['x']))}, {_n(_js_round(offset['y']))}]"


def _one_line(text: str) -> str:
    return js_trim(re.sub("[\\r\\n]+", " ", text))


def _wardley_of(node: dict[str, Any]) -> dict[str, Any]:
    data = node.get("wardley")
    return data if isinstance(data, dict) else {}


def serialize_wardley(model: Model) -> str:
    """canvas-8uh1.1: the text, with `canvas.links` front matter when an element links to another diagram, each
    link keyed by the id the element gets when the text is read back (a map's ids come from what is written)."""
    body = _write_wardley(model)
    if not any(e.get("diagramRef") for e in [*model["nodes"], *model["containers"]]):
        return join_front_matter(with_frames({}, model), body)
    reread = parse_wardley(body)
    if "model" not in reread:
        return join_front_matter(with_frames({}, model), body)
    ids = _wardley_saved_ids(model, reread["model"])
    linked = with_links({}, model, lambda element_id, kind: ids.get(f"{kind}:{element_id}"))
    return join_front_matter(with_frames(linked, model), body)


_OTHER_ROLES = frozenset({"note", "annotation", "accelerator", "deaccelerator"})
_MERGING = ("map:", "pipeline-component:", "pipeline:")


def _signatures(model: Model) -> list[tuple[str, str]]:
    by_id = {n["id"]: n for n in model["nodes"]}
    parent_of: dict[str, Any] = {}
    for c in model["containers"]:
        if c.get("role") == "pipeline":
            attached = c.get("attachedNodeIds") or []
            parent_of[c["id"]] = by_id.get(attached[0] if attached else "")
    out: list[tuple[str, str]] = []
    for node in model["nodes"]:
        container_id = node.get("containerId")
        if container_id is not None and container_id in parent_of:
            parent = parent_of[container_id]
            if parent is not None:
                out.append((f"node:{node['id']}", f"pipeline-component:{parent['label']}:{node['label']}"))
        elif (node.get("role") or "") in _OTHER_ROLES:
            out.append((f"node:{node['id']}", f"{node['role']}:"))
        else:
            out.append((f"node:{node['id']}", f"map:{node['label']}"))
    for container in model["containers"]:
        parent = parent_of.get(container["id"])
        if container.get("role") == "pipeline" and parent is not None:
            out.append((f"container:{container['id']}", f"pipeline:{parent['label']}"))
    return out


def _wardley_saved_ids(model: Model, reread: Model) -> dict[str, str]:
    """For each element, the id it has after a save and a read (wardley.ts wardleySavedIds)."""
    after: dict[str, list[str]] = {}
    for key, signature in _signatures(reread):
        after.setdefault(signature, []).append(key[key.index(":") + 1 :])
    used: dict[str, int] = {}
    ids: dict[str, str] = {}
    for key, signature in _signatures(model):
        index = used.get(signature, 0)
        used[signature] = index + 1
        found = after.get(signature, [])
        position = 0 if signature.startswith(_MERGING) else index
        if position < len(found):
            ids[key] = found[position]
    return ids


def _write_wardley(model: Model) -> str:
    frame = wardley_frame(model)
    lines: list[str] = []
    if model.get("mermaidConfigDirective"):
        lines.append(model["mermaidConfigDirective"])
    lines.append(WARDLEY_HEADER)
    if model.get("title") and _one_line(model["title"]):
        lines.append(f"title {_one_line(model['title'])}")
    if model.get("accTitle") and _one_line(model["accTitle"]):
        lines.append(f"accTitle: {_one_line(model['accTitle'])}")
    acc_descr = model.get("accDescr")
    if acc_descr:
        if re.search("[\\r\\n]", acc_descr):
            lines.append("accDescr {")
            lines.extend(_trim_end(f"  {part.replace('}', ')')}") for part in LINE_BREAKS.split(acc_descr))
            lines.append("}")
        else:
            lines.append(f"accDescr: {js_trim(acc_descr)}")
    settings = _settings(model)
    if js_truthy(settings.get("size")):
        size = settings["size"]
        lines.append(f"size [{_n(_js_round(size['width']))}, {_n(_js_round(size['height']))}]")
    stages = settings.get("stages")
    if stages and len(stages) >= 2:

        def stage_text(stage: dict[str, Any]) -> str:
            boundary = stage.get("boundary")
            second = stage.get("secondName")
            return (
                f"{wardley_name(stage['name'])}{'' if boundary is None else '@' + wardley_number(boundary)}"
                f"{' / ' + wardley_name(second) if second else ''}"
            )

        lines.append(f"evolution {' -> '.join(stage_text(s) for s in stages)}")

    sections: list[list[str]] = []
    pipeline_ids = {c["id"] for c in model["containers"] if c.get("role") == "pipeline"}

    def in_pipeline(node: dict[str, Any]) -> bool:
        return node.get("containerId") is not None and node["containerId"] in pipeline_ids

    map_nodes = [n for n in model["nodes"] if not in_pipeline(n) and (n.get("role") or "") not in OTHER_ROLES]
    nodes_by_id = {n["id"]: n for n in model["nodes"]}

    sections.append(
        [
            f"anchor {wardley_name(n['label'])} {_pair_text(_saved_point(n, frame))}"
            for n in map_nodes
            if n.get("role") == "anchor"
        ]
    )
    component_lines = []
    for n in map_nodes:
        if n.get("role") == "anchor":
            continue
        data = _wardley_of(n)
        strategy = f" ({data['strategy']})" if data.get("strategy") else ""
        inertia = " (inertia)" if js_truthy(data.get("inertia")) else ""
        component_lines.append(
            f"component {wardley_name(n['label'])} {_pair_text(_saved_point(n, frame))}"
            f"{_label_part(data.get('labelOffset'))}{strategy}{inertia}"
        )
    sections.append(component_lines)
    pipeline_lines: list[str] = []
    for container in model["containers"]:
        if container.get("role") != "pipeline":
            continue
        attached = container.get("attachedNodeIds") or []
        parent = nodes_by_id.get(attached[0] if attached else "")
        children = [n for n in model["nodes"] if n.get("containerId") == container["id"]]
        if parent is None or not children:
            continue
        pipeline_lines.append(f"pipeline {wardley_name(parent['label'])} {{")
        for child in children:
            pipeline_lines.append(
                f"  component {wardley_name(child['label'])} [{wardley_number(_saved_evolution(child, frame))}]"
                f"{_label_part(_wardley_of(child).get('labelOffset'))}"
            )
        pipeline_lines.append("}")
    sections.append(pipeline_lines)
    sections.append([_link_line(edge, nodes_by_id) for edge in model["edges"]])
    sections.append(
        [
            f"evolve {wardley_name(n['label'])} {wardley_number(_wardley_of(n)['evolve'])}"
            for n in model["nodes"]
            if _finite(_wardley_of(n).get("evolve")) and (n.get("role") or "") not in OTHER_ROLES
        ]
    )
    sections.append(
        [
            f"note {_quoted(n['label'])} {_pair_text(_saved_point(n, frame))}"
            for n in model["nodes"]
            if n.get("role") == "note"
        ]
    )
    annotation_lines: list[str] = []
    if js_truthy(settings.get("annotationsBox")):
        annotation_lines.append(f"annotations {_pair_text(settings['annotationsBox'])}")
    for n in model["nodes"]:
        if n.get("role") != "annotation":
            continue
        number = _wardley_of(n).get("number")
        index = _js_max(0, _js_round(1 if number is None else number))
        annotation_lines.append(f"annotation {_n(index)},{_pair_text(_saved_point(n, frame))} {_quoted(n['label'])}")
    sections.append(annotation_lines)
    sections.append(
        [
            f"{n['role']} {wardley_name(n['label'])} {_pair_text(_saved_point(n, frame))}"
            for n in model["nodes"]
            if n.get("role") in ("accelerator", "deaccelerator")
        ]
    )
    for section_lines in sections:
        if not section_lines:
            continue
        lines.append("")
        lines.extend(section_lines)
    return "\n".join(lines) + "\n"


def _link_line(edge: dict[str, Any], nodes_by_id: dict[str, dict[str, Any]]) -> str:
    def name(node_id: str) -> str:
        node = nodes_by_id.get(node_id)
        label = node.get("label") if node is not None else None
        return node_id if label is None else label

    data = edge.get("wardley")
    data = data if isinstance(data, dict) else None
    arrow: str | None = data.get("arrow") if data is not None else "->"
    flow_arrow = data.get("flowArrow") if data is not None else None
    if edge.get("lineStyle") == "dotted":
        arrow = "-.->"
        flow_arrow = None
    elif arrow == "-.->":
        arrow = "->"
    if flow_arrow:
        flow_label = re.sub("[\\r\\n]+", " ", flow_arrow["label"].replace("'", "\u2019"))
        arrow_text: str | None = f"+'{flow_label}'{flow_arrow['flow'][1:]}"
    else:
        arrow_text = arrow
    source = wardley_name(name(edge["sourceId"]))
    target = wardley_name(name(edge["targetId"]))

    def quote(text: str) -> str:
        return text if text.startswith('"') else _quoted(text)

    from_port = data.get("fromPort") if data is not None else None
    to_port = data.get("toPort") if data is not None else None
    if not (arrow_text or from_port):
        source, target = quote(source), quote(target)
    parts = [source]
    if from_port:
        parts.append(from_port)
    if arrow_text:
        parts.append(arrow_text)
    parts.append(target)
    if to_port:
        parts.append(to_port)
    label = js_trim(re.sub("[\\r\\n]+", " ", edge["label"])) if edge.get("label") else ""
    return " ".join(parts) + (f"; {label}" if label else "")


def wardley_positions_from_coordinates(model: Model) -> Model:
    """Positions for every node from its coordinates."""
    frame = wardley_frame(model)
    parents = {
        c["id"]: (c.get("attachedNodeIds") or [None])[0] for c in model["containers"] if c.get("role") == "pipeline"
    }
    by_id = {n["id"]: n for n in model["nodes"]}
    nodes = []
    for n in model["nodes"]:
        data = n.get("wardley")
        if not js_truthy(data):
            nodes.append(n)
            continue
        parent = by_id.get(parents.get(n["containerId"]) or "") if js_truthy(n.get("containerId")) else None
        visibility = (
            parent["wardley"]["visibility"] if parent is not None and parent.get("wardley") else data["visibility"]
        )
        nodes.append({**n, "position": {"x": wardley_x(frame, data["evolution"]), "y": wardley_y(frame, visibility)}})
    result = {**model, "nodes": nodes, "containers": [dict(c) for c in model["containers"]]}
    lay_out_pipelines(result, frame)
    return result


_ = js_number  # re-exported for callers that format numbers the way the writer does
