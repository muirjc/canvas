"""Mermaid `@{ … }` blocks on flowchart nodes and edge ids (packages/diagram-core/src/dsl/mermaid-shape-data.ts).

canvas-8wxq. The block is a YAML flow mapping; Canvas reads the subset Mermaid's docs use: `key: value` pairs,
values double-quoted, single-quoted or bare (true/false, a plain number, else text).
"""

from __future__ import annotations

import math
import re
from typing import Any

from canvas_api.diagram_core.jsvalues import js_template
from canvas_api.github.jstext import JS_WHITESPACE

__all__ = [
    "MAX_LINK_LENGTH",
    "MERMAID_NAME",
    "MERMAID_SHAPE_NAME",
    "SHAPE_DATA_INNER_SOURCE",
    "SHAPE_DATA_SOURCE",
    "data_entries",
    "format_shape_data",
    "mermaid_shape_to_canvas",
    "parse_shape_data",
]

_S = f"[{JS_WHITESPACE}]"
_DOT = "[^\\n\\r\\u2028\\u2029]"  # JavaScript's .

SHAPE_DATA_INNER_SOURCE = f"(?:[^{{}}\"']|\"(?:[^\"\\\\]|\\\\{_DOT})*\"|'(?:[^']|'')*')*"
SHAPE_DATA_SOURCE = f"@\\{{{SHAPE_DATA_INNER_SOURCE}\\}}"

#: canvas-sfz7: the longest flowchart link length kept (a longer link is read, and written back, at this length).
MAX_LINK_LENGTH = 1000

MERMAID_NAME = re.compile("^[A-Za-z][A-Za-z0-9_-]*\\Z")

_WS = re.compile(f"{_S}*")
_KEY = re.compile("[A-Za-z][A-Za-z0-9_-]*")
_DOUBLE_QUOTED = re.compile(f'"((?:[^"\\\\]|\\\\{_DOT})*)"')
_SINGLE_QUOTED = re.compile("'((?:[^']|'')*)'")
_BARE = re.compile(f"[^,{JS_WHITESPACE}](?:[^,]*[^,{JS_WHITESPACE}])?")
_NUMBER = re.compile("^-?[0-9]{1,9}(?:\\.[0-9]{1,6})?\\Z")
_ESCAPE = re.compile(f"\\\\({_DOT})")
_ESCAPES = {"n": "\n", "t": "\t", "r": "\r"}

Entry = tuple[str, Any]


def _number(text: str) -> int | float:
    value = float(text)
    return int(value) if value.is_integer() else value


def _bare_value(text: str) -> Any:
    if text in ("true", "false"):
        return text == "true"
    return _number(text) if _NUMBER.match(text) else text


def parse_shape_data(inner: str) -> dict[str, Any]:
    """{"entries": [(key, value), ...]} or {"error": text}."""
    entries: list[Entry] = []
    seen: set[str] = set()
    pos = _WS.match(inner, 0).end()  # type: ignore[union-attr]
    while pos < len(inner):
        key = _KEY.match(inner, pos)
        if not key:
            return {"error": f'Expected a key at "{inner[pos:]}"'}
        pos = _WS.match(inner, key.end()).end()  # type: ignore[union-attr]
        if not inner.startswith(":", pos):
            return {"error": f'Expected ":" after "{key.group(0)}"'}
        pos = _WS.match(inner, pos + 1).end()  # type: ignore[union-attr]
        value: Any
        if match := _DOUBLE_QUOTED.match(inner, pos):
            value = _ESCAPE.sub(lambda m: _ESCAPES.get(m.group(1), m.group(1)), match.group(1))
        elif match := _SINGLE_QUOTED.match(inner, pos):
            value = match.group(1).replace("''", "'")
        elif match := _BARE.match(inner, pos):
            value = _bare_value(match.group(0))
        else:
            return {"error": f'"{key.group(0)}" has no value'}
        pos = match.end()
        if key.group(0) in seen:
            return {"error": f'"{key.group(0)}" is given twice'}
        seen.add(key.group(0))
        entries.append((key.group(0), value))
        pos = _WS.match(inner, pos).end()  # type: ignore[union-attr]
        if pos < len(inner):
            if not inner.startswith(",", pos):
                return {"error": f'Expected "," at "{inner[pos:]}"'}
            pos = _WS.match(inner, pos + 1).end()  # type: ignore[union-attr]
    return {"entries": entries}


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def _format_value(value: Any) -> str:
    if not isinstance(value, str):
        return js_template(value)
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r")
    return f'"{escaped}"'


