"""What each diagram family can express (packages/diagram-core/src/model/family-capabilities.ts): the node shapes
it round-trips, whether its DSL carries element kinds, and the kind ids its own DSL reserves."""

from __future__ import annotations

__all__ = ["FAMILY_KIND_SHAPES", "FAMILY_NODE_SHAPES", "FAMILY_RESERVED_KIND_IDS", "FAMILY_SUPPORTS_ELEMENT_KINDS"]

#: An unrecognized family falls back to the flowchart set.
FAMILY_NODE_SHAPES: dict[str, tuple[str, ...]] = {
    "flowchart": (
        "rectangle",
        "rounded-rectangle",
        "circle",
        "diamond",
        "cylinder",
        "stadium",
        "subroutine",
        "double-circle",
        "hexagon",
        "parallelogram",
        "parallelogram-alt",
        "trapezoid",
        "trapezoid-alt",
        "asymmetric",
    ),
    "c4": ("rectangle", "person", "cylinder", "stadium"),
    "sequence": ("rectangle", "person"),
    "erd": ("rectangle",),
    "uml": ("rectangle",),
    "architecture": ("icon", "circle"),
}

#: Families whose DSL can carry an element kind (flowchart `:::kind`, C4 role + `_Ext`, architecture front matter).
FAMILY_SUPPORTS_ELEMENT_KINDS = frozenset({"flowchart", "c4", "architecture"})

#: The shapes an element kind may use, where that differs from FAMILY_NODE_SHAPES.
FAMILY_KIND_SHAPES: dict[str, tuple[str, ...]] = {
    **FAMILY_NODE_SHAPES,
    "architecture": ("icon",),
    "c4": ("person", "rectangle", "rounded-rectangle", "cylinder", "stadium"),
}

#: Kind ids that would collide with a role the family's own DSL already uses.
FAMILY_RESERVED_KIND_IDS: dict[str, tuple[str, ...]] = {"architecture": ("junction",)}
