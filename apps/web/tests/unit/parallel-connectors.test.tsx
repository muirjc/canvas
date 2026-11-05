import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { getDslFamily } from '@canvas/diagram-core';
import { Canvas } from '../../src/canvas/Canvas';

/** canvas-y2yf: connectors joining the same two shapes don't overlap; a connector to itself draws a loop. */
describe('parallel connectors and self-loops', () => {
  afterEach(cleanup);

  it('draws A->B and B->A on separate lines and a self-connector as a loop path', () => {
    const result = getDslFamily('flowchart')!.parse('graph TD\n  A --> B\n  B --> A\n  A --> A\n');
    if (!('model' in result)) throw new Error('parse failed');
    render(<Canvas model={result.model} onChange={() => {}} dslFamily="flowchart" />);
    const [e1, e2, e3] = result.model.edges;
    const line = (id: string) => screen.getByTestId(`edge-${id}`).querySelector('line')!;
    const a = line(e1.id);
    const b = line(e2.id);
    expect(`${a.getAttribute('x1')},${a.getAttribute('y1')}`).not.toBe(`${b.getAttribute('x2')},${b.getAttribute('y2')}`);
    const loop = screen.getByTestId(`edge-${e3.id}`).querySelector('path')!;
    expect(loop.getAttribute('d')).toMatch(/^M .* C /);
  });
});
