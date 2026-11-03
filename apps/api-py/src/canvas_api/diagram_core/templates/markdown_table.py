"""Port of diagram-core's template/markdown-table.ts: the minimal GFM subset a filled-in intake template uses
(``##`` sections, one pipe table each). No diagram-type knowledge lives here."""

from __future__ import annotations

import re
from dataclasses import dataclass

from canvas_api.diagram_core.templates.jsregex import DOT, S
from canvas_api.github.jstext import js_trim

__all__ = ["MarkdownSection", "extract_first_table", "split_into_sections", "split_lines"]


@dataclass(frozen=True)
class MarkdownSection:
    heading: str
    """Heading text with the leading '#'s stripped and trimmed, e.g. "1. Diagram metadata"."""
    level: int
    body: str
    """Raw text between this heading and the next heading of the same or shallower level."""


_LINE_BREAK = re.compile(r"\r\n|\r|\n")
_HEADING_LINE = re.compile(f"(#{{1,6}}){S}+({DOT}+?){S}*")
_TABLE_ROW = re.compile(f"{S}*\\|({DOT}*)\\|{S}*")
_TABLE_SEPARATOR_CELL = re.compile(r":?-+:?")


def split_lines(text: str) -> list[str]:
    """`text.split(/\\r\\n|\\r|\\n/)`."""
    return _LINE_BREAK.split(text)


def split_into_sections(markdown: str) -> list[MarkdownSection]:
    """Sections by heading line; a section's body runs to the next heading of the same or shallower level.
    Content before the first heading is discarded."""
    lines = split_lines(markdown)
    headings: list[tuple[int, str, int]] = []
    for i, line in enumerate(lines):
        match = _HEADING_LINE.fullmatch(line)
        if match:
            headings.append((len(match[1]), match[2], i))
    sections = []
    for i, (level, heading, start) in enumerate(headings):
        end = len(lines)
        for next_level, _, next_start in headings[i + 1 :]:
            if next_level <= level:
                end = next_start
                break
        sections.append(MarkdownSection(heading, level, "\n".join(lines[start + 1 : end])))
    return sections


def _split_row(line: str) -> list[str]:
    match = _TABLE_ROW.fullmatch(line)
    inner = match[1] if match else line
    return [js_trim(cell) for cell in inner.split("|")]


def _is_separator_row(cells: list[str]) -> bool:
    return len(cells) > 0 and all(_TABLE_SEPARATOR_CELL.fullmatch(cell) for cell in cells)


def extract_first_table(text: str) -> list[dict[str, str]]:
    """The first pipe table in `text` as rows keyed by header name. All-blank data rows (the template's unfilled
    placeholders) are dropped; no table gives []."""
    lines = split_lines(text)
    header_index = -1
    for i in range(len(lines) - 1):
        if _TABLE_ROW.fullmatch(lines[i]) and _is_separator_row(_split_row(lines[i + 1])):
            header_index = i
            break
    if header_index == -1:
        return []
    header_cells = _split_row(lines[header_index])
    rows: list[dict[str, str]] = []
    for line in lines[header_index + 2 :]:
        if not _TABLE_ROW.fullmatch(line):
            break
        cells = _split_row(line)
        if all(cell == "" for cell in cells):
            continue
        rows.append({header: cells[col] if col < len(cells) else "" for col, header in enumerate(header_cells)})
    return rows
