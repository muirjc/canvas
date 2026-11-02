"""Node sizes and label wrapping (packages/diagram-core/src/render/svg-renderer.ts: nodeSize, splitLabelLines
and their helpers). Shared by the auto-layout here and, later, the SVG renderer; the numbers must match the
TypeScript ones exactly (both are IEEE doubles, so the same operations give the same results), and text length
is JavaScript's (UTF-16 code units)."""

from __future__ import annotations

import math
import re
from typing import Any

from canvas_api.github.jstext import JS_WHITESPACE, js_len

__all__ = ["DEFAULT_NODE_SIZE", "node_size", "split_label_lines"]

Node = dict[str, Any]

DEFAULT_NODE_SIZE = {"width": 140, "height": 60}
_LINE_BREAK = re.compile(f"<br[{JS_WHITESPACE}]*/?>|\\r?\\n", re.IGNORECASE | re.ASCII)
AVG_CHAR_WIDTH_RATIO = 0.56

ICON_GLYPH_SIZE = 48
ICON_PADDING = 10
ICON_LABEL_GAP = 4
ICON_LABEL_MAX_WIDTH = ICON_GLYPH_SIZE + 40

DESCRIBED_NODE_WIDTH = 200
DESCRIPTION_FONT_SIZE = 11
DESCRIBED_PADDING = 10
DESCRIBED_BLOCK_GAP = 4
DESCRIBED_LINE_HEIGHT = 1.25

TABLE_HEADER_PADDING_Y = 6
TABLE_ROW_PADDING_Y = 3
TABLE_ROW_PADDING_X = 8


def _wrap_line(line: str, max_width: float, font_size: float) -> list[str]:
    max_chars = max(1, math.floor(max_width / (font_size * AVG_CHAR_WIDTH_RATIO)))
    if js_len(line) <= max_chars:
        return [line]
    wrapped: list[str] = []
    current = ""
    for word in line.split(" "):
        candidate = f"{current} {word}" if current else word
        if js_len(candidate) > max_chars and current:
            wrapped.append(current)
            current = word
        else:
            current = candidate
    if current:
        wrapped.append(current)
    return wrapped if wrapped else [line]


def split_label_lines(label: str, max_width: float | None = None, font_size: float | None = None) -> list[str]:
    """Explicit breaks (`<br/>`, newlines), then word wrap to `max_width` when given."""
    explicit = _LINE_BREAK.split(label)
    if max_width is None or font_size is None:
        return explicit
    return [part for line in explicit for part in _wrap_line(line, max_width, font_size)]


def _font_size(node: Node) -> float:
    style = node.get("style") or {}
    size = style.get("fontSize")
    return 14 if size is None else size


def _icon_caption_font_size(node: Node) -> float:
    return max(_font_size(node) - 2, 10)


def icon_node_size(node: Node) -> dict[str, float]:
    font_size = _icon_caption_font_size(node)
    lines = split_label_lines(node["label"], ICON_LABEL_MAX_WIDTH, font_size)
    line_height = font_size * 1.2
    return {
        "width": ICON_LABEL_MAX_WIDTH + ICON_PADDING * 2,
        "height": ICON_PADDING * 2 + ICON_GLYPH_SIZE + ICON_LABEL_GAP + len(lines) * line_height,
    }


def _format_attribute_row(attribute: dict[str, Any]) -> str:
    keys = attribute.get("keys") or []
    keys_part = f" {', '.join(keys)}" if keys else ""
    comment = attribute.get("comment")
    comment_part = f' "{comment}"' if comment else ""
    return f"{attribute['type']} {attribute['name']}{keys_part}{comment_part}"


def _format_member_row(member: dict[str, Any]) -> str:
    visibility = member.get("visibility") or ""
    modifier = "$" if member.get("isStatic") else "*" if member.get("isAbstract") else ""
    if member.get("kind") == "method":
        return_type = member.get("returnType")
        return_part = f" {return_type}" if return_type else ""
        return f"{visibility}{member['name']}({member.get('params') or ''}){return_part}{modifier}"
    member_type = member.get("type")
    type_part = f"{member_type} " if member_type else ""
    return f"{visibility}{type_part}{member['name']}{modifier}"


