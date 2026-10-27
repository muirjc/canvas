import { describe, expect, it } from 'vitest';
import { C4_ELEMENT_ROLES, C4_ROLE_SHAPES, getDslFamily, type DiagramModel } from '../../src/index.js';

/**
 * canvas-syd: C4_ROLE_SHAPES is what a C4 element of each role can actually be drawn as -- every
 * listed shape must survive serialize -> parse, and nothing else may.
 */
const c4 = getDslFamily('c4')!;
const roundTripShape = (role: string, shape: string, external: boolean) => {
  const model: DiagramModel = {
    ...(c4.parse('C4Context\n') as { model: DiagramModel }).model,
    nodes: [{ id: 'n1', label: 'N', shape: shape as DiagramModel['nodes'][number]['shape'], position: { x: 0, y: 0 }, role, ...(external ? { external: true } : {}) }],
  };
  const reparsed = c4.parse(c4.serialize(model)) as { model: DiagramModel };
  return reparsed.model.nodes[0].shape;
};

describe('C4_ROLE_SHAPES', () => {
  it('covers every C4 element role', () => {
    expect(Object.keys(C4_ROLE_SHAPES).sort()).toEqual([...C4_ELEMENT_ROLES].sort());
  });

  for (const role of C4_ELEMENT_ROLES) {
    for (const external of [false, true]) {
      it(`${role}${external ? ' (external)' : ''}: each listed shape round-trips unchanged`, () => {
        for (const shape of C4_ROLE_SHAPES[role]) expect(roundTripShape(role, shape, external)).toBe(shape);
      });
      it(`${role}${external ? ' (external)' : ''}: an unlisted shape does not survive`, () => {
        for (const shape of ['person', 'rectangle', 'rounded-rectangle', 'cylinder', 'stadium'].filter((s) => !(C4_ROLE_SHAPES[role] as readonly string[]).includes(s))) {
          expect(roundTripShape(role, shape, external)).not.toBe(shape);
        }
      });
    }
  }
});
