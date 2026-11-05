import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { getDslFamily } from '@canvas/diagram-core';
import { Canvas } from '../../src/canvas/Canvas';

/** canvas-8wxq part 1: half arrows and central connections are drawn on the canvas as in the export. */
describe('sequence message glyphs on the canvas', () => {
  afterEach(cleanup);

  it('draws a half-arrow head without a marker and a central-connection circle', () => {
    const result = getDslFamily('sequence')!.parse('sequenceDiagram\n  participant A\n  participant B\n  A-|\\B: half\n  A->>()B: central\n');
    if (!('model' in result)) throw new Error(JSON.stringify(result.errors));
    const { container } = render(<Canvas model={result.model} onChange={() => {}} dslFamily="sequence" />);
    const [half, central] = result.model.edges;
    const halfGroup = container.querySelector(`[data-testid="edge-${half.id}"]`)!;
    expect(halfGroup.querySelector('polygon')).not.toBeNull();
    expect(halfGroup.querySelector('line')!.getAttribute('marker-end')).toBeNull();
    const centralGroup = container.querySelector(`[data-testid="edge-${central.id}"]`)!;
    expect(centralGroup.querySelector('circle')).not.toBeNull();
    expect(centralGroup.querySelector('line')!.getAttribute('marker-end')).not.toBeNull();
  });
});