def format_shape_data(entries: list[Entry]) -> str:
    parts: list[str] = []
    for key, value in entries:
        if not MERMAID_NAME.match(key):
            continue
        if key == "shape" and isinstance(value, str) and MERMAID_NAME.match(value):
            parts.append(f"shape: {value}")
        elif isinstance(value, str | bool) or _is_number(value):
            parts.append(f"{key}: {_format_value(value)}")
    return "@{ " + ", ".join(parts) + " }"


def data_entries(data: Any, skip: tuple[str, ...] = ()) -> list[Entry]:
    if not isinstance(data, dict):
        return []
    return [(key, value) for key, value in data.items() if MERMAID_NAME.match(key) and key not in skip]


_NEAREST: dict[str, str] = {
    **dict.fromkeys(["rounded", "event", "delay", "half-rounded-rectangle"], "rounded-rectangle"),
    **dict.fromkeys(
        [
            "circle", "circ", "sm-circ", "small-circle", "start", "f-circ", "filled-circle", "junction",
            "cross-circ", "crossed-circle", "summary",
        ],
        "circle",
    ),
    **dict.fromkeys(["dbl-circ", "double-circle", "fr-circ", "framed-circle", "stop"], "double-circle"),
    **dict.fromkeys(["diam", "diamond", "decision", "question"], "diamond"),
    **dict.fromkeys(
        [
            "cyl", "cylinder", "database", "db", "h-cyl", "das", "horizontal-cylinder", "lin-cyl", "disk",
            "lined-cylinder", "datastore", "data-store", "bucket",
        ],
        "cylinder",
    ),
    **dict.fromkeys(["stadium", "pill", "terminal"], "stadium"),
    **dict.fromkeys(["fr-rect", "framed-rectangle", "subproc", "subprocess", "subroutine"], "subroutine"),
    **dict.fromkeys(["hex", "hexagon", "prepare"], "hexagon"),
    **dict.fromkeys(["lean-r", "lean-right", "in-out"], "parallelogram"),
    **dict.fromkeys(["lean-l", "lean-left", "out-in"], "parallelogram-alt"),
    **dict.fromkeys(
        ["trap-b", "trapezoid", "priority", "trapezoid-bottom", "tri", "extract", "triangle"], "trapezoid"
    ),
    **dict.fromkeys(
        [
            "trap-t", "inv-trapezoid", "manual", "trapezoid-top", "flip-tri", "flipped-triangle", "manual-file",
        ],
        "trapezoid-alt",
    ),
    "odd": "asymmetric",
    "person": "person",
    "fork": "fork-bar",
    "join": "fork-bar",
}  # fmt: skip


def mermaid_shape_to_canvas(name: str, has_icon: bool = False) -> str:
    shape = _NEAREST.get(name, "rectangle")
    return "icon" if shape == "rectangle" and has_icon else shape


MERMAID_SHAPE_NAME = {
    "rectangle": "rect",
    "rounded-rectangle": "rounded",
    "circle": "circle",
    "diamond": "diam",
    "cylinder": "cyl",
    "person": "person",
    "icon": "rect",
    "stadium": "stadium",
    "subroutine": "fr-rect",
    "double-circle": "dbl-circ",
    "hexagon": "hex",
    "parallelogram": "lean-r",
    "parallelogram-alt": "lean-l",
    "trapezoid": "trap-b",
    "trapezoid-alt": "trap-t",
    "asymmetric": "odd",
    "state-start": "circle",
    "state-end": "dbl-circ",
    "fork-bar": "fork",
}
