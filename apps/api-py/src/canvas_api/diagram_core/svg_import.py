"""Port of diagram-core's libraries/svg-import.ts and svg-sanitizer.ts: turning SVG markup into icon artwork.

Icon artwork is an SVG fragment drawn in a 48x48 space and ends up inline in exported SVG files, so:
- `prepare_uploaded_svg` (an admin-uploaded .svg file) and `sanitize_icon_markup_strict` (a custom manifest's
  artwork) keep only drawing elements and safe attributes (an allowlist), and prefix every id;
- `sanitize_svg_fragment` (the bundled packs and the legacy POST /libraries) strips script, foreignObject, event
  handlers and javascript: links.

These are security filters, and they must match the TypeScript ones exactly (the shadow mode compares them), so
every regex spells out JavaScript's classes: `\\s`, `\\w`, `\\b` and `/i` differ in Python.
"""

from __future__ import annotations

import re

from canvas_api.diagram_core.jsvalues import js_number_value
from canvas_api.diagram_core.templates.jsregex import DOT, S
from canvas_api.github.jstext import JS_WHITESPACE, js_len, js_number, js_trim

__all__ = [
    "MAX_SVG_BYTES",
    "SvgImportError",
    "prepare_uploaded_svg",
    "sanitize_icon_markup_strict",
    "sanitize_svg_fragment",
]


class SvgImportError(Exception):
    """The file can't be used as an icon; the message is shown to the admin."""


MAX_SVG_BYTES = 200 * 1024
"""Per file (in UTF-16 code units, as JavaScript's length). A 200 KB icon is almost certainly a photo trace."""

_ALLOWED = frozenset(
    {
        "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "lineargradient",
        "radialgradient", "stop", "clippath", "mask", "pattern", "symbol", "use", "title", "desc", "text", "tspan",
    }
)  # fmt: skip

_I = re.IGNORECASE | re.ASCII  # JavaScript's /i folds ASCII letters only; ASCII also makes \b and \w ASCII.
_NOT_WS = f"[^{JS_WHITESPACE}"
_TAG = re.compile(
    f"<(/?)([A-Za-z][A-Za-z0-9_:.-]*)((?:{S}+{_NOT_WS}=>/]+(?:{S}*={S}*(?:\"[^\"]*\"|'[^']*'|{_NOT_WS}>]+))?)*){S}*(/?)>"
)
_ATTR = re.compile(f"({_NOT_WS}=>/]+)(?:{S}*={S}*(?:\"([^\"]*)\"|'([^']*)'|({_NOT_WS}>]+)))?")
_URL_TARGET = re.compile(f"url\\({S}*(?:&quot;|[\"'])?([^)\"'&]*)(?:&quot;|[\"'])?{S}*\\)", _I)
_URL_REF = re.compile(f"url\\({S}*(&quot;|[\"'])?#([^)\"'&]+)(&quot;|[\"'])?{S}*\\)", _I)
_BAD_STYLE = re.compile(f"expression{S}*\\(|@import|javascript:|behavior{S}*:", _I)
_BAD_VALUE = re.compile("javascript:|data:", _I)
_URL = re.compile(r"url\(", _I)
_STYLE_BLOCK = re.compile(r"<style\b", _I)
_COMMENT = re.compile(r"<!--[\s\S]*?-->")
_CDATA = re.compile(r"<!\[CDATA\[[\s\S]*?\]\]>")
_ENTITY = re.compile("<!ENTITY", _I)
_XML_DECLARATION = re.compile(r"<\?xml[\s\S]*?\?>", _I)
_DOCTYPE = re.compile(f"<!DOCTYPE[^>\\[]*(\\[[\\s\\S]*?\\])?{S}*>", _I)
_ROOT = re.compile(r"<svg\b([^>]*?)(/?)>([\s\S]*)\Z", _I)
_CLOSING_SVG = re.compile(f"</svg{S}*>{S}*\\Z", _I)
_VIEWBOX_SEPARATOR = re.compile(f"(?:{S}|,)+")
_LENGTH = re.compile(r"([0-9]+(?:\.[0-9]+)?)(px)?")
_PREFIX_UNSAFE = re.compile(r"[^A-Za-z0-9_-]")

