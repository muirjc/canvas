import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { getDslFamily, type DiagramModel } from '@canvas/diagram-core';
import { Canvas } from '../../src/canvas/Canvas';
import { getAddableShapes, nodeSize } from '../../src/canvas/shapes';

/** canvas-bnnh part 2: the State diagram's toolbar adds each kind through addStateNode. */

function parseState(text: string): DiagramModel {
  const result = getDslFamily('state')!.parse(text);
  if (!('model' in result)) throw new Error(`parse failed: ${JSON.stringify(result.errors)}`);
  return result.model;
}

let latest: DiagramModel;
function Harness({ initial }: { initial: DiagramModel }) {
  const [model, setModel] = useState(initial);
  latest = model;
  return <Canvas model={model} onChange={setModel} dslFamily="state" />;
}

describe('state diagram toolbar', () => {
  afterEach(cleanup);

  it('offers no generic shapes for the state family', () => {
    expect(getAddableShapes('state')).toEqual([]);
  });

  it('offers the six kinds and each adds an element with the state role and shape', () => {
    render(<Harness initial={parseState('stateDiagram-v2\n')} />);
    const expected: Record<string, { role: string; shape: string }> = {
      state: { role: 'state', shape: 'rounded-rectangle' },
      start: { role: 'start', shape: 'state-start' },
      end: { role: 'end', shape: 'state-end' },
      choice: { role: 'choice', shape: 'diamond' },
      fork: { role: 'fork', shape: 'fork-bar' },
      join: { role: 'join', shape: 'fork-bar' },
    };
    for (const [kind, want] of Object.entries(expected)) {
      fireEvent.click(screen.getByTestId(`add-state-${kind}`));
      const added = latest.nodes[latest.nodes.length - 1];
      expect(added.role).toBe(want.role);
      expect(added.shape).toBe(want.shape);
    }
    expect(latest.nodes).toHaveLength(6);
    // One start and one end per scope: the buttons switch off.
    expect((screen.getByTestId('add-state-start') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('add-state-end') as HTMLButtonElement).disabled).toBe(true);
    // Pseudo-states are drawn at their small, shared sizes.
    const dot = latest.nodes.find((n) => n.shape === 'state-start')!;
    expect(nodeSize(dot)).toEqual({ width: 24, height: 24 });
    const bar = latest.nodes.find((n) => n.shape === 'fork-bar')!;
    expect(nodeSize(bar)).toEqual({ width: 80, height: 10 });
  });

  it('draws a start point without a label and a connector that ends on a composite state', () => {
    render(<Harness initial={parseState('stateDiagram-v2\n  Idle\n  state Active {\n    [*] --> Working\n  }\n  Idle --> Active\n')} />);
    expect(screen.getByTestId('node-Idle')).toBeTruthy();
    expect(screen.getAllByTestId(/^edge-/).length).toBe(2);
    expect(screen.queryByText('[*]')).toBeNull();
  });
});
