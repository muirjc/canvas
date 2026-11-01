"""Catalog values the TypeScript service gets from diagram-core and its seed.

Held equal to apps/api/contract/constants.json (written by the TypeScript tests) by
tests/test_contract.py, so a family, persona or built-in diagram type added there can't be missed here.
"""

from __future__ import annotations

#: packages/diagram-core/src/dsl/registry.ts dslFamilies, in its order (error messages list them).
DSL_FAMILIES: tuple[str, ...] = ("flowchart", "c4", "architecture", "sequence", "erd", "uml")

#: apps/api/src/seed/diagram-types.seed.ts PERSONAS.
PERSONAS: tuple[str, ...] = ("Business", "Enterprise", "Solution", "Technical")

#: apps/api/src/seed/diagram-types.seed.ts BUILTIN_DIAGRAM_TYPE_IDS.
BUILTIN_DIAGRAM_TYPE_IDS: tuple[str, ...] = (
    "flowchart",
    "c4-context",
    "c4-container",
    "c4-component",
    "c4-code",
    "c4-deployment",
    "business-capability-map",
    "value-chain",
    "value-stream",
    "application-landscape",
    "roadmap",
    "solution-architecture",
    "sequence",
    "network",
    "deployment",
    "cloud-infrastructure",
    "erd",
    "uml",
)
