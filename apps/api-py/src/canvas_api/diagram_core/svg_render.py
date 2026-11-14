"""A diagram model drawn as self-contained SVG (packages/diagram-core/src/render/svg-renderer.ts: renderToSvg).

The output must equal the TypeScript renderer's byte for byte, so this copies its arithmetic in the same order
(both are IEEE doubles) and writes every number the way a JavaScript template literal does (`js_template`).
Models arrive as JSON: an absent field and a None are both `undefined` here, which is what `??` and the
truthiness checks the renderer uses see.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from typing import Any
from urllib.parse import quote

from canvas_api.diagram_core.colors import resolve_node_fill_stroke
from canvas_api.diagram_core.dagre.graph import js_string_gt
from canvas_api.diagram_core.frames_render import with_frame_overlay
from canvas_api.diagram_core.jsvalues import js_template, js_truthy
from canvas_api.diagram_core.legend import LEGEND_METRICS, compute_legend_entries, legend_layout
from canvas_api.diagram_core.model import is_allowed_link_href
from canvas_api.diagram_core.sequence_layout import SELF_MESSAGE_LOOP_WIDTH, compute_sequence_layout
from canvas_api.diagram_core.sizes import (
    DESCRIBED_BLOCK_GAP,
    DESCRIBED_LINE_HEIGHT,
    DESCRIPTION_FONT_SIZE,
    ICON_GLYPH_SIZE,
    ICON_LABEL_GAP,
    ICON_LABEL_MAX_WIDTH,
    ICON_PADDING,
    TABLE_HEADER_PADDING_Y,
    TABLE_ROW_PADDING_X,
    TABLE_ROW_PADDING_Y,
    node_size,
    pseudo_state_size,
    split_label_lines,
    table_rows,
)
from canvas_api.diagram_core.wardley import wardley_frame
from canvas_api.diagram_core.wardley_render import render_wardley_svg
from canvas_api.github.jstext import JS_WHITESPACE, js_len

#: JavaScript's encodeURIComponent leaves these as they are (canvas-8uh1.4: a linked diagram's address).
_URI_COMPONENT_SAFE = "!'()*-._~"

__all__ = ["IconResolver", "clip_icon_artwork", "compute_bounds", "contrast_text_color", "render_to_svg"]

Node = dict[str, Any]
Container = dict[str, Any]
Edge = dict[str, Any]
Model = dict[str, Any]
Point = dict[str, Any]
IconResolver = Callable[[dict[str, Any]], "str | None"]

DEFAULT_CONTAINER_SIZE = {"width": 300, "height": 200}
FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
DEFAULT_DOTTED_DASHARRAY = "4 2"
DEFAULT_THICK_STROKE_WIDTH = 3


# --- JavaScript arithmetic --------------------------------------------------------------------------------------


def _t(value: Any) -> str:
    """`${value}` in a template literal."""
    return js_template(value)


def _nan_in(values: tuple[Any, ...]) -> bool:
    return any(isinstance(v, float) and v != v for v in values)


def _min(*values: Any) -> Any:
    """Math.min: NaN if any argument is NaN (Python's min would skip past it)."""
    if _nan_in(values):
        return math.nan
    return min(values)


def _max(*values: Any) -> Any:
    """Math.max: NaN if any argument is NaN; -Infinity with no arguments."""
    if not values:
        return -math.inf
    if _nan_in(values):
        return math.nan
    return max(values)


def _div(a: float, b: float) -> float:
    """a / b with JavaScript's answer for b == 0 (Infinity, -Infinity or NaN) instead of an exception."""
    if b == 0:
        if a == 0 or a != a:
            return math.nan
        negative = (a < 0) != (math.copysign(1.0, b) < 0)
        return -math.inf if negative else math.inf
    return a / b


def js_hypot(*values: float) -> float:
    """Math.hypot as V8 computes it (scaled by the largest value, Kahan-summed squares). Python's math.hypot
    can differ in the last bit, and these values end up as printed coordinates."""
    if not values:
        return 0.0
    absolute: list[float] = []
    largest = 0.0
    has_nan = False
    for value in values:
        if value != value:
            has_nan = True
            absolute.append(0.0)
            continue
        magnitude = abs(float(value))
        absolute.append(magnitude)
        largest = max(largest, magnitude)
    if largest == math.inf:
        return math.inf
    if has_nan:
        return math.nan
    if largest == 0:
        return 0.0
    total = 0.0
    compensation = 0.0
    for magnitude in absolute:
        n = magnitude / largest
        summand = n * n - compensation
        preliminary = total + summand
        compensation = (preliminary - total) - summand
        total = preliminary
    return math.sqrt(total) * largest


def _hypot_or_one(dx: float, dy: float) -> float:
    """`Math.hypot(dx, dy) || 1`."""
    length = js_hypot(dx, dy)
    return length if length and length == length else 1


def _get(obj: Any, key: str) -> Any:
    """obj?.[key], with None standing for undefined."""
    return obj.get(key) if isinstance(obj, dict) else None


def _style(item: dict[str, Any]) -> Any:
    return item.get("style")


def _font_size(node: Node) -> Any:
    size = _get(_style(node), "fontSize")
    return 14 if size is None else size


def escape_xml(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


# --- labels -----------------------------------------------------------------------------------------------------


def _render_label_text(
    x: float,
    y: float,
    label: str,
    font_size: float,
    centered: bool,
    max_width: float | None = None,
    text_color: str = "#000000",
    anchor: str = "middle",
) -> str:
    fill_attr = f' fill="{_t(text_color)}"'
    lines = split_label_lines(label, max_width, font_size if max_width is not None else None)
    if len(lines) == 1:
        baseline = ' dominant-baseline="middle"' if centered else ""
        return (
            f'<text x="{_t(x)}" y="{_t(y)}"{baseline} text-anchor="{anchor}" font-size="{_t(font_size)}" '
            f"font-family='{FONT_FAMILY}'{fill_attr}>{escape_xml(label)}</text>"
        )
    line_height_em = 1.2
    first_dy = (-(len(lines) - 1) * line_height_em) / 2 if centered else 0
    tspans = "".join(
        f'<tspan x="{_t(x)}" dy="{_t(first_dy if i == 0 else line_height_em)}em">{escape_xml(line)}</tspan>'
        for i, line in enumerate(lines)
    )
    return (
        f'<text x="{_t(x)}" y="{_t(y)}" text-anchor="{anchor}" font-size="{_t(font_size)}" '
        f"font-family='{FONT_FAMILY}'{fill_attr}>{tspans}</text>"
    )


def edge_label_placement(mid: Point, shift: Point) -> dict[str, Any]:
    """canvas-xpuk (edgeLabelPlacement): a lone connector's label sits centred above its point; one of several
    between the same two shapes goes on its own outer side, aligned away from the others."""
    length = js_hypot(shift["x"], shift["y"])
    if length == 0:
        return {"x": mid["x"], "y": mid["y"] - 4, "anchor": "middle"}
    nx = shift["x"] / length
    ny = shift["y"] / length
    if abs(nx) >= 0.5:
        return {"x": mid["x"] + nx * 6, "y": mid["y"] + ny * 6 + 4, "anchor": "start" if nx > 0 else "end"}
    return {"x": mid["x"], "y": mid["y"] + 16 if ny > 0 else mid["y"] - 8, "anchor": "middle"}


# --- node geometry ----------------------------------------------------------------------------------------------


def _icon_caption_font_size(node: Node) -> Any:
    return _max(_font_size(node) - 2, 10)


def clamp_person_head_radius(width: float, height: float) -> Any:
    return _max(8, _min(20, _min(width, height) * 0.16))


def _person_body_top(y: float, width: float, height: float) -> Any:
    return y + 2 * clamp_person_head_radius(width, height) + 7


def _is_described(node: Node) -> bool:
    has_text = js_truthy(node.get("technology")) or js_truthy(node.get("description"))
    has_text = has_text or js_truthy(node.get("c4TypeLabel"))
    return has_text and node.get("shape") != "icon" and len(table_rows(node)) == 0


def _type_line(node: Node) -> str | None:
    technology = node.get("technology")
    if js_truthy(node.get("c4TypeLabel")):
        tech = f": {_t(technology)}" if js_truthy(technology) else ""
        return f"[{_t(node['c4TypeLabel'])}{tech}]"
    return f"[{_t(technology)}]" if js_truthy(technology) else None


def _described_text_lines(node: Node, width: float) -> list[dict[str, Any]]:
    max_width = _max(width - 16, 40)
    blocks: list[tuple[str, Any, bool]] = [(node["label"], _font_size(node), True)]
    type_line = _type_line(node)
    if type_line:
        blocks.append((type_line, DESCRIPTION_FONT_SIZE, False))
    if js_truthy(node.get("description")):
        blocks.append((node["description"], DESCRIPTION_FONT_SIZE, False))
    lines: list[dict[str, Any]] = []
    for b, (text, font_size, bold) in enumerate(blocks):
        for i, line in enumerate(split_label_lines(text, max_width, font_size)):
            gap = DESCRIBED_BLOCK_GAP if b > 0 and i == 0 else 0
            lines.append({"text": line, "fontSize": font_size, "bold": bold, "gapBefore": gap})
    return lines


def _described_content_height(lines: list[dict[str, Any]]) -> Any:
    total: Any = 0
    for line in lines:
        total = total + line["gapBefore"] + line["fontSize"] * DESCRIBED_LINE_HEIGHT
    return total


def described_node_layout(node: Node) -> list[dict[str, Any]] | None:
    """The lines a described C4 element draws (name, type line, description), or None."""
    if not _is_described(node):
        return None
    size = node_size(node)
    width, height = size["width"], size["height"]
    lines = _described_text_lines(node, width)
    y0 = node["position"]["y"]
    region_top = _person_body_top(y0, width, height) if node.get("shape") == "person" else y0
    region_height = y0 + height - region_top
    cursor = region_top + (region_height - _described_content_height(lines)) / 2
    out: list[dict[str, Any]] = []
    for line in lines:
        cursor += line["gapBefore"]
        line_height = line["fontSize"] * DESCRIBED_LINE_HEIGHT
        y = cursor + line_height / 2
        cursor += line_height
        out.append(
            {
                "text": line["text"],
                "x": node["position"]["x"] + width / 2,
                "y": y,
                "fontSize": line["fontSize"],
                "bold": line["bold"],
            }
        )
    return out


def _plain_label_center_y(node: Node) -> Any:
    size = node_size(node)
    width, height = size["width"], size["height"]
    y = node["position"]["y"]
    if node.get("shape") != "person":
        return y + height / 2
    top = _person_body_top(y, width, height)
    return (top + y + height) / 2


def _format_stereotype(node: Node) -> str | None:
    stereotype = node.get("umlStereotype")
    return f"<<{_t(stereotype)}>>" if js_truthy(stereotype) else None


def table_node_layout(node: Node) -> dict[str, Any] | None:
    rows = table_rows(node)
    if not rows:
        return None
    x, y = node["position"]["x"], node["position"]["y"]
    size = node_size(node)
    width, height = size["width"], size["height"]
    font_size = _font_size(node)
    row_font_size = _max(font_size - 2, 10)
    stereotype_text = _format_stereotype(node)
    stereotype_height = row_font_size * 1.2 + TABLE_HEADER_PADDING_Y if stereotype_text else 0
    header_height = stereotype_height + font_size * 1.2 + TABLE_HEADER_PADDING_Y * 2
    row_height = row_font_size * 1.2 + TABLE_ROW_PADDING_Y * 2
    return {
        "width": width,
        "height": height,
        "headerX": x + width / 2,
        "headerY": y + stereotype_height + (font_size * 1.2 + TABLE_HEADER_PADDING_Y * 2) / 2,
        "headerFontSize": font_size,
        "stereotype": (
            {
                "text": stereotype_text,
                "x": x + width / 2,
                "y": y + TABLE_HEADER_PADDING_Y + row_font_size,
                "fontSize": row_font_size,
            }
            if stereotype_text
            else None
        ),
        "dividerY": y + header_height,
        "rows": [
            {
                "text": text,
                "x": x + TABLE_ROW_PADDING_X,
                "y": y + header_height + i * row_height + row_height / 2,
                "fontSize": row_font_size,
            }
            for i, text in enumerate(rows)
        ],
    }


def icon_node_layout(node: Node) -> dict[str, Any]:
    x, y = node["position"]["x"], node["position"]["y"]
    size = node_size(node)
    width, height = size["width"], size["height"]
    label_font_size = _icon_caption_font_size(node)
    icon_size = _min(ICON_GLYPH_SIZE, width - ICON_PADDING * 2, height - ICON_PADDING * 2)
    icon_x = x + (width - icon_size) / 2
    icon_y = y + ICON_PADDING
    return {
        "width": width,
        "height": height,
        "iconSize": icon_size,
        "iconX": icon_x,
        "iconY": icon_y,
        "labelX": x + width / 2,
        "labelY": icon_y + icon_size + ICON_LABEL_GAP + label_font_size,
        "labelFontSize": label_font_size,
        "labelMaxWidth": ICON_LABEL_MAX_WIDTH,
    }


def container_size(container: Container) -> Any:
    size = container.get("size")
    return DEFAULT_CONTAINER_SIZE if size is None else size


def container_as_endpoint(container: Container | None) -> Node | None:
    """canvas-bnnh: a state diagram's connector may end on a composite state: drawn to its box, as a rectangle."""
    if container is None:
        return None
    return {
        "id": container["id"],
        "label": container.get("label"),
        "shape": "rectangle",
        "position": container["position"],
        "size": container_size(container),
    }


def _node_center(node: Node) -> Point:
    size = node_size(node)
    return {"x": node["position"]["x"] + size["width"] / 2, "y": node["position"]["y"] + size["height"] / 2}


# --- edge geometry ----------------------------------------------------------------------------------------------


def _clip_to_anchor_side(center: Point, size: Any, anchor: Any) -> Point | None:
    if anchor == "T":
        return {"x": center["x"], "y": center["y"] - size["height"] / 2}
    if anchor == "B":
        return {"x": center["x"], "y": center["y"] + size["height"] / 2}
    if anchor == "L":
        return {"x": center["x"] - size["width"] / 2, "y": center["y"]}
    if anchor == "R":
        return {"x": center["x"] + size["width"] / 2, "y": center["y"]}
    return None  # TypeScript's switch falls off the end: undefined


def _architecture_endpoint_box(node: Node, is_group: Any, containers_by_id: dict[str, Container]) -> dict[str, Any]:
    container_id: Any = node.get("containerId")
    if js_truthy(is_group) and js_truthy(container_id):
        container = containers_by_id.get(container_id)
        if container is not None:
            size = container_size(container)
            center = {
                "x": container["position"]["x"] + size["width"] / 2,
                "y": container["position"]["y"] + size["height"] / 2,
            }
            return {"center": center, "size": size, "shape": "rectangle"}
    return {"center": _node_center(node), "size": node_size(node), "shape": node.get("shape")}


def clip_edge_endpoint(center: Point, size: Any, shape: Any, toward_x: float, toward_y: float) -> Point:
    dx = toward_x - center["x"]
    dy = toward_y - center["y"]
    if dx == 0 and dy == 0:
        return dict(center)
    hw = size["width"] / 2
    hh = size["height"] / 2
    if shape in ("circle", "double-circle"):
        ex, ey = _div(dx, hw), _div(dy, hh)
        t = _div(1, math.sqrt(ex * ex + ey * ey))
    elif shape == "diamond":
        t = _div(1, _div(abs(dx), hw) + _div(abs(dy), hh))
    else:
        tx = _div(hw, abs(dx)) if dx != 0 else math.inf
        ty = _div(hh, abs(dy)) if dy != 0 else math.inf
        t = _min(tx, ty)
    t = _min(_max(t, 0), 1)
    return {"x": center["x"] + t * dx, "y": center["y"] + t * dy}


CROWSFOOT_GLYPH_SPACING = 7
CROWSFOOT_TICK_HALF = 5
CROWSFOOT_CIRCLE_RADIUS = 4
CROWSFOOT_FORK_LENGTH = 10
CROWSFOOT_FORK_SPREAD = 5


def _cardinality_glyphs(point: Point, dx: float, dy: float, token: str) -> list[dict[str, Any]]:
    length = _hypot_or_one(dx, dy)
    ux = dx / length
    uy = dy / length
    px = -uy
    py = ux
    glyphs: list[dict[str, Any]] = []
    dist: float = 0
    for ch in token:
        base_x = point["x"] + ux * dist
        base_y = point["y"] + uy * dist
        if ch == "|":
            glyphs.append(
                {
                    "kind": "tick",
                    "x1": base_x + px * CROWSFOOT_TICK_HALF,
                    "y1": base_y + py * CROWSFOOT_TICK_HALF,
                    "x2": base_x - px * CROWSFOOT_TICK_HALF,
                    "y2": base_y - py * CROWSFOOT_TICK_HALF,
                }
            )
            dist += CROWSFOOT_GLYPH_SPACING
        elif ch == "o":
            glyphs.append(
                {
                    "kind": "circle",
                    "cx": point["x"] + ux * (dist + CROWSFOOT_CIRCLE_RADIUS),
                    "cy": point["y"] + uy * (dist + CROWSFOOT_CIRCLE_RADIUS),
                    "r": CROWSFOOT_CIRCLE_RADIUS,
                }
            )
            dist += CROWSFOOT_CIRCLE_RADIUS * 2 + 2
        elif ch in ("{", "}"):
            glyphs.append(
                {
                    "kind": "fork",
                    "apexX": point["x"] + ux * (dist + CROWSFOOT_FORK_LENGTH),
                    "apexY": point["y"] + uy * (dist + CROWSFOOT_FORK_LENGTH),
                    "prongs": [
                        {"x": base_x, "y": base_y},
                        {"x": base_x + px * CROWSFOOT_FORK_SPREAD, "y": base_y + py * CROWSFOOT_FORK_SPREAD},
                        {"x": base_x - px * CROWSFOOT_FORK_SPREAD, "y": base_y - py * CROWSFOOT_FORK_SPREAD},
                    ],
                }
            )
            dist += CROWSFOOT_FORK_LENGTH
    return glyphs


def _render_cardinality_glyph(glyph: dict[str, Any], stroke: str) -> str:
    if glyph["kind"] == "tick":
        return (
            f'<line x1="{_t(glyph["x1"])}" y1="{_t(glyph["y1"])}" x2="{_t(glyph["x2"])}" y2="{_t(glyph["y2"])}" '
            f'stroke="{stroke}" />'
        )
    if glyph["kind"] == "circle":
        return (
            f'<circle cx="{_t(glyph["cx"])}" cy="{_t(glyph["cy"])}" r="{_t(glyph["r"])}" fill="white" '
            f'stroke="{stroke}" />'
        )
    return "".join(
        f'<line x1="{_t(glyph["apexX"])}" y1="{_t(glyph["apexY"])}" x2="{_t(p["x"])}" y2="{_t(p["y"])}" '
        f'stroke="{stroke}" />'
        for p in glyph["prongs"]
    )


_UML_MARKERS: dict[str, dict[str, Any]] = {
    "inheritance": {"source": "triangle-hollow", "dashed": False},
    "realization": {"target": "triangle-hollow", "dashed": True},
    "composition": {"source": "diamond-filled", "dashed": False},
    "aggregation": {"source": "diamond-hollow", "dashed": False},
    "association": {"target": "arrow-open", "dashed": False},
    "dependency": {"target": "arrow-open", "dashed": True},
    "link-dashed": {"dashed": True},
    "lollipop-source": {"source": "circle", "dashed": False},
    "lollipop-target": {"target": "circle", "dashed": False},
}


def _uml_endpoint_markers(kind: Any) -> dict[str, Any]:
    return _UML_MARKERS.get(kind, {"dashed": False}) if isinstance(kind, str) else {"dashed": False}


UML_MARKER_LENGTH = 12
UML_MARKER_HALF_WIDTH = 5
UML_LOLLIPOP_RADIUS = 5


def _uml_endpoint_glyph(point: Point, dx: float, dy: float, marker_kind: str) -> dict[str, Any]:
    length = _hypot_or_one(dx, dy)
    ux = dx / length
    uy = dy / length
    px = -uy
    py = ux
    if marker_kind == "circle":
        return {
            "kind": "circle",
            "cx": point["x"] + ux * UML_LOLLIPOP_RADIUS,
            "cy": point["y"] + uy * UML_LOLLIPOP_RADIUS,
            "r": UML_LOLLIPOP_RADIUS,
        }
    left = {
        "x": point["x"] + ux * UML_MARKER_LENGTH + px * UML_MARKER_HALF_WIDTH,
        "y": point["y"] + uy * UML_MARKER_LENGTH + py * UML_MARKER_HALF_WIDTH,
    }
    right = {
        "x": point["x"] + ux * UML_MARKER_LENGTH - px * UML_MARKER_HALF_WIDTH,
        "y": point["y"] + uy * UML_MARKER_LENGTH - py * UML_MARKER_HALF_WIDTH,
    }
    if marker_kind == "arrow-open":
        return {"kind": "open-arrow", "tip": point, "wingLeft": left, "wingRight": right}
    if marker_kind == "triangle-hollow":
        return {"kind": "triangle", "tip": point, "baseLeft": left, "baseRight": right, "filled": False}
    half = UML_MARKER_LENGTH / 2
    return {
        "kind": "diamond",
        "near": point,
        "right": {
            "x": point["x"] + ux * half + px * UML_MARKER_HALF_WIDTH,
            "y": point["y"] + uy * half + py * UML_MARKER_HALF_WIDTH,
        },
        "far": {"x": point["x"] + ux * UML_MARKER_LENGTH, "y": point["y"] + uy * UML_MARKER_LENGTH},
        "left": {
            "x": point["x"] + ux * half - px * UML_MARKER_HALF_WIDTH,
            "y": point["y"] + uy * half - py * UML_MARKER_HALF_WIDTH,
        },
        "filled": marker_kind == "diamond-filled",
    }


def _pt(p: Point) -> str:
    return f"{_t(p['x'])},{_t(p['y'])}"


def _render_uml_endpoint_glyph(glyph: dict[str, Any], stroke: str) -> str:
    kind = glyph["kind"]
    if kind in ("triangle", "diamond"):
        corners = (
            [glyph["tip"], glyph["baseLeft"], glyph["baseRight"]]
            if kind == "triangle"
            else [glyph["near"], glyph["right"], glyph["far"], glyph["left"]]
        )
        fill = stroke if glyph["filled"] else "white"
        return f'<polygon points="{" ".join(_pt(c) for c in corners)}" fill="{fill}" stroke="{stroke}" />'
    if kind == "open-arrow":
        tip = glyph["tip"]
        return "".join(
            f'<line x1="{_t(tip["x"])}" y1="{_t(tip["y"])}" x2="{_t(w["x"])}" y2="{_t(w["y"])}" stroke="{stroke}" />'
            for w in (glyph["wingLeft"], glyph["wingRight"])
        )
    return (
        f'<circle cx="{_t(glyph["cx"])}" cy="{_t(glyph["cy"])}" r="{_t(glyph["r"])}" fill="white" stroke="{stroke}" />'
    )


UML_CARDINALITY_LABEL_OFFSET = 16
UML_CARDINALITY_LABEL_SIDE_OFFSET = 8


def _uml_cardinality_label_position(point: Point, dx: float, dy: float) -> Point:
    length = _hypot_or_one(dx, dy)
    ux = dx / length
    uy = dy / length
    px = -uy
    py = ux
    return {
        "x": point["x"] + ux * UML_CARDINALITY_LABEL_OFFSET + px * UML_CARDINALITY_LABEL_SIDE_OFFSET,
        "y": point["y"] + uy * UML_CARDINALITY_LABEL_OFFSET + py * UML_CARDINALITY_LABEL_SIDE_OFFSET,
    }


def _render_uml_cardinality_label(position: Point, text: str) -> str:
    return (
        f'<text x="{_t(position["x"])}" y="{_t(position["y"])}" font-size="11" '
        f"font-family='{FONT_FAMILY}'>{escape_xml(text)}</text>"
    )


# --- colours ----------------------------------------------------------------------------------------------------

_LINE_TERMINATORS = {0x0A, 0x0D, 0x2028, 0x2029}
_HEX_DIGITS = "0123456789abcdefABCDEF"


def _code_units(text: str) -> list[int]:
    data = text.encode("utf-16-le", "surrogatepass")
    return [int.from_bytes(data[i : i + 2], "little") for i in range(0, len(data), 2)]


def _parse_int_hex(units: list[int]) -> float:
    """parseInt(pair, 16) for a two-code-unit string."""
    text = "".join(chr(u) for u in units)
    i = 0
    while i < len(text) and text[i] in JS_WHITESPACE_SET:
        i += 1
    rest = text[i:]
    sign = 1
    if rest[:1] in ("+", "-"):
        sign = -1 if rest[0] == "-" else 1
        rest = rest[1:]
    if rest[:2] in ("0x", "0X"):
        rest = rest[2:]
    digits = ""
    for ch in rest:
        if ch not in _HEX_DIGITS:
            break
        digits += ch
    return float(sign * int(digits, 16)) if digits else math.nan


def _expand_js_whitespace(spec: str) -> frozenset[str]:
    chars: set[str] = set()
    i = 0
    while i < len(spec):
        if i + 2 < len(spec) and spec[i + 1] == "-":
            chars.update(chr(c) for c in range(ord(spec[i]), ord(spec[i + 2]) + 1))
            i += 3
        else:
            chars.add(spec[i])
            i += 1
    return frozenset(chars)


JS_WHITESPACE_SET = _expand_js_whitespace(JS_WHITESPACE)


def _relative_luminance(hex_value: str) -> float:
    h = _code_units(hex_value.replace("#", "", 1))
    full = [u for u in h for _ in range(2)] if len(h) == 3 else h[:6]
    pairs: list[list[int]] = []
    i = 0
    while i + 1 < len(full):  # /../g: two code units, neither a line terminator
        if full[i] in _LINE_TERMINATORS:
            i += 1
        elif full[i + 1] in _LINE_TERMINATORS:
            i += 2
        else:
            pairs.append(full[i : i + 2])
            i += 2
    if len(pairs) < 3:
        return 1
    channels: list[float] = []
    for pair in pairs[:3]:
        v = _parse_int_hex(pair) / 255
        channels.append(v / 12.92 if v <= 0.03928 else math.pow((v + 0.055) / 1.055, 2.4) if v == v else math.nan)
    r, g, b = channels
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_text_color(fill_hex: str) -> str:
    return "#000000" if _relative_luminance(fill_hex) > 0.45 else "#ffffff"


# --- nodes ------------------------------------------------------------------------------------------------------


def _polygon(points: list[tuple[Any, Any]], fill: str, stroke: str) -> str:
    joined = " ".join(f"{_t(px)},{_t(py)}" for px, py in points)
    return f'<polygon points="{joined}" fill="{fill}" stroke="{stroke}" />'


def _render_node_shape(node: Node, diagram_type_id: Any = None) -> str:
    x, y = node["position"]["x"], node["position"]["y"]
    size = node_size(node)
    width, height = size["width"], size["height"]
    colours = resolve_node_fill_stroke(node, diagram_type_id)
    fill, stroke = _t(colours["fill"]), _t(colours["stroke"])
    shape = node.get("shape")

    def ellipse(rx: Any, ry: Any, fill_value: str) -> str:
        return (
            f'<ellipse cx="{_t(x + width / 2)}" cy="{_t(y + height / 2)}" rx="{_t(rx)}" ry="{_t(ry)}" '
            f'fill="{fill_value}" stroke="{stroke}" />'
        )

    def rect(extra: str = "") -> str:
        return (
            f'<rect x="{_t(x)}" y="{_t(y)}" width="{_t(width)}" height="{_t(height)}"{extra} '
            f'fill="{fill}" stroke="{stroke}" />'
        )

    if shape == "circle":
        return ellipse(width / 2, height / 2, fill)
    # canvas-bnnh: state diagrams' pseudo-states, drawn in the stroke colour.
    if shape == "state-start":
        return ellipse(width / 2, height / 2, stroke)
    if shape == "state-end":
        return ellipse(width / 2, height / 2, "none") + ellipse(_max(width / 2 - 4, 1), _max(height / 2 - 4, 1), stroke)
    if shape == "fork-bar":
        return (
            f'<rect x="{_t(x)}" y="{_t(y)}" width="{_t(width)}" height="{_t(height)}" rx="2" ry="2" '
            f'fill="{stroke}" stroke="{stroke}" />'
        )
    if shape == "diamond":
        points = [(x + width / 2, y), (x + width, y + height / 2), (x + width / 2, y + height), (x, y + height / 2)]
        return _polygon(points, fill, stroke)
    if shape == "cylinder":
        cap = _min(16, height / 4)
        return (
            f'<path d="M {_t(x)} {_t(y + cap)} L {_t(x)} {_t(y + height - cap)} A {_t(width / 2)} {_t(cap)} 0 0 0 '
            f"{_t(x + width)} {_t(y + height - cap)} L {_t(x + width)} {_t(y + cap)} A {_t(width / 2)} {_t(cap)} "
            f'0 0 0 {_t(x)} {_t(y + cap)} Z" fill="{fill}" stroke="{stroke}" />'
            f'<ellipse cx="{_t(x + width / 2)}" cy="{_t(y + cap)}" rx="{_t(width / 2)}" ry="{_t(cap)}" '
            f'fill="{fill}" stroke="{stroke}" />'
        )
    if shape == "rounded-rectangle":
        return rect(' rx="12" ry="12"')
    if shape == "stadium":
        return rect(f' rx="{_t(height / 2)}" ry="{_t(height / 2)}"')
    if shape == "subroutine":
        inset = _min(10, width / 6)
        return (
            rect()
            + f'<line x1="{_t(x + inset)}" y1="{_t(y)}" x2="{_t(x + inset)}" y2="{_t(y + height)}" stroke="{stroke}" />'
            + f'<line x1="{_t(x + width - inset)}" y1="{_t(y)}" x2="{_t(x + width - inset)}" y2="{_t(y + height)}" '
            f'stroke="{stroke}" />'
        )
    if shape == "double-circle":
        gap = 5
        return ellipse(width / 2, height / 2, fill) + ellipse(width / 2 - gap, height / 2 - gap, "none")
    if shape == "hexagon":
        notch = _min(20, width / 4)
        points = [
            (x + notch, y),
            (x + width - notch, y),
            (x + width, y + height / 2),
            (x + width - notch, y + height),
            (x + notch, y + height),
            (x, y + height / 2),
        ]
        return _polygon(points, fill, stroke)
    if shape in ("parallelogram", "parallelogram-alt", "trapezoid", "trapezoid-alt"):
        skew = _min(20, width / 5)
        corners = {
            "parallelogram": [(x + skew, y), (x + width, y), (x + width - skew, y + height), (x, y + height)],
            "parallelogram-alt": [(x, y), (x + width - skew, y), (x + width, y + height), (x + skew, y + height)],
            "trapezoid": [(x + skew, y), (x + width - skew, y), (x + width, y + height), (x, y + height)],
            "trapezoid-alt": [(x, y), (x + width, y), (x + width - skew, y + height), (x + skew, y + height)],
        }[shape]
        return _polygon(corners, fill, stroke)
    if shape == "asymmetric":
        notch = _min(20, width / 5)
        points = [
            (x, y),
            (x + width - notch, y),
            (x + width, y + height / 2),
            (x + width - notch, y + height),
            (x, y + height),
        ]
        return _polygon(points, fill, stroke)
    if shape == "person":
        head_r = clamp_person_head_radius(width, height)
        head_cx = x + width / 2
        head_cy = y + head_r + 4
        body_top = head_cy + head_r + 3
        body_r = _min(20, width / 4)
        body_path = (
            f"M {_t(x)} {_t(y + height)} L {_t(x)} {_t(body_top + body_r)} Q {_t(x)} {_t(body_top)} "
            f"{_t(x + body_r)} {_t(body_top)} L {_t(x + width - body_r)} {_t(body_top)} Q {_t(x + width)} "
            f"{_t(body_top)} {_t(x + width)} {_t(body_top + body_r)} L {_t(x + width)} {_t(y + height)} Z"
        )
        return (
            f'<g><path d="{body_path}" fill="{fill}" stroke="{stroke}" /><circle cx="{_t(head_cx)}" '
            f'cy="{_t(head_cy)}" r="{_t(head_r)}" fill="{fill}" stroke="{stroke}" /></g>'
        )
    return rect()


def _wrap_node_link(node: Node, markup: str) -> str:
    link: Any = node.get("link")
    if not js_truthy(link) or not is_allowed_link_href(link["href"]):
        return markup
    target_attr = ' target="_blank"' if link.get("target") == "_blank" else ""
    tooltip = link.get("tooltip")
    title = f"<title>{escape_xml(tooltip)}</title>" if js_truthy(tooltip) else ""
    return f'<a href="{escape_xml(link["href"])}"{target_attr}>{title}{markup}</a>'


def _diagram_link_href(element: dict[str, Any], diagram_link_base: str | None) -> str | None:
    """canvas-8uh1.4: the address a linked element opens in an export, if it links and the export has a base."""
    ref = element.get("diagramRef")
    if not diagram_link_base or not isinstance(ref, dict):
        return None
    href = f"{diagram_link_base}{quote(str(ref['diagramId']), safe=_URI_COMPONENT_SAFE)}"
    return href if is_allowed_link_href(href) else None


def with_diagram_link(element: dict[str, Any], markup: str, diagram_link_base: str | None) -> str:
    """An element's markup inside `<a href>` to the diagram it links to (a node's own click link wins)."""
    if js_truthy(element.get("link")):
        return markup
    href = _diagram_link_href(element, diagram_link_base)
    return f'<a href="{escape_xml(href)}">{markup}</a>' if href else markup


def _resolve(resolve_icon: IconResolver | None, icon: Any) -> str | None:
    if not js_truthy(icon) or resolve_icon is None:
        return None
    return resolve_icon(icon)


_BOLD = ' font-weight="bold"'


def clip_icon_artwork(markup: str) -> str:
    """canvas-1bty.20: icon artwork inside its own 48x48 box (the icon space), clipped there, so a library icon's
    shapes can't paint over -- or pass for -- the rest of the diagram."""
    return f'<svg x="0" y="0" width="48" height="48" viewBox="0 0 48 48" overflow="hidden">{markup}</svg>'


def _render_node(node: Node, resolve_icon: IconResolver | None = None, diagram_type_id: Any = None) -> str:
    x = node["position"]["x"]
    size = node_size(node)
    width = size["width"]
    font_size = _font_size(node)
    label_max_width = _max(width - 16, 40)
    open_g = f'<g data-node-id="{escape_xml(node["id"])}">'

    icon_markup = _resolve(resolve_icon, node.get("icon"))
    if js_truthy(icon_markup):
        layout = icon_node_layout(node)
        return _wrap_node_link(
            node,
            open_g
            + _render_node_shape(node, diagram_type_id)
            + f'<g transform="translate({_t(layout["iconX"])}, {_t(layout["iconY"])}) '
            f'scale({_t(layout["iconSize"] / 48)})">{clip_icon_artwork(_t(icon_markup))}</g>'
            + _render_label_text(
                layout["labelX"],
                layout["labelY"],
                node["label"],
                layout["labelFontSize"],
                False,
                layout["labelMaxWidth"],
            )
            + "</g>",
        )

    table = table_node_layout(node)
    if table is not None:
        stroke = _get(_style(node), "strokeColor")
        stroke = "#333333" if stroke is None else _t(stroke)
        stereotype = table["stereotype"]
        stereotype_markup = (
            f'<text x="{_t(stereotype["x"])}" y="{_t(stereotype["y"])}" text-anchor="middle" '
            f"font-size=\"{_t(stereotype['fontSize'])}\" font-family='{FONT_FAMILY}'>"
            f"{escape_xml(stereotype['text'])}</text>"
            if stereotype
            else ""
        )
        rows = "".join(
            f'<text x="{_t(row["x"])}" y="{_t(row["y"])}" dominant-baseline="middle" '
            f"font-size=\"{_t(row['fontSize'])}\" font-family='{FONT_FAMILY}'>{escape_xml(row['text'])}</text>"
            for row in table["rows"]
        )
        return _wrap_node_link(
            node,
            open_g
            + _render_node_shape(node, diagram_type_id)
            + f'<line x1="{_t(x)}" y1="{_t(table["dividerY"])}" x2="{_t(x + width)}" y2="{_t(table["dividerY"])}" '
            f'stroke="{stroke}" />'
            + stereotype_markup
            + _render_label_text(
                table["headerX"], table["headerY"], node["label"], table["headerFontSize"], True, label_max_width
            )
            + rows
            + "</g>",
        )

    # canvas-bnnh: pseudo-states carry no text.
    if pseudo_state_size(node) is not None and not js_truthy(node.get("label")):
        return _wrap_node_link(node, open_g + _render_node_shape(node, diagram_type_id) + "</g>")
    icon: Any = node.get("icon")
    raw_label = f"{_t(node['label'])} [{_template_field(icon, 'iconId')}]" if js_truthy(icon) else node["label"]
    plain_fill = resolve_node_fill_stroke(node, diagram_type_id)["fill"]
    described = described_node_layout(node)
    if described is not None:
        text_color = contrast_text_color(plain_fill)
        lines = "".join(
            f'<text x="{_t(line["x"])}" y="{_t(line["y"])}" dominant-baseline="middle" text-anchor="middle" '
            f'font-size="{_t(line["fontSize"])}"{_BOLD if line["bold"] else ""} '
            f"font-family='{FONT_FAMILY}' fill=\"{text_color}\">{escape_xml(line['text'])}</text>"
            for line in described
        )
        return _wrap_node_link(node, open_g + _render_node_shape(node, diagram_type_id) + lines + "</g>")
    return _wrap_node_link(
        node,
        open_g
        + _render_node_shape(node, diagram_type_id)
        + _render_label_text(
            x + width / 2,
            _plain_label_center_y(node),
            raw_label,
            font_size,
            True,
            label_max_width,
            contrast_text_color(plain_fill),
        )
        + "</g>",
    )


# --- containers -------------------------------------------------------------------------------------------------

NOTE_ROLES = {"note-left", "note-right", "note-over", "note"}
C4_BOUNDARY_ROLES = {"boundary", "system-boundary", "container-boundary", "enterprise-boundary", "deployment-node"}


def container_role_style(role: Any) -> dict[str, Any]:
    if js_truthy(role) and role in NOTE_ROLES:
        return {"defaultFill": "#fff9c4", "stroke": "#c9a94a"}
    if role == "box":
        return {"defaultFill": "none", "stroke": "#999999", "strokeDasharray": "2,3"}
    if role == "namespace":
        return {"defaultFill": "#f7f7f7", "stroke": "#555555", "headerBand": True}
    # canvas-bnnh: a composite state, and a concurrent region inside one.
    if role == "composite":
        return {"defaultFill": "#ffffff", "stroke": "#555555", "headerBand": True}
    if role == "region":
        return {"defaultFill": "none", "stroke": "#888888", "strokeDasharray": "6,4"}
    if js_truthy(role) and role in C4_BOUNDARY_ROLES:
        return {"defaultFill": "none", "stroke": "#444444", "strokeDasharray": "7.5,4.5"}
    return {"defaultFill": "none", "stroke": "#888888", "strokeDasharray": "6,4"}


def _render_attachment_connectors(container: Container, width: Any, height: Any, targets: list[Point]) -> str:
    if not targets:
        return ""
    cx = container["position"]["x"] + width / 2
    cy = container["position"]["y"] + height / 2
    return "".join(
        f'<line x1="{_t(cx)}" y1="{_t(cy)}" x2="{_t(t["x"])}" y2="{_t(t["y"])}" stroke="#999999" '
        f'stroke-dasharray="2,2" />'
        for t in targets
    )


def _container_header_layout(container: Container, header_band: bool, has_icon: bool) -> dict[str, Any]:
    x, y = container["position"]["x"], container["position"]["y"]
    icon_size = 16
    label_y = y + (14 if header_band else 16)
    icon_x = x + 6
    icon_y = label_y - 12
    return {
        "iconX": icon_x,
        "iconY": icon_y,
        "iconSize": icon_size,
        "labelX": icon_x + icon_size + 4 if has_icon else x + 8,
        "labelY": label_y,
    }


def _render_container(
    container: Container,
    connector_targets: list[Point] | None = None,
    resolve_icon: IconResolver | None = None,
    paragraph_note: bool = False,
) -> str:
    x, y = container["position"]["x"], container["position"]["y"]
    size = container.get("size")
    if size is None:
        size = {"width": 300, "height": 200}
    width, height = size["width"], size["height"]
    icon_markup = _resolve(resolve_icon, container.get("icon"))
    role_style = container_role_style(container.get("role"))
    fill = _get(_style(container), "fillColor")
    fill = role_style["defaultFill"] if fill is None else _t(fill)
    dash = role_style.get("strokeDasharray")
    dasharray = f' stroke-dasharray="{dash}"' if dash else ""
    connectors = _render_attachment_connectors(container, width, height, connector_targets or [])
    header_band = bool(role_style.get("headerBand"))
    header = _container_header_layout(container, header_band, js_truthy(icon_markup))
    icon_part = (
        f'<g transform="translate({_t(header["iconX"])}, {_t(header["iconY"])}) '
        f'scale({_t(header["iconSize"] / 48)})">{clip_icon_artwork(_t(icon_markup))}</g>'
        if js_truthy(icon_markup)
        else ""
    )
    box = (
        f'<rect x="{_t(x)}" y="{_t(y)}" width="{_t(width)}" height="{_t(height)}" fill="{fill}" '
        f'stroke="{role_style["stroke"]}"{dasharray} />'
    )
    band = (
        f'<rect x="{_t(x)}" y="{_t(y)}" width="{_t(width)}" height="20" fill="{role_style["stroke"]}" opacity="0.18" />'
        if header_band
        else ""
    )
    if paragraph_note and container.get("role") in ("note-left", "note-right"):
        # canvas-bnnh: a state diagram's note holds a paragraph, wrapped and centred.
        text = _render_label_text(x + width / 2, y + height / 2, container["label"], 12, True, _max(width - 16, 40))
    else:
        text = (
            f'<text x="{_t(header["labelX"])}" y="{_t(header["labelY"])}" font-size="12" '
            f"font-family='{FONT_FAMILY}'>{escape_xml(container['label'])}</text>"
        )
    return f'<g data-container-id="{escape_xml(container["id"])}">{connectors}{box}{band}{icon_part}{text}</g>'


# --- edges ------------------------------------------------------------------------------------------------------


def _stroke_attributes(edge: Edge, dashed: bool) -> tuple[str, str]:
    style = _style(edge)
    width = _get(style, "strokeWidth")
    if width is None:
        width = DEFAULT_THICK_STROKE_WIDTH if edge.get("lineStyle") == "thick" else None
    stroke_width = f' stroke-width="{_t(width)}"' if js_truthy(width) else ""
    dash = _get(style, "strokeDasharray")
    if dash is None:
        dash = DEFAULT_DOTTED_DASHARRAY if edge.get("lineStyle") == "dotted" or dashed else None
    stroke_dasharray = f' stroke-dasharray="{_t(dash)}"' if js_truthy(dash) else ""
    return stroke_width, stroke_dasharray


#: canvas-y2yf: the gap between connectors that join the same two shapes.
PARALLEL_EDGE_GAP = 18


def _js_less(a: Any, b: Any) -> bool:
    """JavaScript's `a < b` for two ids (strings compare by UTF-16 code unit)."""
    if isinstance(a, str) and isinstance(b, str):
        return js_string_gt(b, a)
    return False


def edge_lanes(edges: list[Edge]) -> dict[Any, dict[str, int]]:
    """canvas-y2yf (svg-renderer.ts edgeLanes): each connector's place among those joining the same two shapes."""
    pairs: dict[str, list[Any]] = {}
    for edge in edges:
        source, target = edge.get("sourceId"), edge.get("targetId")
        a, b = (source, target) if _js_less(source, target) else (target, source)
        pairs.setdefault(f"{js_template(a)}\u0000{js_template(b)}", []).append(edge.get("id"))
    lanes: dict[Any, dict[str, int]] = {}
    for ids in pairs.values():
        for index, edge_id in enumerate(ids):
            lanes[edge_id] = {"index": index, "count": len(ids)}
    return lanes


def lane_shift(
    edge: Edge, lane: dict[str, int] | None, start: Point, end: Point, start_size: Any, end_size: Any
) -> Point:
    """canvas-y2yf (laneShift): how far to move a connector sideways for its lane."""
    if lane is None or lane["count"] < 2:
        return {"x": 0, "y": 0}
    forward = _js_less(edge.get("sourceId"), edge.get("targetId"))
    dx = end["x"] - start["x"] if forward else start["x"] - end["x"]
    dy = end["y"] - start["y"] if forward else start["y"] - end["y"]
    length = js_hypot(dx, dy)
    if length == 0:
        return {"x": 0, "y": 0}
    px, py = -dy / length, dx / length

    def across(size: Any) -> float:
        return float(abs(px) * size["width"] + abs(py) * size["height"])

    gap = _min(PARALLEL_EDGE_GAP, (0.8 * _min(across(start_size), across(end_size))) / (lane["count"] - 1))
    offset = (lane["index"] - (lane["count"] - 1) / 2) * gap
    return {"x": px * offset, "y": py * offset}


def self_loop_geometry(position: Point, size: Any, index: int) -> dict[str, Any]:
    """canvas-y2yf (selfLoopGeometry): a loop off the shape's top-right corner, and where its label goes."""
    reach = 32 + index * PARALLEL_EDGE_GAP
    # canvas-xpuk: on a big box (a composite state) the loop stays at the corner.
    start_x = position["x"] + size["width"] - _min(size["width"] / 4, 40)
    start_y = position["y"]
    end_x = position["x"] + size["width"]
    end_y = position["y"] + _min(size["height"] / 4, 40)
    path = (
        f"M {_t(start_x)} {_t(start_y)} C {_t(start_x)} {_t(start_y - reach)}, {_t(end_x + reach)} {_t(end_y)}, "
        f"{_t(end_x)} {_t(end_y)}"
    )
    return {"path": path, "labelX": end_x + reach / 2 + 4, "labelY": start_y - reach / 2 - 4}


def _move_by(point: Point, shift: Point) -> Point:
    if shift["x"] == 0 and shift["y"] == 0:
        return point
    return {"x": point["x"] + shift["x"], "y": point["y"] + shift["y"]}


def _render_self_loop(edge: Edge, node: Node, index: int) -> str:
    loop = self_loop_geometry(node["position"], node_size(node), index)
    invisible = edge.get("lineStyle") == "invisible"
    stroke_color = _get(_style(edge), "strokeColor")
    stroke = "none" if invisible else ("#333333" if stroke_color is None else _t(stroke_color))
    stroke_width, stroke_dasharray = _stroke_attributes(edge, False)
    marker = "" if invisible or edge.get("arrow") == "none" else ' marker-end="url(#arrowhead)"'
    label = (
        _render_label_text(loop["labelX"], loop["labelY"], edge["label"], 12, False)
        if js_truthy(edge.get("label"))
        else ""
    )
    return (
        f'<g data-edge-id="{escape_xml(edge["id"])}"><path d="{loop["path"]}" fill="none" stroke="{stroke}"'
        f"{stroke_width}{stroke_dasharray}{marker} />{label}</g>"
    )


def _render_edge(
    edge: Edge,
    nodes_by_id: dict[str, Node],
    containers_by_id: dict[str, Container],
    lane: dict[str, int] | None = None,
) -> str:
    source = nodes_by_id.get(edge.get("sourceId")) or container_as_endpoint(  # type: ignore[arg-type]
        containers_by_id.get(edge.get("sourceId"))  # type: ignore[arg-type]
    )
    target = nodes_by_id.get(edge.get("targetId")) or container_as_endpoint(  # type: ignore[arg-type]
        containers_by_id.get(edge.get("targetId"))  # type: ignore[arg-type]
    )
    if source is None or target is None:
        return ""
    if edge.get("sourceId") == edge.get("targetId"):
        return _render_self_loop(edge, source, lane["index"] if lane is not None else 0)
    center_start, center_end = _node_center(source), _node_center(target)
    shift = lane_shift(edge, lane, center_start, center_end, node_size(source), node_size(target))
    start = {"x": center_start["x"] + shift["x"], "y": center_start["y"] + shift["y"]}
    end = {"x": center_end["x"] + shift["x"], "y": center_end["y"] + shift["y"]}
    mid_x = (start["x"] + end["x"]) / 2
    mid_y = (start["y"] + end["y"]) / 2
    source_box = _architecture_endpoint_box(source, edge.get("sourceIsGroup"), containers_by_id)
    target_box = _architecture_endpoint_box(target, edge.get("targetIsGroup"), containers_by_id)
    sc, tc = source_box["center"], target_box["center"]
    clipped_from = (
        _clip_to_anchor_side(sc, source_box["size"], edge["sourceAnchor"])
        if js_truthy(edge.get("sourceAnchor"))
        else clip_edge_endpoint(sc, source_box["size"], source_box["shape"], tc["x"], tc["y"])
    )
    clipped_to = (
        _clip_to_anchor_side(tc, target_box["size"], edge["targetAnchor"])
        if js_truthy(edge.get("targetAnchor"))
        else clip_edge_endpoint(tc, target_box["size"], target_box["shape"], sc["x"], sc["y"])
    )
    if clipped_from is None or clipped_to is None:
        raise TypeError("anchor is not T, B, L or R")  # TypeScript reads .x of undefined
    clipped_from, clipped_to = _move_by(clipped_from, shift), _move_by(clipped_to, shift)
    # canvas-xpuk: a connector to or from a group labels the middle of the line as drawn.
    touches_group = edge.get("sourceId") not in nodes_by_id or edge.get("targetId") not in nodes_by_id
    label_mid = (
        {"x": (clipped_from["x"] + clipped_to["x"]) / 2, "y": (clipped_from["y"] + clipped_to["y"]) / 2}
        if touches_group
        else {"x": mid_x, "y": mid_y}
    )
    placed = edge_label_placement(label_mid, shift)
    label = (
        _render_label_text(placed["x"], placed["y"], edge["label"], 12, False, None, "#000000", placed["anchor"])
        if js_truthy(edge.get("label"))
        else ""
    )
    technology = edge.get("technology")
    technology_markup = (
        f'<text x="{_t(mid_x)}" y="{_t(mid_y + 10)}" text-anchor="middle" font-size="10" '
        f"font-family='{FONT_FAMILY}' fill=\"#555555\">{escape_xml(f'[{_t(technology)}]')}</text>"
        if js_truthy(technology)
        else ""
    )
    invisible = edge.get("lineStyle") == "invisible"
    stroke_color = _get(_style(edge), "strokeColor")
    stroke = "none" if invisible else ("#333333" if stroke_color is None else _t(stroke_color))
    kind = edge.get("umlRelationKind")
    uml = _uml_endpoint_markers(kind) if js_truthy(kind) else None
    stroke_width, stroke_dasharray = _stroke_attributes(edge, bool(uml and uml["dashed"]))
    er_source: Any = edge.get("erSourceCardinality")
    er_target: Any = edge.get("erTargetCardinality")
    has_er = js_truthy(er_source) and js_truthy(er_target)
    suppress = has_er or uml is not None
    arrow = edge.get("arrow")
    marker_end = "" if invisible or suppress or arrow == "none" else ' marker-end="url(#arrowhead)"'
    marker_start = ' marker-start="url(#arrowhead)"' if not invisible and not suppress and arrow == "both" else ""
    dx, dy = end["x"] - start["x"], end["y"] - start["y"]
    rdx, rdy = start["x"] - end["x"], start["y"] - end["y"]
    cardinality = ""
    if not invisible and has_er:
        glyphs = _cardinality_glyphs(clipped_from, dx, dy, er_source) + _cardinality_glyphs(
            clipped_to, rdx, rdy, er_target[::-1]
        )
        cardinality = "".join(_render_cardinality_glyph(g, stroke) for g in glyphs)
    uml_markup = ""
    if not invisible and uml is not None:
        parts = []
        if js_truthy(uml.get("source")):
            parts.append(_uml_endpoint_glyph(clipped_from, dx, dy, uml["source"]))
        if js_truthy(uml.get("target")):
            parts.append(_uml_endpoint_glyph(clipped_to, rdx, rdy, uml["target"]))
        uml_markup = "".join(_render_uml_endpoint_glyph(g, stroke) for g in parts)
    cardinality_labels = ""
    if not invisible:
        source_card: Any = edge.get("sourceCardinality")
        target_card: Any = edge.get("targetCardinality")
        if js_truthy(source_card):
            position = _uml_cardinality_label_position(clipped_from, dx, dy)
            cardinality_labels += _render_uml_cardinality_label(position, source_card)
        if js_truthy(target_card):
            position = _uml_cardinality_label_position(clipped_to, rdx, rdy)
            cardinality_labels += _render_uml_cardinality_label(position, target_card)
    line = (
        f'<line x1="{_t(clipped_from["x"])}" y1="{_t(clipped_from["y"])}" x2="{_t(clipped_to["x"])}" '
        f'y2="{_t(clipped_to["y"])}" stroke="{stroke}"{stroke_width}{stroke_dasharray}{marker_start}{marker_end} />'
    )
    return (
        f'<g data-edge-id="{escape_xml(edge["id"])}">{line}{cardinality}{uml_markup}{cardinality_labels}'
        f"{label}{technology_markup}</g>"
    )


# --- bounds -----------------------------------------------------------------------------------------------------


def _content_bounds(model: Model) -> dict[str, Any]:
    if model.get("diagramTypeId") == "sequence":
        layout = compute_sequence_layout(model)
        return {"width": layout["diagramWidth"], "height": layout["diagramHeight"]}
    if model.get("diagramTypeId") == "wardley":
        frame = wardley_frame(model)
        return {"width": frame["width"], "height": frame["height"]}
    max_x: Any = 400
    max_y: Any = 300
    for node in model["nodes"]:
        size = node_size(node)
        max_x = _max(max_x, node["position"]["x"] + size["width"] + 40)
        max_y = _max(max_y, node["position"]["y"] + size["height"] + 40)
    for container in model["containers"]:
        size = container_size(container)
        max_x = _max(max_x, container["position"]["x"] + size["width"] + 40)
        max_y = _max(max_y, container["position"]["y"] + size["height"] + 40)
    return {"width": max_x, "height": max_y}


def compute_bounds(model: Model, legend_entries: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    content = _content_bounds(model)
    if legend_entries is None:
        return content
    legend = legend_layout(model, legend_entries, content)
    if legend is None:
        return content
    return {
        "width": _max(content["width"], legend["x"] + legend["width"] + 40),
        "height": _max(content["height"], legend["y"] + legend["height"] + 40),
    }


# --- sequence diagrams ------------------------------------------------------------------------------------------

CONTROL_FLOW_STROKE = "#5b6b8c"
CONTROL_FLOW_DASHARRAY = "4,2"
CONTROL_FLOW_TAB_FILL = "#e8ecf5"
_BLOCK_ROLES = {"loop", "alt", "opt", "par", "critical", "break", "rect"}
_DIVIDER_ROLES = {"else", "and", "option"}
_SEQUENCE_NOTE_ROLES = {"note-left", "note-right", "note-over"}

_DEFS = (
    "<defs>"
    '<marker id="arrowhead" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto-start-reverse">'
    '<path d="M0,0 L0,6 L9,3 z" fill="#333333" />'
    "</marker>"
    "</defs>"
)


def _svg_open(width: Any, height: Any) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{_t(width)}" height="{_t(height)}" '
        f'viewBox="0 0 {_t(width)} {_t(height)}">'
    )


def _render_sequence_lifeline(node: Node, layout: dict[str, Any], resolve_icon: IconResolver | None) -> str:
    lifeline = layout["lifelines"].get(node["id"])
    if lifeline is None:
        return ""
    positioned = {
        **node,
        "position": {"x": lifeline["headerX"], "y": lifeline["headerY"]},
        "size": {"width": lifeline["headerWidth"], "height": lifeline["headerHeight"]},
    }
    line = (
        f'<line x1="{_t(lifeline["x"])}" y1="{_t(lifeline["top"])}" x2="{_t(lifeline["x"])}" '
        f'y2="{_t(lifeline["bottom"])}" stroke="#888888" stroke-dasharray="4,2" />'
    )
    return line + _render_node(positioned, resolve_icon)


_HALF_ARROW = re.compile(r"^(half|stick)-(top|bottom)(-reverse)?\Z")


def sequence_message_glyphs(edge: Edge, start: Point, start_dir: int, end: Point, end_dir: int) -> list[dict[str, Any]]:
    """canvas-8wxq (svg-renderer.ts sequenceMessageGlyphs): a half arrowhead or barb, and central-connection circles."""
    glyphs: list[dict[str, Any]] = []
    arrow = edge.get("arrow")
    match = _HALF_ARROW.match(arrow) if isinstance(arrow, str) else None
    if match:
        form, side, reverse = match.groups()
        tip = start if reverse else end
        direction = start_dir if reverse else end_dir
        back = tip["x"] - direction * 9
        barb = {"x": back, "y": tip["y"] + (-5 if side == "top" else 5)}
        if form == "half":
            glyphs.append({"kind": "half", "points": [tip, barb, {"x": back, "y": tip["y"]}]})
        else:
            glyphs.append({"kind": "stick", "from": tip, "to": barb})
    if js_truthy(edge.get("centralSource")):
        glyphs.append({"kind": "central", "cx": start["x"], "cy": start["y"], "r": 4})
    if js_truthy(edge.get("centralTarget")):
        glyphs.append({"kind": "central", "cx": end["x"], "cy": end["y"], "r": 4})
    return glyphs


def _render_sequence_glyph(glyph: dict[str, Any], stroke: str) -> str:
    if glyph["kind"] == "half":
        points = " ".join(f"{_t(p['x'])},{_t(p['y'])}" for p in glyph["points"])
        return f'<polygon points="{points}" fill="{stroke}" stroke="{stroke}" />'
    if glyph["kind"] == "stick":
        start, end = glyph["from"], glyph["to"]
        return (
            f'<line x1="{_t(start["x"])}" y1="{_t(start["y"])}" x2="{_t(end["x"])}" y2="{_t(end["y"])}" '
            f'stroke="{stroke}" />'
        )
    return (
        f'<circle cx="{_t(glyph["cx"])}" cy="{_t(glyph["cy"])}" r="{_t(glyph["r"])}" fill="#ffffff" '
        f'stroke="{stroke}" />'
    )


def _render_sequence_message(edge: Edge, layout: dict[str, Any]) -> str:
    message = layout["messages"].get(edge["id"])
    source = layout["lifelines"].get(edge.get("sourceId"))
    target = layout["lifelines"].get(edge.get("targetId"))
    if message is None or source is None or target is None:
        return ""
    stroke_color = _get(_style(edge), "strokeColor")
    stroke = "#333333" if stroke_color is None else _t(stroke_color)
    stroke_width, stroke_dasharray = _stroke_attributes(edge, False)
    arrow = edge.get("arrow")
    is_half = isinstance(arrow, str) and _HALF_ARROW.match(arrow) is not None
    marker_end = "" if arrow == "none" or is_half else ' marker-end="url(#arrowhead)"'
    marker_start = ' marker-start="url(#arrowhead)"' if arrow == "both" else ""
    y = message["y"]
    is_self = js_truthy(message.get("isSelfMessage"))
    label_x = source["x"] + SELF_MESSAGE_LOOP_WIDTH / 2 if is_self else (source["x"] + target["x"]) / 2
    label = _render_label_text(label_x, y - 4, edge["label"], 12, False) if js_truthy(edge.get("label")) else ""
    if is_self:
        line = (
            f'<path d="M {_t(source["x"])} {_t(y)} H {_t(source["x"] + SELF_MESSAGE_LOOP_WIDTH)} V {_t(y + 20)} '
            f'H {_t(source["x"])}" fill="none" stroke="{stroke}"{stroke_width}{stroke_dasharray}{marker_end} />'
        )
    else:
        line = (
            f'<line x1="{_t(source["x"])}" y1="{_t(y)}" x2="{_t(target["x"])}" y2="{_t(y)}" stroke="{stroke}"'
            f"{stroke_width}{stroke_dasharray}{marker_start}{marker_end} />"
        )
    if is_self:
        glyphs = sequence_message_glyphs(edge, {"x": source["x"], "y": y}, -1, {"x": source["x"], "y": y + 20}, -1)
    else:
        rightward = target["x"] >= source["x"]
        glyphs = sequence_message_glyphs(
            edge, {"x": source["x"], "y": y}, -1 if rightward else 1, {"x": target["x"], "y": y}, 1 if rightward else -1
        )
    glyph_markup = "".join(_render_sequence_glyph(glyph, stroke) for glyph in glyphs)
    return f'<g data-edge-id="{escape_xml(edge["id"])}">{line}{glyph_markup}{label}</g>'


def _render_sequence_activation(container: Container, layout: dict[str, Any]) -> str:
    bar = layout["activations"].get(container["id"])
    if bar is None:
        return ""
    return (
        f'<g data-container-id="{escape_xml(container["id"])}"><rect x="{_t(bar["x"] - bar["width"] / 2)}" '
        f'y="{_t(bar["yStart"])}" width="{_t(bar["width"])}" height="{_t(bar["yEnd"] - bar["yStart"])}" '
        f'fill="#ffffff" stroke="#333333" /></g>'
    )


def _render_sequence_block(container: Container, layout: dict[str, Any]) -> str:
    block = layout["blocks"].get(container["id"])
    if block is None:
        return ""
    role = container.get("role")
    has_label = js_truthy(container.get("label"))
    label_text = f"{_t(role)} {_t(container['label'])}" if has_label else ("" if role is None else role)
    open_g = f'<g data-container-id="{escape_xml(container["id"])}">'
    if js_truthy(block.get("isDivider")):
        divider_label = _render_label_text(block["x"] + 8, block["y"] - 4, label_text, 12, False) if has_label else ""
        return (
            f'{open_g}<line x1="{_t(block["x"])}" y1="{_t(block["y"])}" x2="{_t(block["x"] + block["width"])}" '
            f'y2="{_t(block["y"])}" stroke="{CONTROL_FLOW_STROKE}" stroke-dasharray="{CONTROL_FLOW_DASHARRAY}" />'
            f"{divider_label}</g>"
        )
    is_rect = role == "rect"
    fill = _get(_style(container), "fillColor")
    fill = "none" if fill is None else _t(fill)
    stroke = "#888888" if is_rect else CONTROL_FLOW_STROKE
    dasharray = "6,4" if is_rect else CONTROL_FLOW_DASHARRAY
    tab_width = _min(block["width"], js_len(label_text) * 7 + 16)
    corner_tab = (
        ""
        if is_rect
        else f'<rect x="{_t(block["x"])}" y="{_t(block["y"])}" width="{_t(tab_width)}" height="18" '
        f'fill="{CONTROL_FLOW_TAB_FILL}" stroke="{stroke}" />'
    )
    corner_label = "" if is_rect else _render_label_text(block["x"] + 8, block["y"] + 14, label_text, 12, False)
    box = (
        f'<rect x="{_t(block["x"])}" y="{_t(block["y"])}" width="{_t(block["width"])}" '
        f'height="{_t(block["height"])}" fill="{fill}" stroke="{stroke}" stroke-dasharray="{dasharray}" />'
    )
    return f"{open_g}{box}{corner_tab}{corner_label}</g>"


def _render_sequence_note_or_box(container: Container, layout: dict[str, Any]) -> str:
    note = layout["notes"].get(container["id"])
    if note is not None:
        positioned = {**container, "position": note}
        size = container.get("size")
        note_height = _get(size, "height")
        note_height = 0 if note_height is None else note_height
        targets = [
            {"x": lifeline["x"], "y": note["y"] + note_height / 2}
            for node_id in (container.get("attachedNodeIds") or [])
            if (lifeline := layout["lifelines"].get(node_id)) is not None
        ]
        return _render_container(positioned, targets)
    box = layout["boxes"].get(container["id"])
    if box is not None:
        positioned = {
            **container,
            "position": {"x": box["x"], "y": box["y"]},
            "size": {"width": box["width"], "height": box["height"]},
        }
        return _render_container(positioned)
    return ""


def _render_sequence_svg(model: Model, resolve_icon: IconResolver | None, diagram_link_base: str | None) -> str:
    layout = compute_sequence_layout(model)
    containers = model["containers"]
    boxes = "".join(_render_sequence_note_or_box(c, layout) for c in containers if c.get("role") == "box")
    blocks = "".join(
        _render_sequence_block(c, layout)
        for c in containers
        if js_truthy(c.get("role")) and (c["role"] in _BLOCK_ROLES or c["role"] in _DIVIDER_ROLES)
    )
    messages = "".join(_render_sequence_message(e, layout) for e in model["edges"])
    activations = "".join(_render_sequence_activation(c, layout) for c in containers if c.get("role") == "activate")
    notes = "".join(
        _render_sequence_note_or_box(c, layout)
        for c in containers
        if js_truthy(c.get("role")) and c["role"] in _SEQUENCE_NOTE_ROLES
    )
    lifelines = "".join(
        with_diagram_link(n, _render_sequence_lifeline(n, layout, resolve_icon), diagram_link_base)
        for n in model["nodes"]
    )
    return (
        _svg_open(layout["diagramWidth"], layout["diagramHeight"])
        + _DEFS
        + boxes
        + blocks
        + messages
        + activations
        + notes
        + lifelines
        + "</svg>"
    )


# --- legend -----------------------------------------------------------------------------------------------------

_LEGEND_DASH = {"dotted": "4,3", "invisible": "2,4"}


def render_legend(layout: dict[str, Any], diagram_type_id: Any = None) -> str:
    m = LEGEND_METRICS
    parts = [
        '<g class="legend">',
        f'<rect x="{_t(layout["x"])}" y="{_t(layout["y"])}" width="{_t(layout["width"])}" '
        f'height="{_t(layout["height"])}" rx="6" ry="6" fill="#ffffff" stroke="#cccccc" />',
    ]
    title = layout.get("title")
    if title:
        parts.append(
            f'<text x="{_t(title["x"])}" y="{_t(title["y"])}" font-family="sans-serif" '
            f'font-size="{_t(m["fontSize"])}" font-weight="bold" fill="#333333">{escape_xml(title["text"])}</text>'
        )
    for row in layout["rows"]:
        mid_y = row["y"] + m["rowHeight"] / 2
        sample = row["entry"]["sample"]
        if sample.get("kind") == "shape":
            w = m["sampleHeight"] if sample.get("shape") == "person" else m["sampleWidth"]
            style: dict[str, Any] = {}
            if js_truthy(sample.get("fill")):
                style["fillColor"] = sample["fill"]
            if js_truthy(sample.get("stroke")):
                style["strokeColor"] = sample["stroke"]
            node = {
                "id": f"legend-{_t(row['entry']['key'])}",
                "label": "",
                "shape": sample.get("shape"),
                "position": {"x": row["sampleX"] + (m["sampleWidth"] - w) / 2, "y": mid_y - m["sampleHeight"] / 2},
                "size": {"width": w, "height": m["sampleHeight"]},
                "style": style,
            }
            parts.append(_render_node_shape(node, diagram_type_id))
        else:
            stroke = sample.get("stroke")
            stroke = "#333333" if stroke is None else _t(stroke)
            line_style = sample.get("lineStyle")
            width = 3 if line_style == "thick" else 1.5
            dash = _LEGEND_DASH.get("" if line_style is None else line_style)
            arrow = sample.get("arrow")
            end = ' marker-end="url(#arrowhead)"' if arrow in ("target", "both", None) else ""
            start = ' marker-start="url(#arrowhead)"' if arrow in ("source", "both") else ""
            dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
            parts.append(
                f'<line x1="{_t(row["sampleX"])}" y1="{_t(mid_y)}" x2="{_t(row["sampleX"] + m["sampleWidth"])}" '
                f'y2="{_t(mid_y)}" stroke="{stroke}" stroke-width="{_t(width)}"{dash_attr}{end}{start} />'
            )
        parts.append(
            f'<text x="{_t(row["labelX"])}" y="{_t(mid_y + m["fontSize"] / 3)}" font-family="sans-serif" '
            f'font-size="{_t(m["fontSize"])}" fill="#333333">{escape_xml(row["entry"]["label"])}</text>'
        )
    parts.append("</g>")
    return "".join(parts)


# --- the whole drawing ------------------------------------------------------------------------------------------

_BACKGROUND = re.compile(r"#[0-9a-fA-F]{3,8}")


def _with_background(svg: str, background: Any) -> str:
    if not isinstance(background, str) or not background or not _BACKGROUND.fullmatch(background):
        return svg
    opening = svg.index(">") + 1
    return f'{svg[:opening]}<rect width="100%" height="100%" fill="{background}" />{svg[opening:]}'


def _render_diagram_svg(
    model: Model, resolve_icon: IconResolver | None, standard_rules: Any, diagram_link_base: str | None = None
) -> str:
    if model.get("diagramTypeId") == "sequence":
        return _render_sequence_svg(model, resolve_icon, diagram_link_base)
    if model.get("diagramTypeId") == "wardley":
        return render_wardley_svg(model, lambda node, markup: with_diagram_link(node, markup, diagram_link_base))
    nodes_by_id = {n["id"]: n for n in model["nodes"]}
    containers_by_id = {c["id"]: c for c in model["containers"]}
    legend_model = model.get("legend")
    visible = js_truthy(_get(legend_model, "visible"))
    legend_entries = compute_legend_entries(model, standard_rules) if visible else []
    bounds = compute_bounds(model, legend_entries)
    legend = legend_layout(model, legend_entries, _content_bounds(model))

    container_markup = "".join(
        with_diagram_link(
            c,
            _render_container(
                c,
                [
                    _node_center(nodes_by_id[node_id])
                    for node_id in (c.get("attachedNodeIds") or [])
                    if node_id in nodes_by_id
                ],
                resolve_icon,
                True,
            ),
            diagram_link_base,
        )
        for c in model["containers"]
    )
    lanes = edge_lanes(model["edges"])
    edge_markup = "".join(
        _render_edge(e, nodes_by_id, containers_by_id, lanes.get(e.get("id"))) for e in model["edges"]
    )
    diagram_type_id = model.get("diagramTypeId")
    node_markup = "".join(
        with_diagram_link(n, _render_node(n, resolve_icon, diagram_type_id), diagram_link_base) for n in model["nodes"]
    )
    return (
        _svg_open(bounds["width"], bounds["height"])
        + _DEFS
        + container_markup
        + edge_markup
        + node_markup
        + (render_legend(legend, diagram_type_id) if legend else "")
        + "</svg>"
    )


def _template_field(icon: dict[str, Any], key: str) -> str:
    """`${icon.key}`: "undefined" when the field is absent."""
    return "undefined" if key not in icon else _t(icon[key])


def icon_resolver(icons: dict[str, str] | None) -> IconResolver:
    """The bridge's lookup: artwork by "<libraryId>@<libraryVersion>@<iconId>"."""
    artwork = icons or {}

    def resolve(icon: dict[str, Any]) -> str | None:
        key = "@".join(_template_field(icon, k) for k in ("libraryId", "libraryVersion", "iconId"))
        return artwork.get(key)

    return resolve


def render_to_svg(
    model: Model,
    icons: dict[str, str] | None = None,
    *,
    standard_rules: Any = None,
    background: Any = None,
    diagram_link_base: str | None = None,
    frame_contents: dict[str, Any] | None = None,
) -> str:
    """renderToSvg(model, resolveIcon, { standardRules, background, diagramLinkBase, frameContents }) as the bridge's
    render-svg op calls it. `frame_contents` (canvas-8uh1.6): what each frame shows, by the framed diagram's id."""
    drawn = with_frame_overlay(
        _render_diagram_svg(model, icon_resolver(icons), standard_rules, diagram_link_base),
        model,
        frame_contents,
        diagram_link_base,
    )
    return _with_background(drawn, background)
