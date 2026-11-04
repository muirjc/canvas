"""The built-in diagram type catalog (apps/api/src/seed/diagram-types.seed.ts), scoped by persona.

Upserted on every run; a type an admin created (`origin = 'custom'`) or a built-in one an admin has since
edited (`admin_edited`) is never overwritten, nor are its personas and palette libraries.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import Engine, text

from canvas_api.catalog import PERSONAS

ALL_PERSONAS: tuple[str, ...] = PERSONAS
#: canvas-23t.4: "generic"'s entries are shape-alias sentinels, not artwork: only for a type with no other library.
CLOUD_LIBRARIES: tuple[str, ...] = ("azure-icons", "aws-icons")
#: jmuir-dtu.27: architecture-beta diagrams also get Mermaid's five built-in icons.
ARCHITECTURE_LIBRARIES: tuple[str, ...] = ("mermaid-architecture", *CLOUD_LIBRARIES)
#: canvas-wrk: C4's shape toolbar already covers every C4 element; no palette library.
C4_LIBRARIES: tuple[str, ...] = ()


@dataclass(frozen=True)
class DiagramTypeSeed:
    id: str
    name: str
    personas: tuple[str, ...]
    abstraction_level: str
    dsl_family: str
    default_palette_library_ids: tuple[str, ...]


def _type(
    id: str, name: str, personas: tuple[str, ...], level: str, family: str, palette: tuple[str, ...]
) -> DiagramTypeSeed:
    return DiagramTypeSeed(id, name, personas, level, family, palette)


#: diagram-types.seed.ts DIAGRAM_TYPES, in its order.
DIAGRAM_TYPES: tuple[DiagramTypeSeed, ...] = (
    _type("flowchart", "Generic Flowchart", ALL_PERSONAS, "N/A", "flowchart", ("generic",)),
    _type("c4-context", "C4 Context", ("Solution", "Technical"), "Context", "c4", C4_LIBRARIES),
    _type("c4-container", "C4 Container", ("Solution", "Technical"), "Container", "c4", C4_LIBRARIES),
    _type("c4-component", "C4 Component", ("Technical",), "Component", "c4", C4_LIBRARIES),
    _type("c4-code", "C4 Code", ("Technical",), "Code", "c4", C4_LIBRARIES),
    # jmuir-dtu.3.2: the C4 model's Deployment_Node diagram, distinct from 'deployment' (architecture family).
    _type("c4-deployment", "C4 Deployment", ("Technical",), "Deployment", "c4", C4_LIBRARIES),
    _type("business-capability-map", "Business Capability Map", ("Business",), "N/A", "flowchart", ("generic",)),
    # canvas-tfr: Porter value chain, whose published standard is seeded by reference_standards.py.
    _type("value-chain", "Value Chain", ("Business", "Enterprise"), "N/A", "flowchart", ("generic",)),
    _type("value-stream", "Value Stream Diagram", ("Business",), "N/A", "flowchart", ("generic",)),
    _type(
        "application-landscape",
        "Application/Enterprise Landscape",
        ("Enterprise",),
        "N/A",
        "flowchart",
        ("generic",),
    ),
    _type("roadmap", "Roadmap", ("Enterprise",), "N/A", "flowchart", ("generic",)),
    _type("solution-architecture", "Solution Architecture", ("Solution",), "N/A", "flowchart", CLOUD_LIBRARIES),
    _type("sequence", "Sequence Diagram", ("Solution", "Technical"), "N/A", "sequence", ("generic",)),
    _type("network", "Network Diagram", ("Technical",), "N/A", "architecture", ARCHITECTURE_LIBRARIES),
    _type("deployment", "Deployment Diagram", ("Technical",), "N/A", "architecture", ARCHITECTURE_LIBRARIES),
    _type(
        "cloud-infrastructure",
        "Cloud Infrastructure Diagram",
        ("Technical",),
        "N/A",
        "architecture",
        ARCHITECTURE_LIBRARIES,
    ),
    _type("erd", "Entity-Relationship Diagram", ("Solution", "Technical"), "N/A", "erd", ("generic",)),
    _type("uml", "UML Class Diagram", ("Solution", "Technical"), "N/A", "uml", ("generic",)),
    # canvas-bnnh: Mermaid state diagrams.
    _type("state", "State Diagram", ("Solution", "Technical"), "N/A", "state", ("generic",)),
)

_UPSERT = text(
    "INSERT INTO diagram_types (id, name, abstraction_level, dsl_family) VALUES (:id, :name, :level, :family)"
    " ON CONFLICT (id) DO UPDATE SET name = excluded.name, abstraction_level = excluded.abstraction_level,"
    " dsl_family = excluded.dsl_family"
    " WHERE diagram_types.origin = 'builtin' AND diagram_types.admin_edited = :no"
)
_ROW = text("SELECT origin, admin_edited FROM diagram_types WHERE id = :id")
_DELETE_PERSONAS = text("DELETE FROM diagram_types_personas WHERE diagram_type_id = :id")
_INSERT_PERSONA = text(
    "INSERT INTO diagram_types_personas (diagram_type_id, persona, position) VALUES (:id, :value, :position)"
)
_DELETE_PALETTE = text("DELETE FROM diagram_type_palette_libraries WHERE diagram_type_id = :id")
_INSERT_PALETTE = text(
    "INSERT INTO diagram_type_palette_libraries (diagram_type_id, library_id, position) VALUES (:id, :value, :position)"
)


def seed_diagram_types(engine: Engine) -> None:
    """One transaction per type, as TypeScript: a failure on one type doesn't roll back the others."""
    for seed in DIAGRAM_TYPES:
        with engine.begin() as conn:
            conn.execute(
                _UPSERT,
                {
                    "id": seed.id,
                    "name": seed.name,
                    "level": seed.abstraction_level,
                    "family": seed.dsl_family,
                    "no": False,
                },
            )
            row = conn.execute(_ROW, {"id": seed.id}).first()
            if row is None or row.origin != "builtin" or row.admin_edited:
                continue
            for delete, insert, values in (
                (_DELETE_PERSONAS, _INSERT_PERSONA, seed.personas),
                (_DELETE_PALETTE, _INSERT_PALETTE, seed.default_palette_library_ids),
            ):
                conn.execute(delete, {"id": seed.id})
                if values:
                    conn.execute(insert, [{"id": seed.id, "value": v, "position": i} for i, v in enumerate(values)])