_SCRIPT = re.compile(r"<script\b[^>]*>[\s\S]*?</script>", _I)
_FOREIGN_OBJECT = re.compile(r"<foreignObject\b[^>]*>[\s\S]*?</foreignObject>", _I)
_HANDLER_DOUBLE = re.compile(f'{S}on\\w+{S}*={S}*"(?:[^"\\\\]|\\\\{DOT})*"', _I)
_HANDLER_SINGLE = re.compile(f"{S}on\\w+{S}*={S}*'(?:[^'\\\\]|\\\\{DOT})*'", _I)
_JS_LINK_DOUBLE = re.compile(f'(href|xlink:href|src){S}*={S}*"javascript:[^"]*"', _I)
_JS_LINK_SINGLE = re.compile(f"(href|xlink:href|src){S}*={S}*'javascript:[^']*'", _I)
_LEADING_WS = re.compile(f"^{S}+")


# This module IS the sanitizer (an allowlist with its own escaping, as svg-import.ts; parity-fuzzed against it).
def _escape_attr(value: str) -> str:
    # bearer:disable python_lang_manual_html_sanitization
    return value.replace('"', "&quot;").replace("<", "&lt;")


def _url_targets(value: str) -> list[str | None]:
    """`url(#x)`, `url("#x")`, `url(&quot;#x&quot;)` -> the referenced id, or None for an external URL."""
    return [m[1][1:] if m[1].startswith("#") else None for m in _URL_TARGET.finditer(value)]


def _prefix_refs(value: str, prefix: str) -> str:
    return _URL_REF.sub(lambda m: f"url({m[1] or ''}#{prefix}-{m[2]}{m[3] or ''})", value)


def _clean_style(style: str, prefix: str) -> str | None:
    if _BAD_STYLE.search(style):
        return None
    kept = [d for d in (js_trim(part) for part in style.split(";")) if d and None not in _url_targets(d)]
    return _prefix_refs(";".join(kept), prefix) if kept else None


def _clean_attributes(raw: str, prefix: str) -> str:
    out: list[str] = []
    for m in _ATTR.finditer(raw):
        name = m[1]
        lower = name.lower()
        value = next((v for v in (m[2], m[3], m[4]) if v is not None), "")
        if lower.startswith("on") or lower == "xml:base" or _BAD_VALUE.search(value):
            continue
        if lower in ("href", "xlink:href"):
            if not value.startswith("#"):
                continue
            out.append(f'{name}="{_escape_attr(f"#{prefix}-{value[1:]}")}"')
            continue
        if lower == "id":
            out.append(f'id="{_escape_attr(f"{prefix}-{value}")}"')
            continue
        if lower == "style":
            style = _clean_style(value, prefix)
            if style:
                out.append(f'style="{_escape_attr(style)}"')
            continue
        if _URL.search(value):
            if None in _url_targets(value):
                continue
            out.append(f'{name}="{_escape_attr(_prefix_refs(value, prefix))}"')
            continue
        out.append(name if m[2] is None and m[3] is None and m[4] is None else f'{name}="{_escape_attr(value)}"')
    return f" {' '.join(out)}" if out else ""


def _safe_prefix(id_prefix: str) -> str:
    """`idPrefix.replace(/[^A-Za-z0-9_-]/g, '-')`: per UTF-16 code unit, so a character outside the BMP (two
    units in JavaScript) becomes two dashes."""
    return _PREFIX_UNSAFE.sub(lambda m: "--" if ord(m[0]) > 0xFFFF else "-", id_prefix)


