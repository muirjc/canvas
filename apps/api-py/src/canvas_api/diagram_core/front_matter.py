"""The canvas front matter (packages/diagram-core/src/dsl/front-matter.ts): positions, sizes, styles and
other visual data Mermaid's grammar has no room for, in a YAML block other Mermaid tools ignore."""

from __future__ import annotations

import math
import re
from typing import Any

from canvas_api.diagram_core import jsyaml
from canvas_api.diagram_core.jsvalues import js_number_value
from canvas_api.github.jstext import js_slice, js_trim

__all__ = [
    "FRONT_MATTER_PATTERN",
    "join_front_matter",
    "read_legend",
    "split_front_matter",
    "strip_trailing_comment",
    "with_legend",
]

FRONT_MATTER_PATTERN = re.compile(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n?")
#: libraries/aws-icons.ts: the aws-icons version saved diagrams referred to before jmuir-dtu.29.
AWS_ICONS_VERSION = "2024.1"
LEGACY_AWS_PLACEHOLDER_VERSION = "2024.1-placeholder"


def split_front_matter(dsl: str) -> tuple[Any, str]:
    """(front matter, body). The front matter is whatever the YAML holds ({} when there is none); a block that
    isn't valid YAML raises jsyaml.YamlError, as the TypeScript parse throws."""
    match = FRONT_MATTER_PATTERN.match(dsl)
    if not match:
        return {}, dsl
    parsed = jsyaml.load(match.group(1))
    front_matter = parsed if parsed is not None else {}
    _upgrade_legacy_icon_refs(front_matter)
    return front_matter, dsl[match.end() :]


def canvas_section(front_matter: Any) -> dict[str, Any]:
    """`frontMatter.canvas ?? {}` for the shapes a parser reads (anything else counts as absent)."""
    canvas = front_matter.get("canvas") if isinstance(front_matter, dict) else None
    return canvas if isinstance(canvas, dict) else {}


def section(canvas: dict[str, Any], key: str) -> dict[str, Any]:
    value = canvas.get(key)
    return value if isinstance(value, dict) else {}


def _upgrade_legacy_icon_refs(front_matter: Any) -> None:
    icons = section(canvas_section(front_matter), "icons")
    for ref in icons.values():
        if (
            isinstance(ref, dict)
            and ref.get("libraryId") == "aws-icons"
            and _js_str(ref.get("libraryVersion")) == (LEGACY_AWS_PLACEHOLDER_VERSION)
        ):
            ref["libraryVersion"] = AWS_ICONS_VERSION


def _js_str(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def strip_trailing_comment(line: str) -> str:
    """Drops a `%%` comment (the first `%%` anywhere ends the line), then trailing whitespace."""
    index = line.find("%%")
    if index == -1:
        return line
    return line[:index].rstrip(_TRAILING)


def join_front_matter(front_matter: dict[str, Any], body: str) -> str:
    """The front matter (when any section has content) and the body."""
    canvas = front_matter.get("canvas") or {}
    has_content = any(_has_keys(value) for value in canvas.values())
    if not has_content:
        return body
    return f"---\n{jsyaml.dump(front_matter).rstrip(_TRAILING)}\n---\n{body}"


#: String.prototype.trimEnd's whitespace (as jstext's trim): built from code points, never typed in.
_TRAILING = "".join(
    map(
        chr,
        [
            0x09,
            0x0A,
            0x0B,
            0x0C,
            0x0D,
            0x20,
            0xA0,
            0x1680,
            *range(0x2000, 0x200B),
            0x2028,
            0x2029,
            0x202F,
            0x205F,
            0x3000,
            0xFEFF,
        ],
    )
)


def _has_keys(value: Any) -> bool:
    """`Object.keys(value ?? {}).length > 0`."""
    if value is None:
        return False
    if isinstance(value, dict | list):
        return len(value) > 0
    if isinstance(value, str):
        return len(value) > 0
    return False


def with_legend(front_matter: dict[str, Any], model: dict[str, Any]) -> dict[str, Any]:
    legend = model.get("legend")
    if not legend:
        return front_matter
    return {**front_matter, "canvas": {**(front_matter.get("canvas") or {}), "legend": legend}}


# --- the legend (canvas-ltk) ---------------------------------------------------------------------------


def _short(value: Any, limit: int = 200) -> str | None:
    if isinstance(value, str) and js_trim(value) != "":
        return js_slice(value, 0, limit)
    return None


def read_legend(front_matter: Any) -> dict[str, Any] | None:
    """The legend, validated; anything malformed is dropped (never a parse error)."""
    raw = canvas_section(front_matter).get("legend")
    if not isinstance(raw, dict):
        return None
    legend: dict[str, Any] = {"visible": raw.get("visible") is not False}
    position = raw.get("position")
    if isinstance(position, dict):
        x, y = js_number_value(position.get("x")), js_number_value(position.get("y"))
        if math.isfinite(x) and math.isfinite(y):
            legend["position"] = {"x": x, "y": y}
    title = _short(raw.get("title"))
    if title:
        legend["title"] = title
    hidden = raw.get("hidden")
    if isinstance(hidden, list):
        kept = [h for h in hidden if isinstance(h, str)]
        if kept:
            legend["hidden"] = kept
    labels = raw.get("labels")
    if isinstance(labels, dict):
        named = {k: _short(v) for k, v in labels.items() if _short(v)}
        if named:
            legend["labels"] = named
    extra = raw.get("extra")
    if isinstance(extra, list):
        entries = []
        for entry in extra:
            if not isinstance(entry, dict) or not _short(entry.get("id")) or not _short(entry.get("label")):
                continue
            sample = entry.get("sample")
            if not isinstance(sample, dict):
                continue
            head = {"id": _short(entry.get("id")), "label": _short(entry.get("label"))}
            if sample.get("kind") == "shape" and _short(sample.get("shape")):
                shape = {"kind": "shape", "shape": _short(sample.get("shape"))}
                for key in ("fill", "stroke"):
                    if _short(sample.get(key)):
                        shape[key] = _short(sample.get(key))
                entries.append({**head, "sample": shape})
            elif sample.get("kind") == "line":
                line: dict[str, Any] = {"kind": "line"}
                for key in ("lineStyle", "arrow", "stroke"):
                    if _short(sample.get(key)):
                        line[key] = _short(sample.get(key))
                entries.append({**head, "sample": line})
        if entries:
            legend["extra"] = entries
    return legend
