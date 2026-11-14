"""canvas-8uh1.6: frames drawn over a diagram (packages/diagram-core/src/render/frames-render.ts), byte for byte.
The diagram's own drawing is grown to fit its frames, and each frame is drawn on top: a header with the inner
diagram's title, and the inner diagram's drawing (handed in already made, with no frames of its own, so frames go
one level deep) scaled to fit, or a placeholder."""

from __future__ import annotations

import math
import re
from typing import Any
from urllib.parse import quote

from canvas_api.diagram_core.jsvalues import js_template
from canvas_api.diagram_core.model import is_allowed_link_href
from canvas_api.github.jstext import js_len, js_slice

__all__ = ["FRAME_HEADER_HEIGHT", "frame_body", "frame_status_text", "frame_title", "with_frame_overlay"]

FRAME_HEADER_HEIGHT = 24
_FRAME_MARGIN = 20
_TITLE_CHAR_WIDTH = 7
_URI_COMPONENT_SAFE = "!'()*-._~"
_ROOT = re.compile(
    r'<svg xmlns="http://www\.w3\.org/2000/svg" width="([^"]*)" height="([^"]*)" viewBox="0 0 ([^" ]*) ([^"]*)">'
)


def _t(value: Any) -> str:
    return js_template(value)


def _escape(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def frame_status_text(content: dict[str, Any] | None) -> str:
    status = content.get("status") if content else None
    if status == "unavailable":
        return "Not available"
    if status == "deleted":
        return "Deleted (in the bin)"
    if status == "missing":
        return "Diagram no longer exists"
    if status == "available":
        return "Embedded diagram" if content is not None and content.get("svg") is None else ""
    return "Embedded diagram"


def frame_title(content: dict[str, Any] | None, width: float) -> str:
    name = content.get("name") if content else None
    title = name if name is not None else "Embedded diagram"
    room = max(1, math.floor((width - 16) / _TITLE_CHAR_WIDTH))
    return f"{js_slice(title, 0, max(0, room - 1))}…" if js_len(title) > room else title


def frame_body(svg: str, x: float, y: float, width: float, height: float) -> str | None:
    root = _ROOT.match(svg)
    if root is None or not svg.endswith("</svg>"):
        return None
    inner = svg[len(root.group(0)) : len(svg) - len("</svg>")]
    return (
        f'<svg x="{_t(x)}" y="{_t(y)}" width="{_t(width)}" height="{_t(height)}" viewBox="0 0 {root.group(3)} '
        f'{root.group(4)}" preserveAspectRatio="xMidYMid meet" overflow="hidden">{inner}</svg>'
    )


def _render_frame(frame: dict[str, Any], content: dict[str, Any] | None, link_base: str | None) -> str:
    x, y = frame["position"]["x"], frame["position"]["y"]
    width, height = frame["size"]["width"], frame["size"]["height"]
    body_height = max(0, height - FRAME_HEADER_HEIGHT)
    parts = [
        f'<g class="diagram-frame" data-frame-id="{_escape(frame["id"])}">',
        f'<rect x="{_t(x)}" y="{_t(y)}" width="{_t(width)}" height="{_t(height)}" fill="#ffffff" stroke="#64748b"'
        ' stroke-width="1.5" rx="6" ry="6" />',
        f'<rect x="{_t(x)}" y="{_t(y)}" width="{_t(width)}" height="{_t(min(height, FRAME_HEADER_HEIGHT))}"'
        ' fill="#e2e8f0" stroke="#64748b" stroke-width="1.5" rx="6" ry="6" />',
        f'<text x="{_t(x + 8)}" y="{_t(y + 16)}" font-family="sans-serif" font-size="12" font-weight="bold"'
        f' fill="#1e293b">{_escape(frame_title(content, width))}</text>',
    ]
    body = None
    if content is not None and content.get("status") == "available" and content.get("svg") is not None:
        body = frame_body(content["svg"], x, y + FRAME_HEADER_HEIGHT, width, body_height)
    if body is not None:
        parts.append(body)
    else:
        text = frame_status_text(content) or "Embedded diagram"
        parts.append(
            f'<text x="{_t(x + width / 2)}" y="{_t(y + FRAME_HEADER_HEIGHT + body_height / 2)}"'
            ' font-family="sans-serif" font-size="12" fill="#64748b" text-anchor="middle" dominant-baseline="central">'
            f"{_escape(text)}</text>"
        )
    parts.append("</g>")
    markup = "".join(parts)
    href = f"{link_base}{quote(frame['diagramId'], safe=_URI_COMPONENT_SAFE)}" if link_base else None
    return f'<a href="{_escape(href)}">{markup}</a>' if href and is_allowed_link_href(href) else markup


def with_frame_overlay(
    svg: str, model: dict[str, Any], contents: dict[str, Any] | None = None, link_base: str | None = None
) -> str:
    frames = model.get("frames") or []
    if not frames:
        return svg
    root = _ROOT.match(svg)
    if root is None or not svg.endswith("</svg>"):
        return svg
    width: Any = _js_number(root.group(1))
    height: Any = _js_number(root.group(2))
    for frame in frames:
        width = max(width, frame["position"]["x"] + frame["size"]["width"] + _FRAME_MARGIN)
        height = max(height, frame["position"]["y"] + frame["size"]["height"] + _FRAME_MARGIN)
    contents = contents or {}
    overlay = "".join(_render_frame(f, contents.get(f["diagramId"]), link_base) for f in frames)
    body = svg[len(root.group(0)) : len(svg) - len("</svg>")]
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{_t(width)}" height="{_t(height)}" viewBox="0 0 {_t(width)}'
        f' {_t(height)}">{body}{overlay}</svg>'
    )


def _js_number(text: str) -> float:
    """`Number(text)` for the numbers renderToSvg writes."""
    value = float(text)
    return int(value) if value.is_integer() else value
