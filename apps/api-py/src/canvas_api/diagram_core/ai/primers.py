"""Port of apps/api/src/ai/diagram-type-primers.ts: one short plain-language orientation per diagram family, put
in the AI chat's system prompt. tests/test_diagram_core_ai.py pins the text to TypeScript's (the prompt vectors)."""

from __future__ import annotations

__all__ = ["PRIMERS", "primer_for"]

PRIMERS: dict[str, str] = {
    "flowchart": (
        "This is a flowchart. Shapes represent steps or decisions in a process — the available shapes "
        "include rectangles, rounded rectangles, circles, diamonds, cylinders, stadiums, subroutines, "
        "double-circles, hexagons, parallelograms (or their mirrored parallelogram-alt/ trapezoid-alt "
        "orientation), trapezoids, and asymmetric shapes. Connectors between shapes show the direction of "
        "flow and may be labeled, drawn as a solid, dotted, thick, or invisible line, with an arrowhead "
        "at one end, both ends, or none at all. Related shapes can be grouped into a labeled container."
    ),
    "c4": (
        "This is a C4 model diagram, showing software architecture at a specific level of abstraction. "
        "Every element has a role — person, software system, container, or component (each optionally "
        "marked external) — describing what kind of thing it represents, not just a visual shape; most "
        "elements are drawn as a rectangle, except a database (a cylinder shape) or a message queue (a "
        "stadium/pill shape). Related elements can be grouped inside a labeled boundary — a generic "
        "boundary, a system boundary, a container boundary, an enterprise boundary, or (for deployment "
        "diagrams) a deployment node. Relationships describe how elements interact, usually with a short "
        "description of the interaction."
    ),
    "architecture": (
        "This is a cloud/service architecture diagram. Each service is drawn as an icon representing a "
        "piece of infrastructure and belongs to a group representing a logical or network boundary — a "
        "service added without an explicit group is left ungrouped, which is usually not what is wanted. "
        "A junction is the one node with no icon at all — a plain circle used purely as a routing point "
        "where edges bend or fan out, never a real service. Edges connect services (or, at a coarser "
        "level, groups) to show how they interact."
    ),
    "sequence": (
        "This is a sequence diagram. Participants (drawn as a rectangle, or as an actor/person shape) "
        "exchange an ordered series of messages over time, read top to bottom, drawn with a solid or "
        "dotted line and an arrowhead that is a plain forward arrow, both-ended, a failed/erroring cross, "
        "an open async arrowhead, or none at all. Activation marks the span during which a participant is "
        "actively processing a request. Related participants can be grouped into a labeled box."
    ),
    "erd": (
        "This is an entity-relationship diagram. Each entity (drawn as a rectangle) has a name and zero "
        "or more typed attributes, and an attribute may be marked as a primary key (PK), foreign key "
        "(FK), or unique key (UK). Relationships between entities describe how many of one entity relate "
        "to how many of another (cardinality) — this is central to what makes an ER diagram correct, not "
        "optional decoration. Each end of a relationship carries its own crow's-foot cardinality token: "
        "on the source side, || (exactly one), |o (zero or one), }| (one or many), or }o (zero or many); "
        "on the target side, || (exactly one), o| (zero or one), |{ (one or many), or o{ (zero or many). "
        "A relationship is also either identifying (a solid line) or non-identifying (a dotted line)."
    ),
    "uml": (
        "This is a UML class diagram. Each class (drawn as a rectangle) has a name and zero or more "
        "members — typed attributes and methods marked with a visibility symbol (+ public, - private, # "
        "protected, ~ package/internal). A relationship between two classes has a specific kind — "
        "inheritance, composition, aggregation, association, dependency, realization, a plain solid or "
        "dashed link (link-solid/link-dashed), or a lollipop interface connection "
        "(lollipop-source/lollipop-target) — that carries real meaning, distinct from a plain connector, "
        "and may carry a cardinality label at either end. Related classes can be grouped into a "
        "namespace, and a note can be attached to a class or stand alone to hold free-form commentary."
    ),
    # canvas-bnnh: Mermaid state diagrams.
    "state": (
        "This is a state diagram: the states something can be in and the transitions between them. Add each "
        "element with addState and the right kind: a state (a named rounded box), the start point (a black dot "
        "every flow begins from) and the end point (a ringed dot), a choice (a small diamond where the path "
        "splits on a condition -- label each outgoing transition with its condition), or a fork and a join (bars "
        "that split into, and later rejoin, paths that run at the same time). There is one start and one end per "
        "diagram and per composite state. Label transitions with the event that causes them. Related states can "
        "be grouped into a composite state (a group, made with groupIntoContainer, kind composite), which may "
        "have its own start and end inside it, and a transition may lead into or out of a composite state as a "
        "whole."
    ),
}


def primer_for(family: str) -> str | None:
    """The primer for a family; None for one without (an own key only: "constructor" isn't a family)."""
    return PRIMERS.get(family)
