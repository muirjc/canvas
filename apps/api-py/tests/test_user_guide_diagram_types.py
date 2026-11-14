"""canvas-ilhl: the user guide's "Choosing a diagram type" page describes every built-in diagram type."""

from __future__ import annotations

import re
from pathlib import Path

from canvas_api.seed.diagram_types import DIAGRAM_TYPES

PAGE = Path(__file__).resolve().parents[3] / "docs" / "user-guide" / "diagram-types.md"


def _type_headings() -> list[str]:
    return re.findall(r"^### (.+?)\s*$", PAGE.read_text(encoding="utf-8"), re.MULTILINE)


def test_every_built_in_type_has_its_own_section() -> None:
    headings = _type_headings()
    missing = [seed.name for seed in DIAGRAM_TYPES if seed.name not in headings]
    assert not missing, f"add a section to {PAGE.name} for: {', '.join(missing)}"


def test_every_section_is_a_built_in_type() -> None:
    names = {seed.name for seed in DIAGRAM_TYPES}
    stale = [heading for heading in _type_headings() if heading not in names]
    assert not stale, f"{PAGE.name} describes types Canvas doesn't seed: {', '.join(stale)}"


def test_each_section_names_the_personas_the_type_is_for() -> None:
    text = PAGE.read_text(encoding="utf-8")
    for seed in DIAGRAM_TYPES:
        section = text.split(f"### {seed.name}\n", 1)[1].split("\n#", 1)[0]
        line = re.search(r"^\*\*For:\*\* (.+)$", section, re.MULTILINE)
        assert line, f"{seed.name}: no **For:** line"
        if set(seed.personas) == {"Business", "Enterprise", "Solution", "Technical"}:
            assert "every persona" in line.group(1), seed.name
        else:
            for persona in seed.personas:
                assert persona in line.group(1), f"{seed.name}: **For:** should name {persona}"
