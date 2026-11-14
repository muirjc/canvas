import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDslFamily, setDiagramLink, type DiagramModel } from '@canvas/diagram-core';
import { Canvas } from '../../src/canvas/Canvas';
import type { LinkTarget } from '../../src/app/diagram-links';

/** canvas-8uh1.3: link badges and the Link to diagram tools on the canvas. */

const D_OK = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const D_BIN = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function parse(family: string, text: string): DiagramModel {
  const result = getDslFamily(family)!.parse(text);
  if (!('model' in result)) throw new Error(`parse failed: ${JSON.stringify(result.errors)}`);
  return result.model;
}

const targets = new Map<string, LinkTarget>([
  [D_OK, { status: 'available', name: 'Payments containers' }],
  [D_BIN, { status: 'deleted' }],
]);

let latest: DiagramModel;
function Harness({ initial, family, ...rest }: { initial: DiagramModel; family: string } & Partial<React.ComponentProps<typeof Canvas>>) {
  const [model, setModel] = useState(initial);
  latest = model;
  return <Canvas model={model} onChange={setModel} dslFamily={family} {...rest} />;
}

const flowchart = () => {
  let m = parse('flowchart', 'graph TD\n  A[Alpha] --> B[Beta]\n  subgraph G [Group]\n    C[Gamma]\n  end\n');
  m = setDiagramLink(m, 'A', D_OK);
  m = setDiagramLink(m, 'B', D_BIN);
  return m;
};

// jsdom has no PointerEvent, so a modifier key on a pointer event would be lost.
if (!('PointerEvent' in window)) (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = class extends MouseEvent {};

afterEach(cleanup);

describe('diagram link badges', () => {
  it('draws a badge per linked element in a flowchart, with its status', () => {
    render(<Harness initial={flowchart()} family="flowchart" diagramLinkTargets={targets} onOpenDiagramLink={() => undefined} />);
    expect(screen.getByTestId('diagram-link-badge-A').getAttribute('data-status')).toBe('available');
    expect(screen.getByTestId('diagram-link-badge-B').getAttribute('data-status')).toBe('deleted');
    expect(screen.queryByTestId('diagram-link-badge-C')).toBeNull();
    expect(screen.getAllByTestId(/^diagram-link-badge-/)).toHaveLength(2);
  });

  it('draws one on a group too', () => {
    const model = setDiagramLink(flowchart(), 'G', D_OK);
    render(<Harness initial={model} family="flowchart" diagramLinkTargets={targets} onOpenDiagramLink={() => undefined} />);
    expect(screen.getByTestId('diagram-link-badge-G')).toBeTruthy();
  });

  it('draws none without onOpenDiagramLink', () => {
    render(<Harness initial={flowchart()} family="flowchart" diagramLinkTargets={targets} />);
    expect(screen.queryByTestId(/^diagram-link-badge-/)).toBeNull();
  });

  it('an available badge opens the diagram on click and on Enter; a broken one does not', () => {
    const open = vi.fn();
    render(<Harness initial={flowchart()} family="flowchart" diagramLinkTargets={targets} onOpenDiagramLink={open} />);
    fireEvent.click(screen.getByTestId('diagram-link-badge-A'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenLastCalledWith(D_OK);
    fireEvent.keyDown(screen.getByTestId('diagram-link-badge-A'), { key: 'Enter' });
    expect(open).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId('diagram-link-badge-B'));
    fireEvent.keyDown(screen.getByTestId('diagram-link-badge-B'), { key: 'Enter' });
    expect(open).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('diagram-link-badge-B').getAttribute('aria-disabled')).toBe('true');
  });

  it('a link with no target known yet is checking and does not open', () => {
    const open = vi.fn();
    render(<Harness initial={flowchart()} family="flowchart" diagramLinkTargets={new Map()} onOpenDiagramLink={open} />);
    expect(screen.getByTestId('diagram-link-badge-A').getAttribute('data-status')).toBe('checking');
    fireEvent.click(screen.getByTestId('diagram-link-badge-A'));
    expect(open).not.toHaveBeenCalled();
  });

  it('works on a Wardley component and a sequence participant', () => {
    const open = vi.fn();
    const wardley = setDiagramLink(parse('wardley', 'wardley-beta\ncomponent Kettle [0.6, 0.45]\n'), 'Kettle', D_OK);
    const { unmount } = render(<Harness initial={wardley} family="wardley" diagramLinkTargets={targets} onOpenDiagramLink={open} />);
    fireEvent.click(screen.getByTestId('diagram-link-badge-Kettle'));
    expect(open).toHaveBeenCalledWith(D_OK);
    unmount();
    const seq = setDiagramLink(parse('sequence', 'sequenceDiagram\n  participant A\n  participant B\n  A->>B: hi\n'), 'A', D_OK);
    render(<Harness initial={seq} family="sequence" diagramLinkTargets={targets} onOpenDiagramLink={open} />);
    fireEvent.click(screen.getByTestId('diagram-link-badge-A'));
    expect(open).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId(/^diagram-link-badge-/)).toHaveLength(1);
  });

  it('is shown to a read-only canvas, which can still follow it', () => {
    const open = vi.fn();
    render(<Harness initial={flowchart()} family="flowchart" readOnly diagramLinkTargets={targets} onOpenDiagramLink={open} />);
    fireEvent.click(screen.getByTestId('diagram-link-badge-A'));
    expect(open).toHaveBeenCalledWith(D_OK);
  });
});

