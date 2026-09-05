/**
 * 010-ai-diagram-knowledge, T007 (research.md §2, data-model.md's `DiagramTypePrimer` section):
 * one short, hand-authored, plain-language orientation per diagram-type family — NOT literal DSL
 * grammar (the AI never emits raw DSL directly, Constitution I; the deterministic `diagram-core`
 * serializer already guarantees syntactic validity). This is what tells the model which of its
 * available tools/fields are relevant for the diagram it is currently editing.
 *
 * Kept honest by a drift-guard contract test (T023, research.md §6): every enum value currently
 * exposed by a family's tool set must be mentioned somewhere in that family's primer text below.
 * If a future grammar expansion adds a new enum value to a tool schema without this file being
 * updated to match, that test fails — the anti-drift guarantee FR-005 requires, made real rather
 * than aspirational.
 */

export interface DiagramTypePrimer {
  /** Matches `registry.ts`'s `dslFamily` id. */
  dslFamily: string;
  /** 2-4 sentence plain-language orientation, appended to the system prompt after the persona's
   *  own framing and before the current-diagram summary (`describeModel()`). */
  summary: string;
}

const PRIMERS: Record<string, DiagramTypePrimer> = {
  flowchart: {
    dslFamily: 'flowchart',
    summary:
      'This is a flowchart. Shapes represent steps or decisions in a process — the available ' +
      'shapes include rectangles, rounded rectangles, circles, diamonds, cylinders, stadiums, ' +
      'subroutines, double-circles, hexagons, parallelograms, trapezoids, and asymmetric shapes. ' +
      'Connectors between shapes show the direction of flow and may be labeled. Related shapes ' +
      'can be grouped into a labeled container.',
  },
  c4: {
    dslFamily: 'c4',
    summary:
      'This is a C4 model diagram, showing software architecture at a specific level of ' +
      'abstraction. Every element has a role — person, software system, container, or component ' +
      '(each optionally marked external) — describing what kind of thing it represents, not just ' +
      'a visual shape. Related elements can be grouped inside a labeled boundary. Relationships ' +
      'describe how elements interact, usually with a short description of the interaction.',
  },
  sequence: {
    dslFamily: 'sequence',
    summary:
      'This is a sequence diagram. Participants (or actors, for a person) exchange an ordered ' +
      'series of messages over time, read top to bottom. Activation marks the span during which ' +
      'a participant is actively processing a request. Messages can be a plain call, an ' +
      'asynchronous call, or a reply, and related participants can be grouped into a labeled box.',
  },
  erd: {
    dslFamily: 'erd',
    summary:
      'This is an entity-relationship diagram. Each entity has a name and zero or more typed ' +
      'attributes, and an attribute may be marked as a primary key, foreign key, or unique key. ' +
      'Relationships between entities describe how many of one entity relate to how many of ' +
      'another (cardinality) — this is central to what makes an ER diagram correct, not optional ' +
      'decoration.',
  },
  uml: {
    dslFamily: 'uml',
    summary:
      'This is a UML class diagram. Each class has a name and zero or more members — typed, ' +
      'visibility-marked attributes and methods. A relationship between two classes has a ' +
      'specific kind (inheritance, composition, aggregation, association, dependency, or ' +
      'realization) that carries real meaning, distinct from a plain connector, and may carry a ' +
      'cardinality label at either end.',
  },
  architecture: {
    dslFamily: 'architecture',
    summary:
      'This is a cloud/service architecture diagram. Each service represents a piece of ' +
      'infrastructure and belongs to a group representing a logical or network boundary — a ' +
      'service added without an explicit group is left ungrouped, which is usually not what is ' +
      'wanted. Edges connect services (or, at a coarser level, groups) to show how they interact.',
  },
};

/** Returns the primer for a family, or `undefined` for an unregistered family id (should not
 *  happen in practice — every `dslFamily` a diagram can actually have is one of the 6 above). */
export function getDiagramTypePrimer(dslFamily: string): DiagramTypePrimer | undefined {
  return PRIMERS[dslFamily];
}
