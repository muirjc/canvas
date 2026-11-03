"""Diagram embeds in Markdown documents (packages/diagram-core/src/embeds/markdown-embeds.ts, canvas-finl).

A document embeds a Canvas diagram with a marker, `<!-- MERMAID: path/from/repo/root.mmd -->`. Under it Canvas
writes a generated section (a ```mermaid block for `.mmd`, an image link for `.svg`) and an end marker
`<!-- /MERMAID -->`, and later replaces only what's between the two. Markers inside code blocks are ignored, so
documentation can show the syntax. Pure text in, text out; results use TypeScript's camelCase keys."""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from typing import Any
from urllib.parse import quote

from canvas_api.diagram_core.templates.jsregex import NS, S
from canvas_api.github.jstext import js_trim

__all__ = ["EMBED_END_MARKER", "find_embed_markers", "normalise_embed_path", "render_embed", "update_embeds"]

EMBED_END_MARKER = "<!-- /MERMAID -->"

# JS `/i` folds ASCII only, hence re.ASCII; `\s`/`\S` are spelled out, so re.ASCII doesn't change them.
_START = re.compile(f"<!--{S}*MERMAID:{S}*({NS}+?){S}*-->", re.IGNORECASE | re.ASCII)
_END = re.compile(f"<!--{S}*/MERMAID{S}*-->", re.IGNORECASE | re.ASCII)
_FENCE = re.compile("(`{3,}|~{3,})")
_LINE_BREAK = re.compile("\r?\n")
_BACKTICKS = re.compile("`+")
# JavaScript's `\s` as characters, for str.rstrip (`.replace(/\s+$/, "")`).
_JS_SPACE_CHARS = (
    "\t\n\v\f\r \u00a0\u1680" + "".join(map(chr, range(0x2000, 0x200B))) + "\u2028\u2029\u202f\u205f\u3000\ufeff"
)

Obj = dict[str, Any]


def normalise_embed_path(target: str) -> Obj | None:
    """A marker path from the repository root: {path, kind}, or None when it has `..`, `.` or empty segments, a
    backslash, or isn't `.mmd`/`.svg` (a `.canvas.mmd` source isn't embeddable)."""
    path = target[2:] if target.startswith("./") else target
    path = path.lstrip("/")
    if any(s in ("", ".", "..") for s in path.split("/")) or "\\" in path:
        return None
    if path.endswith(".canvas.mmd"):
        return None
    if path.endswith(".mmd"):
        return {"path": path, "kind": "mermaid"}
    if path.endswith(".svg"):
        return {"path": path, "kind": "svg"}
    return None


def find_embed_markers(markdown: str) -> list[Obj]:
    """Every marker outside code blocks: {target, path, kind, index, endIndex} (0-based line indexes; endIndex
    None when it has no section yet). A second marker before the first one's end starts its own section."""
    markers: list[Obj] = []
    fence: str | None = None
    open_marker: Obj | None = None
    for i, line in enumerate(_LINE_BREAK.split(markdown)):
        trimmed = js_trim(line)
        fence_match = _FENCE.match(trimmed)
        if fence is not None:
            if (
                fence_match
                and trimmed.startswith(fence)
                and js_trim(trimmed[len(fence_match[1]) :]) == ""
                and len(fence_match[1]) >= len(fence)
            ):
                fence = None
            continue
        if fence_match:
            fence = fence_match[1]
            continue
        start = _START.fullmatch(trimmed)
        if start:
            normalised = normalise_embed_path(start[1])
            open_marker = {
                "target": start[1],
                "path": normalised["path"] if normalised else None,
                "kind": normalised["kind"] if normalised else None,
                "index": i,
                "endIndex": None,
            }
            markers.append(open_marker)
            continue
        if _END.fullmatch(trimmed) and open_marker is not None and open_marker["endIndex"] is None:
            open_marker["endIndex"] = i
            open_marker = None
    return markers


def _encode_uri_component(segment: str) -> str:
    """encodeURIComponent (a lone surrogate raises, as JavaScript's URIError)."""
    return quote(segment, safe="!'()*")


def render_embed(source: Obj, target_path: str, doc_path: str) -> list[str]:
    """The generated section for a marker in `doc_path`, end marker included: an image link relative to the
    document for an SVG, else a mermaid block fenced longer than any backtick run in the text."""
    if source.get("kind") == "svg":
        name = target_path[target_path.rfind("/") + 1 :]
        if name.endswith(".svg"):
            name = name[:-4]
        alt = re.sub(r"[\[\]\\]", "", name)
        href = "/".join(_encode_uri_component(s) for s in _relative_path(doc_path, target_path).split("/"))
        return [f"![{alt}]({href})", EMBED_END_MARKER]
    text = source["text"].replace("\r\n", "\n").rstrip(_JS_SPACE_CHARS)
    longest = max([0, *(len(m[0]) for m in _BACKTICKS.finditer(text))])
    fence = "`" * max(3, longest + 1)
    return [f"{fence}mermaid", *text.split("\n"), fence, EMBED_END_MARKER]


def update_embeds(markdown: str, doc_path: str, sources: dict[str, Any], only: Iterable[str] | None = None) -> Obj:
    """Rewrites each marker's section in `markdown` (a document at `doc_path`). `sources` maps a normalised path
    to its source ({kind: "mermaid", text} or {kind: "svg"}); an absent path is missing. With `only`, markers
    pointing elsewhere are left alone and not reported. Returns {markdown, changed, results}, as the bridge's
    `embeds` op does."""
    return _update_embeds(markdown, doc_path, sources.get, None if only is None else set(only))


def _update_embeds(markdown: str, doc_path: str, resolve: Callable[[str], Any], only: set[str] | None) -> Obj:
    eol = "\r\n" if "\r\n" in markdown else "\n"
    lines = _LINE_BREAK.split(markdown)
    results: list[Obj] = []
    replacements: list[tuple[int, int, list[str]]] = []
    for marker in find_embed_markers(markdown):
        path, kind, index, end_index = marker["path"], marker["kind"], marker["index"], marker["endIndex"]
        if only is not None and (not path or path not in only):
            continue

        def result(status: str, marker: Obj = marker) -> None:
            results.append(
                {"target": marker["target"], "path": marker["path"], "line": marker["index"] + 1, "status": status}
            )

        if not path or not kind:
            result("unsupported")
            continue
        source = resolve(path)
        if not isinstance(source, dict) or source.get("kind") != kind:
            result("missing")
            continue
        section = render_embed(source, path, doc_path)
        if end_index is None:
            replacements.append((index + 1, index, section))
            result("filled")
            continue
        if lines[index + 1 : end_index + 1] == section:
            result("current")
            continue
        replacements.append((index + 1, end_index, section))
        result("updated")
    if not replacements:
        return {"markdown": markdown, "changed": False, "results": results}
    # Back to front, so earlier indexes stay valid.
    for start, to, section in sorted(replacements, key=lambda r: -r[0]):
        lines[start : to + 1] = section
    return {"markdown": eol.join(lines), "changed": True, "results": results}


def _relative_path(from_path: str, to_path: str) -> str:
    """`to_path` relative to the folder holding `from_path`; both repository paths with forward slashes."""
    from_dir = from_path.split("/")[:-1]
    to_parts = to_path.split("/")
    common = 0
    while common < len(from_dir) and common < len(to_parts) - 1 and from_dir[common] == to_parts[common]:
        common += 1
    up = len(from_dir) - common
    rest = to_parts[common:]
    return "./" + "/".join(rest) if up == 0 else "/".join([*([".."] * up), *rest])