def table_rows(node: Node) -> list[str]:
    attributes = node.get("attributes") or []
    if attributes:
        return [_format_attribute_row(a) for a in attributes]
    members = node.get("members") or []
    if members:
        return [_format_member_row(m) for m in members]
    return []


def _stereotype(node: Node) -> str | None:
    stereotype = node.get("umlStereotype")
    return f"<<{stereotype}>>" if stereotype else None


def _table_node_size(node: Node, rows: list[str]) -> dict[str, float]:
    font_size = _font_size(node)
    row_font_size = max(font_size - 2, 10)
    stereotype = _stereotype(node)
    stereotype_height = row_font_size * 1.2 + TABLE_HEADER_PADDING_Y if stereotype else 0
    header_height = stereotype_height + font_size * 1.2 + TABLE_HEADER_PADDING_Y * 2
    row_height = row_font_size * 1.2 + TABLE_ROW_PADDING_Y * 2
    widest = max(
        js_len(node["label"]) * font_size * AVG_CHAR_WIDTH_RATIO,
        js_len(stereotype or "") * row_font_size * AVG_CHAR_WIDTH_RATIO,
        *(js_len(row) * row_font_size * AVG_CHAR_WIDTH_RATIO for row in rows),
    )
    return {
        "width": max(DEFAULT_NODE_SIZE["width"], widest + TABLE_ROW_PADDING_X * 2),
        "height": header_height + len(rows) * row_height,
    }


def _is_described(node: Node) -> bool:
    has_text = bool(node.get("technology") or node.get("description") or node.get("c4TypeLabel"))
    return has_text and node.get("shape") != "icon" and not table_rows(node)


def _described_width(node: Node) -> float:
    return DESCRIBED_NODE_WIDTH if node.get("technology") or node.get("description") else DEFAULT_NODE_SIZE["width"]


def _type_line(node: Node) -> str | None:
    technology = node.get("technology")
    if node.get("c4TypeLabel"):
        return f"[{node['c4TypeLabel']}{f': {technology}' if technology else ''}]"
    return f"[{technology}]" if technology else None


def _described_lines(node: Node, width: float) -> list[tuple[float, float]]:
    """(fontSize, gapBefore) per drawn line: all the height calculation needs."""
    max_width = max(width - 16, 40)
    blocks: list[tuple[str, float]] = [(node["label"], _font_size(node))]
    type_line = _type_line(node)
    if type_line:
        blocks.append((type_line, DESCRIPTION_FONT_SIZE))
    if node.get("description"):
        blocks.append((node["description"], DESCRIPTION_FONT_SIZE))
    out: list[tuple[float, float]] = []
    for b, (text, font_size) in enumerate(blocks):
        for i, _ in enumerate(split_label_lines(text, max_width, font_size)):
            out.append((font_size, DESCRIBED_BLOCK_GAP if b > 0 and i == 0 else 0))
    return out


def _described_content_height(lines: list[tuple[float, float]]) -> float:
    total: float = 0
    for font_size, gap in lines:
        total = total + gap + font_size * DESCRIBED_LINE_HEIGHT
    return total


def plain_node_size(node: Node) -> dict[str, float]:
    if _is_described(node):
        width = _described_width(node)
        lines = _described_lines(node, width)
        text_height = max(
            DEFAULT_NODE_SIZE["height"], math.ceil(_described_content_height(lines) + DESCRIBED_PADDING * 2)
        )
        if node.get("shape") != "person":
            return {"width": width, "height": text_height}
        return {"width": width, "height": text_height + 2 * 20 + 7}
    width = DEFAULT_NODE_SIZE["width"]
    font_size = _font_size(node)
    label_max_width = max(width - 16, 40)
    label_lines = split_label_lines(node["label"], label_max_width, font_size)
    line_height = font_size * 1.2
    content_height = len(label_lines) * line_height + 16
    if node.get("shape") == "person":
        return {"width": width, "height": max(DEFAULT_NODE_SIZE["height"], content_height) + 2 * 20 + 7}
    return {"width": width, "height": max(DEFAULT_NODE_SIZE["height"], content_height)}


def node_size(node: Node) -> dict[str, float]:
    size = node.get("size")
    if node.get("shape") == "icon" and not size:
        return icon_node_size(node)
    if not size:
        rows = table_rows(node)
        if rows:
            return _table_node_size(node, rows)
        return plain_node_size(node)
    return dict(size)
