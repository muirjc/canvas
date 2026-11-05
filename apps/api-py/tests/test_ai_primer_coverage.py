"""Drift guard for the AI's diagram-type primers (FR-005, canvas-rfds).

Every enum value a family's AI tools accept (shape, arrow, lineStyle, kind, role, keys, cardinalities,
relation kinds, visibility, ...) must be mentioned in that family's primer, so a new option can't ship
without the model being told about it. The check reads each tool's live input schema (`list_tools`), not a
hand-copied list. A mention is a case-insensitive substring match with hyphens read as spaces, so
"rounded-rectangle" is found in "rounded rectangles" and plurals pass.

Exempt: enum values reached through a property named `side`, `alignment`, `axis` or `direction`. These are
the layout tools' self-describing geometry vocabulary (above/below/left/right, left/center/.../bottom,
horizontal/vertical, TD/LR/BT/RL); they are left out of the primers on purpose.
`test_exempt_properties_all_occur` keeps that list honest: a renamed property can't silently widen it.

Ported from the TypeScript `diagram-type-primers.test.ts` (tag `typescript-api-final`).
"""

from __future__ import annotations

from typing import Any

import pytest

from canvas_api.diagram_core.ai import list_tools
from canvas_api.diagram_core.ai.primers import primer_for

FAMILIES = ["flowchart", "c4", "architecture", "sequence", "erd", "uml", "state"]
EXEMPT_PROPERTIES = {"side", "alignment", "axis", "direction"}

Found = list[tuple[str, str, str]]  # (tool, property, enum value)


def _walk(schema: Any, tool: str, prop: str, out: Found) -> None:
    if isinstance(schema, list):
        for item in schema:
            _walk(item, tool, prop, out)
        return
    if not isinstance(schema, dict):
        return
    for value in schema.get("enum", []):
        if isinstance(value, str):
            out.append((tool, prop, value))
    if "const" in schema and isinstance(schema["const"], str):
        out.append((tool, prop, schema["const"]))
    for name, sub in (schema.get("properties") or {}).items():
        _walk(sub, tool, name, out)
    for key in ("items", "additionalProperties", "anyOf", "oneOf", "allOf"):
        _walk(schema.get(key), tool, prop, out)


def collect(family: str) -> Found:
    out: Found = []
    for tool in list_tools(family, None):
        _walk(tool["inputSchema"], tool["name"], "", out)
    return out


def mentions(primer: str, value: str) -> bool:
    def norm(s: str) -> str:
        return s.lower().replace("-", " ")

    return norm(value) in norm(primer)


@pytest.mark.parametrize("family", FAMILIES)
def test_every_enum_value_is_in_the_primer(family: str) -> None:
    primer = primer_for(family)
    assert primer, f"no primer for {family}"
    checked = [f for f in collect(family) if f[1] not in EXEMPT_PROPERTIES]
    assert checked, "walker found no enum values; the check would pass vacuously"
    missing = sorted({f for f in checked if not mentions(primer, f[2])})
    assert not missing, f"{family} primer never mentions (tool, property, value): {missing}"


def test_exempt_properties_all_occur() -> None:
    seen = {prop for family in FAMILIES for _, prop, _ in collect(family)}
    assert seen >= EXEMPT_PROPERTIES, f"exempt but never in any tool schema: {EXEMPT_PROPERTIES - seen}"
