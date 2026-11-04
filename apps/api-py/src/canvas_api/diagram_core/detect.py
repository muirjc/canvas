"""Which family a Mermaid text is, from its first line (packages/diagram-core/src/dsl/detect.ts)."""

from __future__ import annotations

import re

from canvas_api.diagram_core.front_matter import split_front_matter
from canvas_api.github.jstext import JS_WHITESPACE, js_trim

__all__ = ["detect_dsl_family"]

_S = f"[{JS_WHITESPACE}]"
HEADER_TO_FAMILY: list[tuple[re.Pattern[str], str]] = [
    (re.compile(f"^(?:flowchart|graph){_S}+(TD|LR|TB|RL|BT)$", re.IGNORECASE | re.ASCII), "flowchart"),
    (re.compile("^C4(Context|Container|Component|Dynamic|Deployment)$"), "c4"),
    (re.compile("^sequenceDiagram$"), "sequence"),
    (re.compile("^erDiagram$"), "erd"),
    (re.compile("^classDiagram$"), "uml"),
    (re.compile("^architecture-beta$"), "architecture"),
    # canvas-bnnh: either header, in any case (Mermaid's grammar).
    (re.compile("^stateDiagram(?:-v2)?$", re.IGNORECASE | re.ASCII), "state"),
]


def detect_dsl_family(dsl: str) -> str | None:
    """The family, or None for empty or unrecognized input."""
    _, body = split_front_matter(dsl)
    first = next((t for t in (js_trim(line) for line in re.split(r"\r?\n", body)) if t), None)
    if first is None:
        return None
    return next((family for pattern, family in HEADER_TO_FAMILY if pattern.match(first)), None)