def sanitize_icon_markup_strict(markup: str, id_prefix: str) -> str:
    """Strict clean-up of icon markup: only drawing elements survive (anything else is removed with its content),
    event handlers / external references / javascript: and data: values are dropped, and every id (and reference
    to it) gets the prefix so icons in one diagram can't collide. A `<style>` block is refused."""
    if _STYLE_BLOCK.search(markup):
        raise SvgImportError(
            "The SVG uses a <style> block. Export it with presentation attributes (or inline styles) instead."
        )
    prefix = _safe_prefix(id_prefix)
    body = _CDATA.sub("", _COMMENT.sub("", markup))
    out: list[str] = []
    last = 0
    skipping: list[str] = []
    for m in _TAG.finditer(body):
        text = body[last : m.start()]
        last = m.end()
        if not skipping:
            # Text between tags; see _escape_attr.
            # bearer:disable python_lang_manual_html_sanitization
            out.append(text.replace("<", "&lt;"))
        closing, name, attrs, self_closing = m[1], m[2], m[3], m[4]
        lower = name.lower()
        if skipping:
            if lower == skipping[-1]:
                if closing:
                    skipping.pop()
                elif not self_closing:
                    skipping.append(lower)
            continue
        if lower not in _ALLOWED:
            if not closing and not self_closing:
                skipping.append(lower)
            continue
        out.append(
            f"</{name}>" if closing else f"<{name}{_clean_attributes(attrs, prefix)}{'/' if self_closing else ''}>"
        )
    if not skipping:
        # Trailing text; see _escape_attr.
        # bearer:disable python_lang_manual_html_sanitization
        out.append(body[last:].replace("<", "&lt;"))
    return "".join(out)


def _parse_length(value: str | None) -> float | None:
    if not value:
        return None
    m = _LENGTH.fullmatch(js_trim(value))
    return float(m[1]) if m else None


def prepare_uploaded_svg(svg_text: str, id_prefix: str) -> str:
    """An uploaded .svg file -> icon markup in the 48x48 icon space (its viewBox fitted, never stretched)."""
    if js_len(svg_text) > MAX_SVG_BYTES:
        raise SvgImportError(f"The file is too large (over {MAX_SVG_BYTES // 1024} KB).")
    if _ENTITY.search(svg_text):
        raise SvgImportError("The file declares XML entities, which are not allowed.")
    text = js_trim(_DOCTYPE.sub("", _COMMENT.sub("", _XML_DECLARATION.sub("", svg_text))))
    root = _ROOT.match(text)
    if not root:
        raise SvgImportError("This isn't an SVG file.")
    inner = "" if root[2] else _CLOSING_SVG.sub("", root[3], count=1)
    if not root[2] and inner == root[3]:
        raise SvgImportError("This isn't a complete SVG file (no closing </svg>).")

    attrs: dict[str, str] = {}
    for m in _ATTR.finditer(root[1]):
        attrs[m[1].lower()] = next((v for v in (m[2], m[3], m[4]) if v is not None), "")
    view_box: list[float] | None = None
    raw_view_box = attrs.get("viewbox")
    numbers = (
        [js_number_value(part) for part in _VIEWBOX_SEPARATOR.split(js_trim(raw_view_box))]
        if raw_view_box is not None
        else None
    )
    if numbers is not None and len(numbers) == 4 and all(abs(n) != float("inf") and n == n for n in numbers):
        view_box = numbers
    else:
        width = _parse_length(attrs.get("width"))
        height = _parse_length(attrs.get("height"))
        if width is not None and height is not None:
            view_box = [0.0, 0.0, width, height]
    if not view_box or view_box[2] <= 0 or view_box[3] <= 0:
        raise SvgImportError("The SVG has no usable size (it needs a viewBox, or a width and height in pixels).")
    cleaned = sanitize_icon_markup_strict(inner, id_prefix)
    numbers_text = " ".join(js_number(n) for n in view_box)
    return (
        f'<svg x="0" y="0" width="48" height="48" viewBox="{numbers_text}" preserveAspectRatio="xMidYMid meet"'
        f' overflow="hidden">{cleaned}</svg>'
    )


def sanitize_svg_fragment(asset_ref: str) -> str:
    """Strips script, foreignObject, event handlers and javascript: links from artwork that looks like markup
    (starts with `<`); a plain path or URL reference passes through untouched."""
    if not _LEADING_WS.sub("", asset_ref, count=1).startswith("<"):
        return asset_ref
    value = _SCRIPT.sub("", asset_ref)
    value = _FOREIGN_OBJECT.sub("", value)
    value = _HANDLER_DOUBLE.sub("", value)
    value = _HANDLER_SINGLE.sub("", value)
    value = _JS_LINK_DOUBLE.sub(r'\1="#"', value)
    return _JS_LINK_SINGLE.sub(r"\1='#'", value)
