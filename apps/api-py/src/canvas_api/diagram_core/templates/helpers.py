"""Port of diagram-core's template/template-helpers.ts: helpers shared by every template compiler."""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from typing import Any

from canvas_api.diagram_core.templates.jsregex import S
from canvas_api.diagram_core.templates.markdown_table import MarkdownSection, extract_first_table
from canvas_api.github.jstext import js_trim

__all__ = [
    "AliasAllocator",
    "camel_slug",
    "cell",
    "err",
    "find_section",
    "list_cell",
    "pick_option",
    "read_metadata_fields",
    "read_yes_no",
]

_SECTION_NUMBER = re.compile(f"^[0-9]+\\.{S}*")
_NON_ALNUM = re.compile(r"[^A-Za-z0-9]+")


def find_section(sections: list[MarkdownSection], match: str) -> MarkdownSection | None:
    """A section whose heading, minus any leading "3." number, starts with `match` (lower case)."""
    for section in sections:
        if js_trim(_SECTION_NUMBER.sub("", section.heading, count=1)).lower().startswith(match):
            return section
    return None


def err(message: str) -> dict[str, Any]:
    """A compile error, in ParseError's shape. Templates have no meaningful DSL line."""
    return {"line": 0, "content": "", "message": message}


def read_metadata_fields(section: MarkdownSection) -> dict[str, str]:
    """A "Field | Value" table as a field -> value map."""
    fields: dict[str, str] = {}
    for row in extract_first_table(section.body):
        field = row.get("Field")
        if field is not None:
            fields[js_trim(field)] = js_trim(row.get("Value", ""))
    return fields


def cell(row: dict[str, str], *headers: str) -> str:
    """The first non-blank value among several possible column headers, trimmed."""
    for header in headers:
        value = row.get(header)
        if value is not None and js_trim(value):
            return js_trim(value)
    return ""


def camel_slug(name: str, fallback: str = "entity") -> str:
    """ "Payment Gateway" -> "paymentGateway", "API Gateway" -> "apiGateway"."""
    tokens = [t for t in _NON_ALNUM.split(name) if t]
    if not tokens:
        return fallback
    out = []
    for i, token in enumerate(tokens):
        if i == 0:
            out.append(token.lower() if token == token.upper() else token[0].lower() + token[1:])
        else:
            out.append(token[0].upper() + token[1:].lower())
    return "".join(out)


class AliasAllocator:
    """Unique DSL ids from display names: the first use of a slug keeps it, each later collision gets a numeric
    suffix (2, 3, ...)."""

    def __init__(self, slug: Callable[[str], str] | None = None) -> None:
        self._slug = slug or camel_slug
        self._used: dict[str, int] = {}

    def allocate(self, name: str) -> str:
        base = self._slug(name)
        count = self._used.get(base, 0)
        self._used[base] = count + 1
        return base if count == 0 else f"{base}{count + 1}"


def pick_option[T: str](value: str, options: Sequence[T]) -> T | None:
    """Case-insensitive match of `value` against `options`; the canonical option, or None."""
    wanted = js_trim(value).lower()
    return next((option for option in options if option.lower() == wanted), None)


def read_yes_no(value: str, fallback: bool) -> bool | None:
    """Yes/No cell: blank -> `fallback`; anything else must read as yes/no (None if not)."""
    v = js_trim(value).lower()
    if not v:
        return fallback
    if v in ("yes", "y", "true"):
        return True
    if v in ("no", "n", "false"):
        return False
    return None


def list_cell(value: str) -> list[str]:
    """A comma-separated cell, trimmed, blanks dropped."""
    return [part for part in (js_trim(p) for p in value.split(",")) if part]