describe('Link to diagram tools', () => {
  const select = (id: string) => fireEvent.pointerDown(screen.getByTestId(`node-${id}`), { button: 0 });

  it('appear for one selected shape and name it when asked', () => {
    const request = vi.fn();
    render(<Harness initial={flowchart()} family="flowchart" diagramLinkTargets={targets} onOpenDiagramLink={() => undefined} onRequestDiagramLink={request} />);
    expect(screen.queryByTestId('link-to-diagram')).toBeNull();
    select('C');
    expect(screen.getByTestId('link-to-diagram').textContent).toContain('Link to diagram');
    expect(screen.queryByTestId('remove-diagram-link')).toBeNull();
    fireEvent.click(screen.getByTestId('link-to-diagram'));
    expect(request).toHaveBeenCalledWith('C');
  });

  it('not for no selection or several shapes', () => {
    render(<Harness initial={flowchart()} family="flowchart" onOpenDiagramLink={() => undefined} onRequestDiagramLink={() => undefined} />);
    select('A');
    expect(screen.getByTestId('link-to-diagram')).toBeTruthy();
    fireEvent.pointerDown(screen.getByTestId('node-B'), { button: 0, shiftKey: true });
    expect(screen.queryByTestId('link-to-diagram')).toBeNull();
  });

  it('a linked selection offers Change link and Remove link, and Remove drops the link from the model', () => {
    render(<Harness initial={flowchart()} family="flowchart" diagramLinkTargets={targets} onOpenDiagramLink={() => undefined} onRequestDiagramLink={() => undefined} />);
    select('A');
    expect(screen.getByTestId('link-to-diagram').textContent).toContain('Change link');
    expect(latest.nodes.find((n) => n.id === 'A')!.diagramRef).toEqual({ diagramId: D_OK });
    fireEvent.click(screen.getByTestId('remove-diagram-link'));
    expect(latest.nodes.find((n) => n.id === 'A')!.diagramRef).toBeUndefined();
    expect(latest.nodes.find((n) => n.id === 'B')!.diagramRef).toEqual({ diagramId: D_BIN });
    expect(screen.queryByTestId('diagram-link-badge-A')).toBeNull();
  });

  it('are not offered without onRequestDiagramLink', () => {
    render(<Harness initial={flowchart()} family="flowchart" onOpenDiagramLink={() => undefined} />);
    select('A');
    expect(screen.queryByTestId('link-to-diagram')).toBeNull();
  });
});
