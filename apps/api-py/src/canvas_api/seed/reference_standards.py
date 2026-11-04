"""The built-in standards (apps/api/src/seed/reference-standards.seed.ts): two strict reference standards (Value
Chain, C4 Context, canvas-tfr) and a descriptive starter for every other built-in type (canvas-chq).

A standard is seeded, published and its type's diagrams re-checked only for a diagram type that exists and has
NO standard rows at all (any status), so an admin's own edits, or a deliberate retire, are never overwritten.
Key order inside each rule object is TypeScript's, so the stored JSON text is the same.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import Engine, text

from canvas_api.diagram_core import DiagramCore
from canvas_api.diagram_core.family_capabilities import FAMILY_NODE_SHAPES
from canvas_api.standards import create_draft_standard, publish_standard, revalidate_type_diagrams


def _empty_v1() -> dict[str, Any]:
    return {"allowedShapeIds": [], "mandatoryShapeIds": [], "allowedIconLibraryRefs": [], "colorPalette": []}


VALUE_CHAIN_STANDARD: dict[str, Any] = {
    **_empty_v1(),
    "requireKnownKinds": True,
    "connectorPolicy": "listed-only",
    "elementKinds": [
        {
            "id": "primary_activity",
            "label": "Primary Activity",
            "description": "An activity that directly creates and delivers value: inbound logistics, operations,"
            " outbound logistics, marketing & sales, service. Chain them left to right in the order value flows.",
            "shapes": ["asymmetric"],
            "approvedFills": ["#dbeafe", "#bfdbfe"],
            "approvedStrokes": ["#1d4ed8"],
            "minCount": 1,
            "requireConnection": True,
        },
        {
            "id": "support_activity",
            "label": "Support Activity",
            "description": "An activity that enables the primary activities across the whole chain: firm"
            " infrastructure, human resource management, technology development, procurement. Not connected into"
            " the primary flow.",
            "shapes": ["rectangle"],
            "approvedFills": ["#fef3c7", "#fde68a"],
            "approvedStrokes": ["#b45309"],
            "minCount": 1,
        },
        {
            "id": "margin",
            "label": "Margin",
            "description": "The value captured: exactly one, at the end of the primary activity chain.",
            "shapes": ["hexagon"],
            "approvedFills": ["#dcfce7"],
            "approvedStrokes": ["#15803d"],
            "minCount": 1,
            "maxCount": 1,
        },
    ],
    "connectorRules": [
        {
            "id": "flow",
            "label": "Value flow",
            "from": "primary_activity",
            "to": "primary_activity",
            "lineStyles": ["solid"],
            "arrows": ["target"],
            "maxPerSource": 1,
        },
        {
            "id": "to_margin",
            "label": "Delivers margin",
            "from": "primary_activity",
            "to": "margin",
            "lineStyles": ["solid"],
            "arrows": ["target"],
            "maxPerSource": 1,
        },
    ],
    "guidance": "Porter's value chain: primary activities in sequence left to right (typically 5: inbound"
    " logistics, operations, outbound logistics, marketing & sales, service), the last one feeding the single"
    " Margin element. Support activities (typically 4: firm infrastructure, HR management, technology"
    " development, procurement) sit as bands above the primary chain and are not connected into it.",
}

# Fills match the C4 role defaults the renderer already draws, so an unstyled element is compliant out of the box.
# canvas-1n3: every element must be connected -- an unconnected one is a Warning.
C4_CONTEXT_STANDARD: dict[str, Any] = {
    **_empty_v1(),
    "requireKnownKinds": True,
    "connectorPolicy": "any",
    "elementKinds": [
        {
            "id": "person",
            "label": "Person",
            "description": "A user of the system (Person).",
            "shapes": ["person"],
            "approvedFills": ["#08427b"],
            "match": {"role": "person", "external": False},
            "requireConnection": True,
        },
        {
            "id": "external_person",
            "label": "External Person",
            "description": "A person outside the organisation (Person_Ext).",
            "shapes": ["person"],
            "approvedFills": ["#686868"],
            "match": {"role": "person", "external": True},
            "requireConnection": True,
        },
        {
            "id": "software_system",
            "label": "Software System",
            "description": "The system in scope, or another internal system (System / SystemDb / SystemQueue).",
            "shapes": ["rectangle", "cylinder", "stadium"],
            "approvedFills": ["#1168bd"],
            "match": {"role": "system", "external": False},
            "requireConnection": True,
            "minCount": 1,
        },
        {
            "id": "external_system",
            "label": "External System",
            "description": "A system outside the scope being described (System_Ext / SystemDb_Ext / SystemQueue_Ext).",
            "shapes": ["rectangle", "cylinder", "stadium"],
            "approvedFills": ["#999999"],
            "match": {"role": "system", "external": True},
            "requireConnection": True,
        },
    ],
    "connectorRules": [{"id": "relationship", "label": "Relationship", "from": "*", "to": "*", "requireLabel": True}],
    "severityOverrides": {"kind-unconnected": "warning"},
    "containers": {"allowed": True, "allowedRoles": ["enterprise-boundary", "system-boundary", "boundary"]},
    "guidance": "A C4 System Context diagram shows the software system in scope, the people who use it, and the"
    " other systems it depends on -- nothing inside a system (no containers or components). Every relationship"
    " needs a label describing what it does.",
}


# ---- canvas-chq: starter standards for every other built-in type ---------------------------------------------
# Descriptive, not restrictive: no requireKnownKinds, shape lists = everything the family can already express.


def _family_shapes(family: str) -> list[str]:
    return list(FAMILY_NODE_SHAPES.get(family, FAMILY_NODE_SHAPES["flowchart"]))


def _descriptive_starter(family: str, guidance: str) -> dict[str, Any]:
    return {**_empty_v1(), "allowedShapeIds": _family_shapes(family), "guidance": guidance}


def _c4_kind(
    id: str, label: str, description: str, shapes: list[str], fill: str, role: str, external: bool
) -> dict[str, Any]:
    return {
        "id": id,
        "label": label,
        "description": description,
        "shapes": shapes,
        "approvedFills": [fill],
        "match": {"role": role, "external": external},
    }


C4_KINDS: dict[str, dict[str, Any]] = {
    "person": _c4_kind(
        "person", "Person", "A user of the system (Person).", ["person"], "#08427b", "person", external=False
    ),
    "external_person": _c4_kind(
        "external_person",
        "External Person",
        "A person outside the organisation (Person_Ext).",
        ["person"],
        "#686868",
        "person",
        external=True,
    ),
    "software_system": _c4_kind(
        "software_system",
        "Software System",
        "A software system (System / SystemDb / SystemQueue).",
        [],
        "#1168bd",
        "system",
        external=False,
    ),
    "external_system": _c4_kind(
        "external_system",
        "External System",
        "A system outside the scope (System_Ext and variants).",
        [],
        "#999999",
        "system",
        external=True,
    ),
    "container": _c4_kind(
        "container",
        "Container",
        "An application or data store inside a system (Container / ContainerDb / ContainerQueue).",
        [],
        "#438dd5",
        "container",
        external=False,
    ),
    "external_container": _c4_kind(
        "external_container",
        "External Container",
        "A container outside the scope (Container_Ext and variants).",
        [],
        "#b3b3b3",
        "container",
        external=True,
    ),
    "component": _c4_kind(
        "component",
        "Component",
        "A component inside a container (Component / ComponentDb / ComponentQueue).",
        [],
        "#85bbf0",
        "component",
        external=False,
    ),
    "external_component": _c4_kind(
        "external_component",
        "External Component",
        "A component outside the scope (Component_Ext and variants).",
        [],
        "#cccccc",
        "component",
        external=True,
    ),
}


def _c4_starter(
    kind_ids: list[str], boundary_roles: list[str], guidance: str, *, require_connection: bool = False
) -> dict[str, Any]:
    """canvas-1n3: `require_connection` flags an unconnected element as a Warning (Container and Component)."""
    rules: dict[str, Any] = {
        **_empty_v1(),
        "elementKinds": [
            {**C4_KINDS[id], "requireConnection": True} if require_connection else dict(C4_KINDS[id]) for id in kind_ids
        ],
        "connectorPolicy": "any",
        "connectorRules": [
            {"id": "relationship", "label": "Relationship", "from": "*", "to": "*", "requireLabel": True}
        ],
    }
    if require_connection:
        rules["severityOverrides"] = {"kind-unconnected": "warning"}
    rules["containers"] = {"allowed": True, "allowedRoles": boundary_roles}
    rules["guidance"] = guidance
    return rules


def _standard(diagram_type_id: str, name: str, description: str, rules: dict[str, Any]) -> dict[str, Any]:
    return {"diagramTypeId": diagram_type_id, "name": name, "description": description, "rules": rules}


_C4_EDIT = "Edit to tighten."

STARTER_STANDARDS: list[dict[str, Any]] = [
    _standard(
        "c4-container",
        "C4 Container (starter)",
        f"Standard C4 element kinds and colors for a container diagram. {_C4_EDIT}",
        _c4_starter(
            ["person", "external_person", "software_system", "external_system", "container", "external_container"],
            ["enterprise-boundary", "system-boundary", "container-boundary", "boundary"],
            "A C4 Container diagram zooms into one software system and shows its containers (applications, data"
            " stores, queues), the people who use them and the external systems they talk to. Label every"
            ' relationship with what it does and how (e.g. "Reads/writes [SQL]").',
            require_connection=True,
        ),
    ),
    _standard(
        "c4-component",
        "C4 Component (starter)",
        f"Standard C4 element kinds and colors for a component diagram. {_C4_EDIT}",
        _c4_starter(
            [
                "person",
                "external_person",
                "software_system",
                "external_system",
                "container",
                "external_container",
                "component",
                "external_component",
            ],
            ["system-boundary", "container-boundary", "boundary"],
            "A C4 Component diagram zooms into one container and shows its components and how they interact with"
            " each other and with surrounding containers and systems. Label every relationship.",
            require_connection=True,
        ),
    ),
    _standard(
        "c4-code",
        "C4 Code (starter)",
        f"Standard C4 element kinds and colors for a code-level diagram. {_C4_EDIT}",
        _c4_starter(
            [
                "container",
                "external_container",
                "component",
                "external_component",
                "software_system",
                "external_system",
            ],
            ["container-boundary", "boundary"],
            "A C4 Code-level view zooms into a single component. Keep it focused on the elements that matter for"
            " understanding that component, and label every relationship.",
        ),
    ),
    _standard(
        "c4-deployment",
        "C4 Deployment (starter)",
        f"Standard C4 element kinds and colors for a deployment diagram. {_C4_EDIT}",
        _c4_starter(
            ["person", "external_person", "software_system", "external_system", "container", "external_container"],
            ["deployment-node", "enterprise-boundary", "system-boundary", "boundary"],
            "A C4 Deployment diagram shows how containers map onto infrastructure: nest containers inside"
            " Deployment_Nodes (environments, servers, clusters, managed services). Label every relationship.",
        ),
    ),
    _standard(
        "flowchart",
        "Generic Flowchart (starter)",
        "Every flowchart shape is allowed. Narrow the shapes or add element kinds to standardise.",
        _descriptive_starter(
            "flowchart",
            "A general-purpose flowchart: steps, decisions and flows. Use diamonds for decisions and label the"
            " outgoing branches.",
        ),
    ),
    _standard(
        "business-capability-map",
        "Business Capability Map (starter)",
        "Every flowchart shape is allowed. Add element kinds (e.g. capability levels) to standardise.",
        _descriptive_starter(
            "flowchart",
            "A business capability map shows what the business does (not how), grouped hierarchically: level-1"
            " capabilities as groupings containing their level-2/3 capabilities. Name capabilities as nouns"
            ' ("Customer Management"), not processes.',
        ),
    ),
    _standard(
        "value-stream",
        "Value Stream (starter)",
        "Every flowchart shape is allowed. Add element kinds (e.g. stages) to standardise.",
        _descriptive_starter(
            "flowchart",
            "A value stream shows the end-to-end stages that deliver value to a customer, left to right, from"
            ' trigger to value delivered. Name stages as outcomes ("Order Fulfilled").',
        ),
    ),
    _standard(
        "application-landscape",
        "Application Landscape (starter)",
        "Every flowchart shape is allowed. Add element kinds (e.g. application tiers) to standardise.",
        _descriptive_starter(
            "flowchart",
            "An application landscape shows the organisation's applications, grouped by domain or capability, and"
            " the key integrations between them. Label integrations with the data or interface exchanged.",
        ),
    ),
    _standard(
        "roadmap",
        "Roadmap (starter)",
        "Every flowchart shape is allowed. Add element kinds (e.g. initiative, milestone) to standardise.",
        _descriptive_starter(
            "flowchart",
            "A roadmap lays out initiatives and milestones over time, left to right, typically grouped into lanes"
            " (themes or teams). Show dependencies between initiatives as connectors.",
        ),
    ),
    _standard(
        "solution-architecture",
        "Solution Architecture (starter)",
        "Every flowchart shape and the cloud icon libraries are allowed. Narrow to standardise.",
        _descriptive_starter(
            "flowchart",
            "A solution architecture shows the components of one solution, the platforms and services it runs on,"
            " and the integrations between them. Label connections with protocol or data flow.",
        ),
    ),
    _standard(
        "sequence",
        "Sequence Diagram (starter)",
        "Participants and actors as today. Edit to add rules.",
        _descriptive_starter(
            "sequence",
            "A sequence diagram shows the messages exchanged between participants over time, top to bottom. Use"
            " actors for people, participants for systems, and label every message.",
        ),
    ),
    _standard(
        "erd",
        "Entity-Relationship Diagram (starter)",
        "Entities as today. Edit to add rules.",
        _descriptive_starter(
            "erd",
            "An ER diagram shows entities, their attributes (mark keys PK/FK/UK) and the cardinality of the"
            " relationships between them. Name entities as singular nouns.",
        ),
    ),
    _standard(
        "uml",
        "UML Class Diagram (starter)",
        "Classes as today. Edit to add rules.",
        _descriptive_starter(
            "uml",
            "A UML class diagram shows classes with their attributes and methods (with visibility), and the"
            " relationships between them (inheritance, composition, aggregation, association, dependency).",
        ),
    ),
    _standard(
        "state",
        "State Diagram (starter)",
        "States as today. Edit to add rules.",
        _descriptive_starter(
            "state",
            "A state diagram shows the states something can be in and the events that move it between them. Start"
            " from the start point, label every transition with its event, and use choice points for conditions.",
        ),
    ),
    _standard(
        "network",
        "Network Diagram (starter)",
        "Services and junctions as today. Edit to add rules.",
        _descriptive_starter(
            "architecture",
            "A network diagram shows network zones as groups, the services and devices inside them, and the"
            " connections between them. Use cloud icons where they exist.",
        ),
    ),
    _standard(
        "deployment",
        "Deployment Diagram (starter)",
        "Services and junctions as today. Edit to add rules.",
        _descriptive_starter(
            "architecture",
            "A deployment diagram shows where software runs: environments and hosting platforms as groups, the"
            " services deployed into them, and how they connect.",
        ),
    ),
    _standard(
        "cloud-infrastructure",
        "Cloud Infrastructure (starter)",
        "Services and junctions as today. Edit to add rules.",
        _descriptive_starter(
            "architecture",
            "A cloud infrastructure diagram shows cloud resources grouped by subscription/account, region and"
            " network, using the provider's official icons.",
        ),
    ),
]

REFERENCE_STANDARDS: list[dict[str, Any]] = [
    _standard(
        "value-chain",
        "Value Chain (Porter)",
        "Primary activities in sequence feeding a single margin, with support activities alongside.",
        VALUE_CHAIN_STANDARD,
    ),
    _standard(
        "c4-context",
        "C4 System Context",
        "People and software systems only, in the standard C4 colors, with labelled relationships.",
        C4_CONTEXT_STANDARD,
    ),
]

#: canvas-chq: the two strict reference standards plus a starter for every other built-in type.
BUILT_IN_STANDARDS: list[dict[str, Any]] = [*REFERENCE_STANDARDS, *STARTER_STANDARDS]

_TYPE_EXISTS = text("SELECT id FROM diagram_types WHERE id = :id")
_ANY_STANDARD = text("SELECT id FROM standards WHERE diagram_type_id = :id")


def seed_reference_standards(engine: Engine, core: DiagramCore) -> list[str]:
    """Returns the diagram type ids that got a standard this run. Each one is drafted, published and its
    diagrams re-checked in one transaction."""
    seeded: list[str] = []
    for ref in BUILT_IN_STANDARDS:
        type_id: str = ref["diagramTypeId"]
        with engine.begin() as conn:
            if conn.execute(_TYPE_EXISTS, {"id": type_id}).first() is None:
                continue
            if conn.execute(_ANY_STANDARD, {"id": type_id}).first() is not None:
                continue
            draft = create_draft_standard(conn, type_id, ref["rules"], ref["name"], ref["description"])
            publish_standard(conn, draft["id"], type_id)
            revalidate_type_diagrams(conn, core, type_id)
        seeded.append(type_id)
    return seeded
