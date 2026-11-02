"""What authors can add besides a standard's element kinds (packages/diagram-core/src/standards/authoring.ts)."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

__all__ = ["SHAPE_ALIAS_LIBRARY_ID", "effective_authoring", "icon_library_offered", "offered_shapes"]

#: The shape-alias "icons" (Rectangle, Diamond / Decision, ...) are generic shapes, not artwork.
SHAPE_ALIAS_LIBRARY_ID = "generic"


def effective_authoring(rules: dict[str, Any] | None = None) -> dict[str, Any]:
    """{shapes, icons}: 'all' | 'listed' | 'none'. With no explicit `authoring`, a strict standard (requireKnownKinds
    with kinds) offers only its kinds; otherwise a non-empty allowed list means 'listed', an empty one 'all'."""
    if rules is None:
        return {"shapes": "all", "icons": "all"}
    strict = bool(rules.get("requireKnownKinds")) and len(rules.get("elementKinds") or []) > 0
    authoring = rules.get("authoring") or {}
    shapes = authoring.get("shapes")
    icons = authoring.get("icons")
    if shapes is None:
        shapes = "none" if strict else ("listed" if len(rules["allowedShapeIds"]) > 0 else "all")
    if icons is None:
        icons = "none" if strict else ("listed" if len(rules["allowedIconLibraryRefs"]) > 0 else "all")
    return {"shapes": shapes, "icons": icons}


def offered_shapes(family_shapes: Sequence[str], rules: dict[str, Any] | None = None) -> list[str]:
    """The generic shapes to offer, in the family list's order."""
    shapes = effective_authoring(rules)["shapes"]
    if shapes == "none":
        return []
    if shapes == "listed" and rules is not None:
        return [shape for shape in family_shapes if shape in rules["allowedShapeIds"]]
    return list(family_shapes)


def icon_library_offered(library_id: str, rules: dict[str, Any] | None = None) -> bool:
    """Whether icons from this library may be offered (any version: a standard lists libraries)."""
    if library_id == SHAPE_ALIAS_LIBRARY_ID:
        return bool(effective_authoring(rules)["shapes"] == "all")
    icons = effective_authoring(rules)["icons"]
    if icons == "none":
        return False
    if icons == "listed" and rules is not None:
        return any(ref.get("libraryId") == library_id for ref in rules["allowedIconLibraryRefs"])
    return True
