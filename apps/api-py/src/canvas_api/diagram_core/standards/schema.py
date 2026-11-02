"""Standard rule constants (packages/diagram-core/src/standards/schema.ts). Rules themselves are plain dicts shaped
like StandardRules, as they come from the database or the API as JSON."""

from __future__ import annotations

import re
from typing import Any

__all__ = ["DEFAULT_SEVERITY", "KIND_ID_PATTERN", "RESERVED_KIND_IDS", "RULE_IDS", "empty_standard_rules"]

RULE_IDS = (
    "allowed-shapes",
    "mandatory-shapes",
    "allowed-icon-libraries",
    "color-palette",
    "font-family",
    "font-size",
    "unknown-kind",
    "kind-shape",
    "kind-fill",
    "kind-stroke",
    "kind-min-count",
    "kind-max-count",
    "kind-group-min-count",
    "kind-group-max-count",
    "kind-unconnected",
    "connector-not-allowed",
    "connector-style",
    "connector-label-required",
    "connector-max-per-source",
    "container-not-allowed",
)

#: 'error' renders as "Must fix" but never blocks a save.
DEFAULT_SEVERITY: dict[str, str] = {
    "allowed-shapes": "warning",
    "mandatory-shapes": "warning",
    "allowed-icon-libraries": "warning",
    "color-palette": "warning",
    "font-family": "warning",
    "font-size": "warning",
    "unknown-kind": "error",
    "kind-shape": "warning",
    "kind-fill": "warning",
    "kind-stroke": "info",
    "kind-min-count": "error",
    "kind-max-count": "error",
    "kind-group-min-count": "error",
    "kind-group-max-count": "error",
    "kind-unconnected": "info",
    "connector-not-allowed": "error",
    "connector-style": "info",
    "connector-label-required": "warning",
    "connector-max-per-source": "warning",
    "container-not-allowed": "warning",
}

#: Mermaid flowchart keywords, and `default` (which `classDef default` would apply to every node).
RESERVED_KIND_IDS = (
    "default",
    "end",
    "class",
    "classdef",
    "style",
    "subgraph",
    "click",
    "linkstyle",
    "graph",
    "flowchart",
    "direction",
)
#: /^[a-z][a-z0-9_]*$/ -- use fullmatch (JavaScript's `$` here never matches before a final newline).
KIND_ID_PATTERN = re.compile(r"[a-z][a-z0-9_]*")


def empty_standard_rules() -> dict[str, Any]:
    return {"allowedShapeIds": [], "mandatoryShapeIds": [], "allowedIconLibraryRefs": [], "colorPalette": []}
