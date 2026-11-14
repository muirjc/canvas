import { describe, expect, it } from 'vitest';
import { readTrail, trailState } from '../../src/app/navigation';

/** canvas-8uh1.3: the trail of diagrams followed by links, kept in history.state. */

const D1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const D2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

describe('readTrail', () => {
  it('reads the trail a state holds', () => {
    const trail = [{ diagramId: D1, name: 'Context' }, { diagramId: D2, name: 'Containers' }];
    expect(readTrail({ canvasTrail: trail })).toEqual(trail);
  });

  it('ignores state that is not a trail', () => {
    for (const state of [null, undefined, 'x', 3, [], {}, { canvasTrail: 'x' }, { canvasTrail: { diagramId: D1, name: 'A' } }]) {
      expect(readTrail(state)).toEqual([]);
    }
  });

  it('drops entries of the wrong shape and ids that are not UUIDs', () => {
    const state = {
      canvasTrail: [
        null,
        'x',
        { diagramId: D1 },
        { diagramId: 7, name: 'n' },
        { diagramId: 'not-a-uuid', name: 'Bad' },
        { diagramId: '../x', name: 'Bad' },
        { diagramId: D2, name: 'Good' },
      ],
    };
    expect(readTrail(state)).toEqual([{ diagramId: D2, name: 'Good' }]);
  });

  it('keeps the last 20', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ diagramId: D1, name: `d${i}` }));
    const read = readTrail({ canvasTrail: many });
    expect(read).toHaveLength(20);
    expect(read[0].name).toBe('d5');
    expect(read[19].name).toBe('d24');
  });
});

describe('trailState', () => {
  it('is null for no trail, as every other navigation writes', () => {
    expect(trailState([])).toBeNull();
  });

  it('wraps a trail, capped at 20, and reads back', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ diagramId: D1, name: `d${i}` }));
    const state = trailState(many)!;
    expect(state.canvasTrail).toHaveLength(20);
    expect(readTrail(state)).toEqual(state.canvasTrail);
  });
});
