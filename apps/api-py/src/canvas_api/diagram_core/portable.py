"""Portable Mermaid for tools outside Canvas (packages/diagram-core/src/dsl/portable-mermaid.ts): the colours
kept in the canvas front matter added as plain Mermaid style lines, and optionally the canvas front matter
removed. Every family is native (canvas-1bty.15.2 ported the C4, ER and class parsers the style lines need)."""

from __future__ import annotations

import re
from typing import Any

from canvas_api.diagram_core import jsyaml
from canvas_api.diagram_core.detect import detect_dsl_family
from canvas_api.diagram_core.flowchart import parse_flowchart
from canvas_api.diagram_core.front_matter import _TRAILING, FRONT_MATTER_PATTERN
from canvas_api.diagram_core.jsvalues import to_js_json
from canvas_api.github.jstext import JS_WHITESPACE, js_number

__all__ = ["NATIVE_PORTABLE_FAMILIES", "to_portable_mermaid"]

COMMENT = "%% Colours for Mermaid tools outside Canvas (added on export)."
#: Families with a native portable form: all of them (sequence and architecture get no style lines).
NATIVE_PORTABLE_FAMILIES = {"flowchart", "c4", "erd", "uml", "sequence", "architecture", None}
_TRAILING_SPACE = re.compile(f"[{JS_WHITESPACE}]+\\Z")


def to_portable_mermaid(dsl: str, strip_front_matter: bool = False) -> str | None:
    """The portable text, or None when the family's style lines need a parser not ported yet."""
    family = detect_dsl_family(dsl)
    if family not in NATIVE_PORTABLE_FAMILIES:
        return None
    portable = _with_style_lines(dsl, family)
    return _remove_canvas_front_matter(portable) if strip_front_matter else portable


def _remove_canvas_front_matter(dsl: str) -> str:
    match = FRONT_MATTER_PATTERN.match(dsl)
    if not match:
        return dsl
    body = dsl[match.end() :]
    parsed = jsyaml.load(match.group(1))
    rest = {k: v for k, v in parsed.items() if k != "canvas"} if isinstance(parsed, dict) else {}
    if not rest:
        return body
    return f"---\n{jsyaml.dump(rest).rstrip(_TRAILING)}\n---\n{body}"


def _with_style_lines(dsl: str, family: str | None) -> str:
    # Imported here: the family modules import nothing from this one, but keeping them out of the module's
    # import time keeps `detect`-only callers light.
    from canvas_api.diagram_core.c4 import parse_c4
    from canvas_api.diagram_core.erd import parse_erd
    from canvas_api.diagram_core.uml import parse_uml

    if family == "flowchart":
        lines = _flowchart_lines(parse_flowchart(dsl))
    elif family == "c4":
        lines = _c4_lines(parse_c4(dsl))
    elif family == "erd":
        lines = _node_style_lines(parse_erd(dsl), "")
    elif family == "uml":
        lines = _node_style_lines(parse_uml(dsl), "")
    else:
        lines = []
    if not lines:
        return dsl
    # Flowcharts are written indented; the other families' serializers write flush left.
    indent = "  " if family == "flowchart" else ""
    trimmed = _TRAILING_SPACE.sub("", dsl)
    return f"{trimmed}\n{indent}{COMMENT}\n" + "\n".join(lines) + "\n"


def _node_style_lines(result: dict[str, Any], indent: str) -> list[str]:
    """`style <id> ...` per coloured node: flowchart, ER and class diagrams share this grammar."""
    if "model" not in result:
        return []
    lines = []
    for node in result["model"]["nodes"]:
        props = _style_props(node.get("style"))
        if props:
            lines.append(f"{indent}style {node['id']} {props}")
    return lines


def _c4_lines(result: dict[str, Any]) -> list[str]:
    """C4's own macros carry only colours. UpdateRelStyle colours every rel between a pair, so it's written only
    when they all share one colour."""
    if "model" not in result:
        return []
    model = result["model"]
    lines = []
    for node in model["nodes"]:
        style = node.get("style") or {}
        args = [
            f'$bgColor="{style["fillColor"]}"' if style.get("fillColor") else None,
            f'$borderColor="{style["strokeColor"]}"' if style.get("strokeColor") else None,
        ]
        present = [a for a in args if a]
        if present:
            lines.append(f"UpdateElementStyle({node['id']}, {', '.join(present)})")
    by_pair: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for edge in model["edges"]:
        by_pair.setdefault((edge["sourceId"], edge["targetId"]), []).append(edge)
    for first, *rest in by_pair.values():
        colour = (first.get("style") or {}).get("strokeColor")
        if not colour or any((edge.get("style") or {}).get("strokeColor") != colour for edge in rest):
            continue
        lines.append(f'UpdateRelStyle({first["sourceId"]}, {first["targetId"]}, $lineColor="{colour}")')
    return lines


def _flowchart_lines(result: dict[str, Any]) -> list[str]:
    if "model" not in result:
        return []
    model = result["model"]
    lines = _node_style_lines(result, "  ")
    for index, edge in enumerate(model["edges"]):
        props = _style_props(edge.get("style"))
        if props:
            lines.append(f"  linkStyle {index} {props}")
    return lines


def _number_text(value: Any) -> str:
    """`${value}` for a number (NaN and infinities as JavaScript writes them)."""
    if isinstance(value, float):
        if value != value:
            return "NaN"
        if value in (float("inf"), float("-inf")):
            return "Infinity" if value > 0 else "-Infinity"
        return js_number(value)
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(to_js_json(value))


def _style_props(style: dict[str, Any] | None) -> str | None:
    if not style:
        return None
    props = []
    if style.get("fillColor"):
        props.append(f"fill:{style['fillColor']}")
    if style.get("strokeColor"):
        props.append(f"stroke:{style['strokeColor']}")
    if style.get("strokeWidth") is not None:
        props.append(f"stroke-width:{_number_text(style['strokeWidth'])}px")
    if style.get("strokeDasharray"):
        props.append(f"stroke-dasharray:{str(style['strokeDasharray']).replace(',', ' ')}")
    return ",".join(props) if props else None
