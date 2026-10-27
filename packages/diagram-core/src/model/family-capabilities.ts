import type { NodeShape } from './diagram-model.js';

/**
 * The node shapes each DSL family can actually express and round-trip, verified against each
 * family's own `dsl/*.ts` parser. `sequence` participants are rectangles (or 'person' for an
 * actor); `c4` elements use whichever shape their role maps to (`ELEMENT_TO_SHAPE` in dsl/c4.ts);
 * `architecture` services are 'icon'-shaped plus 'circle' for junctions.
 *
 * canvas-tfr: moved here from apps/api/src/ai/diagram-tools.ts so the AI tool enums, the
 * standards definition check, and the standards admin editor's shape pickers all read one list.
 * An unrecognized family should fall back to the flowchart set.
 */
export const FAMILY_NODE_SHAPES: Record<string, readonly [NodeShape, ...NodeShape[]]> = {
  flowchart: [
    'rectangle',
    'rounded-rectangle',
    'circle',
    'diamond',
    'cylinder',
    'stadium',
    'subroutine',
    'double-circle',
    'hexagon',
    'parallelogram',
    'parallelogram-alt',
    'trapezoid',
    'trapezoid-alt',
    'asymmetric',
  ],
  c4: ['rectangle', 'person', 'cylinder', 'stadium'],
  sequence: ['rectangle', 'person'],
  erd: ['rectangle'],
  uml: ['rectangle'],
  architecture: ['icon', 'circle'],
};

/** canvas-tfr: families whose DSL can carry an element kind (flowchart via `:::kind`, C4 via its
 *  own role + `_Ext`, architecture via front-matter `canvas.kinds` -- jmuir-dtu.28, since
 *  architecture-beta has no class/tag syntax). Other families support only the v1 standard rules. */
export const FAMILY_SUPPORTS_ELEMENT_KINDS: ReadonlySet<string> = new Set(['flowchart', 'c4', 'architecture']);

/** jmuir-dtu.28: the shapes an element kind may use, where that differs from FAMILY_NODE_SHAPES.
 *  Architecture kinds classify services only -- a junction (the 'circle') is its own role and is
 *  never kinded. */
export const FAMILY_KIND_SHAPES: Record<string, readonly NodeShape[]> = {
  ...FAMILY_NODE_SHAPES,
  architecture: ['icon'],
  // canvas-syd: every shape a C4 role can be drawn as (C4_ROLE_SHAPES in dsl/c4.ts) -- including
  // rounded-rectangle, the shape of every Container and Component. Which of these a given kind may
  // list depends on its role.
  c4: ['person', 'rectangle', 'rounded-rectangle', 'cylinder', 'stadium'],
};

/** jmuir-dtu.28: kind ids that would collide with a role the family's own DSL already uses. */
export const FAMILY_RESERVED_KIND_IDS: Record<string, readonly string[]> = {
  architecture: ['junction'],
};
