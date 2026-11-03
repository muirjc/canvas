"""Port of diagram-core's libraries/svg-import.ts and svg-sanitizer.ts: turning SVG markup into icon artwork.

Icon artwork is an SVG fragment drawn in a 48x48 space and ends up inline in exported SVG files, so:
- `prepare_uploaded_svg` (an admin-uploaded .svg file) and `sanitize_icon_markup_strict` (a custom manifest's
  artwork, and markup sent to the legacy POST /libraries) keep only drawing elements and safe attributes (an
  allowlist), prefix every id, and write balanced, well-formed XML;
- `sanitize_svg_fragment` (the bundled packs, as loaded by loadLibrary) strips script, foreignObject, event
  handlers and javascript: links.

These are security filters, and they must match the TypeScript ones exactly (the shadow mode compares them), so
every regex spells out JavaScript's classes: `\\s`, `\\w`, `\\b` and `/i` differ in Python. canvas-1bty.19
hardened both copies together (see svg-import.ts): keep them in step.
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
"""Per file or manifest icon (in UTF-16 code units, as JavaScript's length). A 200 KB icon is almost certainly a
photo trace."""

MAX_ICON_DEPTH = 100
"""Deeper nesting than this is refused: XML parsers (resvg, browsers) give up on very deep documents."""
MAX_ICON_USES = 16
"""More `<use>` elements than this are refused: chained ones multiply (a "billion laughs" made of elements)."""
# Characters XML 1.0 doesn't allow (control characters, U+FFFE/U+FFFF, unpaired surrogates): removed. A Python str
# holds an astral character as one code point, where JavaScript has a surrogate pair: both are kept.
_NOT_XML_CHAR = re.compile("[^\t\n\r\x20-\ud7ff\ue000-\ufffd\U00010000-\U0010ffff]")

_ALLOWED = frozenset(
    {
        "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "lineargradient",
        "radialgradient", "stop", "clippath", "mask", "pattern", "symbol", "use", "title", "desc", "text", "tspan",
    }
)  # fmt: skip

_STYLE_PROPERTIES = frozenset(
    {
        "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap",
        "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity", "stop-color",
        "stop-opacity", "clip-path", "clip-rule", "mask", "color", "display", "visibility", "isolation",
        "mix-blend-mode", "font-family", "font-size", "font-weight", "font-style", "text-anchor", "dominant-baseline",
        "letter-spacing", "word-spacing", "text-decoration", "paint-order", "vector-effect", "shape-rendering",
        "transform", "transform-origin", "transform-box",
    }
)  # fmt: skip
"""CSS properties a `style` attribute may set: presentation only."""

_FUNCTIONS = frozenset(
    {
        "url", "translate", "translatex", "translatey", "scale", "scalex", "scaley", "rotate", "matrix", "skewx",
        "skewy", "rgb", "rgba", "hsl", "hsla",
    }
)  # fmt: skip
"""CSS/SVG functions a value may call. url() only as a reference inside the icon (`url(#id)`)."""

_I = re.IGNORECASE | re.ASCII  # JavaScript's /i folds ASCII letters only; ASCII also makes \b and \w ASCII.
_NOT_WS = f"[^{JS_WHITESPACE}"
# '<' never appears inside a tag, and an unquoted value can't start with a quote: matching stays linear.
_NAME = f"{_NOT_WS}=>/<\"']+"
_UNQUOTED = f"{_NOT_WS}><\"']{_NOT_WS}><]*"
_TAG = re.compile(
    f"<(/?)([A-Za-z][A-Za-z0-9_:.-]*)((?:{S}+{_NAME}(?:{S}*={S}*(?:\"[^\"<]*\"|'[^'<]*'|{_UNQUOTED}))?)*){S}*(/?)>"
)
_ATTR = re.compile(f"({_NAME})(?:{S}*={S}*(?:\"([^\"<]*)\"|'([^'<]*)'|({_UNQUOTED})))?")
_ATTR_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_.-]*")
_PREFIXED = {"xlink:href": "href", "xml:space": "xml:space"}
"""xlink:href becomes href (SVG 2): exports don't declare the xlink namespace."""
_CANONICAL = frozenset({"id", "style", "href"})
"""Written in lower case, whatever case they came in: the sanitizer treats them specially."""
_NAMED_REFERENCE = re.compile(r"&(quot|amp|lt|gt|apos);")
_BARE_AMPERSAND = re.compile(r"&(?!(?:quot|amp|lt|gt|apos);)")
_REFERENCES = {"quot": '"', "amp": "&", "lt": "<", "gt": ">", "apos": "'"}
_CLEAN_URL = re.compile(f"url\\({S}*([\"']?)#([A-Za-z0-9_.:-]+)\\1{S}*\\)", _I)
_ANY_URL = re.compile(f"url{S}*\\(", _I)
_BAD_SCHEME = re.compile("javascript:|vbscript:|data:", _I)
_SAFE_HREF = re.compile(r"#[A-Za-z0-9_.:-]+")
_JS_SPACE = re.compile(f"{S}")
_FUNCTION_NAME_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-")
_STYLE_BLOCK = re.compile(r"<style\b", _I)
_ENTITY = re.compile("<!ENTITY", _I)
_COMMENT_START = re.compile("<!--")
_CDATA_START = re.compile(r"<!\[CDATA\[")
_XML_START = re.compile(r"<\?xml", _I)
_DOCTYPE_START = re.compile("<!DOCTYPE", _I)
_DOCTYPE_STOP = re.compile(r"[>\[]")
_SUBSET_END = re.compile(f"\\]{S}*>")
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
    return value.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")


def _escape_text(text: str) -> str:
    # bearer:disable python_lang_manual_html_sanitization
    return _BARE_AMPERSAND.sub("&amp;", text).replace("<", "&lt;").replace(">", "&gt;")


def _safe_functions(value: str) -> bool:
    """Every function the value calls is allowed, and every url() is a reference inside the icon. Function names
    are read backwards from each '(' (a forward regex would rescan long runs of letters: quadratic)."""
    i = value.find("(")
    while i != -1:
        end = i
        while end > 0 and _JS_SPACE.fullmatch(value[end - 1]):
            end -= 1
        start = end
        while start > 0 and value[start - 1] in _FUNCTION_NAME_CHARS:
            start -= 1
        if value[start:end].lower() not in _FUNCTIONS:
            return False
        i = value.find("(", i + 1)
    return len(_ANY_URL.findall(value)) == len(_CLEAN_URL.findall(value))


def _safe_value(value: str) -> bool:
    """No CSS escapes or script/data URLs, only safe functions."""
    return "\\" not in value and not _BAD_SCHEME.search(value) and _safe_functions(value)


def _prefix_refs(value: str, prefix: str) -> str:
    return _CLEAN_URL.sub(lambda m: f"url({m[1]}#{prefix}-{m[2]}{m[1]})", value)


def _clean_style(style: str, prefix: str) -> str | None:
    kept: list[str] = []
    for part in style.split(";"):
        declaration = js_trim(part)
        if not declaration:
            continue
        colon = declaration.find(":")
        if colon == -1:
            continue
        prop = js_trim(declaration[:colon]).lower()
        value = js_trim(declaration[colon + 1 :])
        if prop not in _STYLE_PROPERTIES or "@" in value or not _safe_value(value):
            continue
        kept.append(f"{prop}:{_prefix_refs(value, prefix)}")
    return ";".join(kept) if kept else None


def _attribute_name(raw: str, lower: str) -> str | None:
    if lower in _PREFIXED:
        return _PREFIXED[lower]
    if lower in _CANONICAL:
        return lower
    return raw if _ATTR_NAME.fullmatch(raw) else None


def _clean_attributes(raw: str, prefix: str) -> str:
    out: list[str] = []
    seen: set[str] = set()
    for m in _ATTR.finditer(raw):
        lower = m[1].lower()
        name = _attribute_name(m[1], lower)
        if name is None or lower.startswith(("on", "xmlns")) or name in seen:
            continue
        given = next((v for v in (m[2], m[3], m[4]) if v is not None), None)
        if given is None:
            # A bare name isn't XML; `<rect hidden>` keeps it as hidden="".
            seen.add(name)
            out.append(f'{name}=""')
            continue
        # Only the five XML references are understood; a numeric or bare '&' could spell anything.
        if "&" in _NAMED_REFERENCE.sub("", given):
            continue
        value = _NAMED_REFERENCE.sub(lambda r: _REFERENCES[r[1]], given)
        # A style's declarations are checked one by one, so one bad one doesn't drop the rest.
        if name != "style" and not _safe_value(value):
            continue
        kept: str | None
        if name == "href":
            kept = f"#{prefix}-{value[1:]}" if _SAFE_HREF.fullmatch(value) else None
        elif name == "id":
            kept = f"{prefix}-{value}"
        elif name == "style":
            kept = _clean_style(value, prefix)
        else:
            kept = _prefix_refs(value, prefix)
        if kept is None:
            continue
        seen.add(name)
        out.append(f'{name}="{_escape_attr(kept)}"')
    return f" {' '.join(out)}" if out else ""


def _remove_spans(text: str, start: re.Pattern[str], close: str) -> str:
    """Removes every start...close span, nearest close first, as a global lazy regex would, in linear time: a
    start with no close after it means no later start has one either."""
    out: list[str] = []
    last = 0
    m = start.search(text)
    while m:
        end = text.find(close, m.end())
        if end == -1:
            break
        out.append(text[last : m.start()])
        last = end + len(close)
        m = start.search(text, last)
    out.append(text[last:])
    return "".join(out)


def _remove_doctypes(text: str) -> str:
    """`<!DOCTYPE ...>`, with or without an internal subset (`[...]`, ending at the first `]` followed by `>`)."""
    out: list[str] = []
    last = 0
    no_subset_end_from = len(text) + 1  # searching for "]>" from here (or later) finds nothing
    stop = -1  # the first '>' or '[' at or after the last search's start
    m = _DOCTYPE_START.search(text)
    while m:
        begin = m.end()
        if stop < begin:
            found = _DOCTYPE_STOP.search(text, begin)
            if not found:
                break
            stop = found.start()
        if text[stop] == ">":
            end = stop + 1
        else:
            subset_end = _SUBSET_END.search(text, stop) if stop < no_subset_end_from else None
            if not subset_end:
                no_subset_end_from = min(no_subset_end_from, stop)
                m = _DOCTYPE_START.search(text, m.end())
                continue
            end = subset_end.end()
        out.append(text[last : m.start()])
        last = end
        m = _DOCTYPE_START.search(text, end)
    out.append(text[last:])
    return "".join(out)


def _safe_prefix(id_prefix: str) -> str:
    """`idPrefix.replace(/[^A-Za-z0-9_-]/g, '-')`: per UTF-16 code unit, so a character outside the BMP (two
    units in JavaScript) becomes two dashes."""
    return _PREFIX_UNSAFE.sub(lambda m: "--" if ord(m[0]) > 0xFFFF else "-", id_prefix)


def sanitize_icon_markup_strict(markup: str, id_prefix: str) -> str:
    """Strict clean-up of icon markup: only drawing elements survive (anything else is removed with its content),
    event handlers / external references / javascript: and data: values are dropped, every id (and reference
    to it) gets the prefix so icons in one diagram can't collide, and the result is balanced, well-formed XML.
    A `<style>` block is refused."""
    if js_len(markup) > MAX_SVG_BYTES:
        raise SvgImportError(f"The artwork is too large (over {MAX_SVG_BYTES // 1024} KB).")
    if _STYLE_BLOCK.search(markup):
        raise SvgImportError(
            "The SVG uses a <style> block. Export it with presentation attributes (or inline styles) instead."
        )
    prefix = _safe_prefix(id_prefix)
    body = _remove_spans(_remove_spans(_NOT_XML_CHAR.sub("", markup), _COMMENT_START, "-->"), _CDATA_START, "]]>")
    uses = 0
    out: list[str] = []
    last = 0
    skipping: list[str] = []
    # Elements written and not yet closed: a closer must match one, and whatever is left is closed at the end.
    open_elements: list[str] = []
    open_count: dict[str, int] = {}
    for m in _TAG.finditer(body):
        text = body[last : m.start()]
        last = m.end()
        if not skipping:
            out.append(_escape_text(text))
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
        if closing:
            if not open_count.get(lower):
                continue  # closes something outside the icon
            # Close everything opened inside it too (each element is popped once: linear overall).
            while True:
                top = open_elements.pop()
                top_lower = top.lower()
                open_count[top_lower] -= 1
                out.append(f"</{top}>")
                if top_lower == lower:
                    break
            continue
        if lower == "use":
            uses += 1
            if uses > MAX_ICON_USES:
                raise SvgImportError(f"The SVG has more than {MAX_ICON_USES} <use> elements.")
        if not self_closing and len(open_elements) >= MAX_ICON_DEPTH:
            raise SvgImportError(f"The SVG nests elements more than {MAX_ICON_DEPTH} deep.")
        out.append(f"<{name}{_clean_attributes(attrs, prefix)}{'/' if self_closing else ''}>")
        if not self_closing:
            open_elements.append(name)
            open_count[lower] = open_count.get(lower, 0) + 1
    if not skipping:
        out.append(_escape_text(body[last:]))
    out.extend(f"</{name}>" for name in reversed(open_elements))
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
    text = js_trim(_remove_doctypes(_remove_spans(_remove_spans(svg_text, _XML_START, "?>"), _COMMENT_START, "-->")))
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
