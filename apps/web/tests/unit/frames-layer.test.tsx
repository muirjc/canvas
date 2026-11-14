import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addFrame, createEmptyDiagramModel, getDslFamily, type DiagramFrame, type DiagramModel, type FrameContent } from '@canvas/diagram-core';
import { Canvas } from '../../src/canvas/Canvas';
import { FramesLayer, type FramesLayerProps } from '../../src/canvas/FramesLayer';

/** canvas-8uh1.6: frames -- other diagrams drawn in a frame on this one. */

const D_OK = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const D_BIN = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const D_GONE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const D_DRAFT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D_WAIT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// jsdom has no PointerEvent: without one, clientX/clientY on a pointer event would be lost.
if (!('PointerEvent' in window)) (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = class extends MouseEvent {};

const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

const frames: DiagramFrame[] = [
  { id: 'f1', diagramId: D_OK, position: { x: 100, y: 50 }, size: { width: 300, height: 200 } },
  { id: 'f2', diagramId: D_BIN, position: { x: 500, y: 50 }, size: { width: 300, height: 200 } },
  { id: 'f3', diagramId: D_GONE, position: { x: 100, y: 300 }, size: { width: 300, height: 200 } },
  { id: 'f4', diagramId: D_DRAFT, position: { x: 500, y: 300 }, size: { width: 300, height: 200 } },
  { id: 'f5', diagramId: D_WAIT, position: { x: 900, y: 50 }, size: { width: 300, height: 200 } },
];
const contents = new Map<string, FrameContent>([
  [D_OK, { status: 'available', name: 'Payments containers', svg: SVG_TEXT }],
  [D_BIN, { status: 'deleted' }],
  [D_GONE, { status: 'missing' }],
  [D_DRAFT, { status: 'unavailable' }],
]);

function layer(over: Partial<FramesLayerProps> = {}) {
  const props: FramesLayerProps = {
    frames,
    contents,
    selectedFrameId: null,
    readOnly: false,
    toCanvasPoint: (event) => ({ x: (event as unknown as MouseEvent).clientX, y: (event as unknown as MouseEvent).clientY }),
    onSelect: vi.fn(),
    onMove: vi.fn(),
    onResize: vi.fn(),
    onOpen: vi.fn(),
    ...over,
  };
  render(
    <svg>
      <FramesLayer {...props} />
    </svg>,
  );
  return props;
}

afterEach(cleanup);

describe('FramesLayer', () => {
  it('draws the framed diagram as an image, with its title and an Open button', () => {
    layer();
    const frame = screen.getByTestId('diagram-frame-f1');
    expect(frame.getAttribute('data-status')).toBe('available');
    expect(frame.textContent).toContain('Payments containers');
    expect(frame.querySelector('image')?.getAttribute('href')).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(screen.queryByTestId('frame-placeholder-f1')).toBeNull();
    expect(screen.getByTestId('frame-open-f1')).toBeTruthy();
  });

  it('says why a frame cannot show its diagram, and offers no Open', () => {
    layer();
    const expected: Record<string, [string, string]> = {
      f2: ['deleted', 'Deleted (in the bin)'],
      f3: ['missing', 'Diagram no longer exists'],
      f4: ['unavailable', 'Not available'],
      f5: ['checking', 'Loading…'],
    };
    for (const [id, [status, text]] of Object.entries(expected)) {
      expect(screen.getByTestId(`diagram-frame-${id}`).getAttribute('data-status')).toBe(status);
      expect(screen.getByTestId(`frame-placeholder-${id}`).textContent).toBe(text);
      expect(screen.queryByTestId(`frame-open-${id}`)).toBeNull();
      expect(screen.getByTestId(`diagram-frame-${id}`).querySelector('image')).toBeNull();
    }
  });

  it('Open calls back with the framed diagram and does not select the frame', () => {
    const props = layer();
    fireEvent.pointerDown(screen.getByTestId('frame-open-f1'), { button: 0 });
    fireEvent.click(screen.getByTestId('frame-open-f1'));
    expect(props.onOpen).toHaveBeenCalledWith(D_OK);
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('pressing on a frame selects it', () => {
    const props = layer();
    fireEvent.pointerDown(screen.getByTestId('diagram-frame-f2'), { button: 0, clientX: 520, clientY: 70 });
    expect(props.onSelect).toHaveBeenCalledWith('f2');
  });

  it('dragging a frame moves it by how far the pointer went', () => {
    const props = layer();
    const frame = screen.getByTestId('diagram-frame-f1');
    fireEvent.pointerDown(frame, { button: 0, clientX: 110, clientY: 70 });
    fireEvent.pointerMove(frame, { clientX: 210, clientY: 170 });
    expect(props.onMove).toHaveBeenLastCalledWith('f1', { x: 200, y: 150 });
    fireEvent.pointerUp(frame, { clientX: 210, clientY: 170 });
    fireEvent.pointerMove(frame, { clientX: 400, clientY: 400 });
    expect(props.onMove).toHaveBeenCalledTimes(1);
  });

  it('shows the resize handle only on the selected frame, and dragging it resizes', () => {
    const props = layer({ selectedFrameId: 'f1' });
    expect(screen.queryByTestId('frame-resize-f2')).toBeNull();
    const handle = screen.getByTestId('frame-resize-f1');
    fireEvent.pointerDown(handle, { button: 0, clientX: 400, clientY: 250 });
    fireEvent.pointerMove(handle, { clientX: 450, clientY: 320 });
    expect(props.onResize).toHaveBeenLastCalledWith('f1', { width: 350, height: 270 });
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onMove).not.toHaveBeenCalled();
  });

  it('read-only: no handle, and a drag moves nothing', () => {
    const props = layer({ selectedFrameId: 'f1', readOnly: true });
    expect(screen.queryByTestId('frame-resize-f1')).toBeNull();
    const frame = screen.getByTestId('diagram-frame-f1');
    fireEvent.pointerDown(frame, { button: 0, clientX: 110, clientY: 70 });
    fireEvent.pointerMove(frame, { clientX: 210, clientY: 170 });
    expect(props.onMove).not.toHaveBeenCalled();
    // Open still works.
    fireEvent.click(screen.getByTestId('frame-open-f1'));
    expect(props.onOpen).toHaveBeenCalledWith(D_OK);
  });
});

describe('Canvas with frames', () => {
  let latest: DiagramModel;
  function Harness({ initial, ...rest }: { initial: DiagramModel } & Partial<React.ComponentProps<typeof Canvas>>) {
    const [model, setModel] = useState(initial);
    latest = model;
    return <Canvas model={model} onChange={setModel} dslFamily="flowchart" {...rest} />;
  }
  const withFrame = () => {
    const parsed = getDslFamily('flowchart')!.parse('graph TD\n  A[Alpha] --> B[Beta]\n');
    if (!('model' in parsed)) throw new Error('parse failed');
    return addFrame(parsed.model, { diagramId: D_OK, position: { x: 600, y: 40 } });
  };

  it('Embed diagram is offered with onRequestFrame and calls it', () => {
    const request = vi.fn();
    render(<Harness initial={createEmptyDiagramModel('flowchart')} onRequestFrame={request} />);
    fireEvent.click(screen.getByTestId('embed-diagram'));
    expect(request).toHaveBeenCalledTimes(1);
    cleanup();
    render(<Harness initial={createEmptyDiagramModel('flowchart')} />);
    expect(screen.queryByTestId('embed-diagram')).toBeNull();
  });

  it('draws a frame from the model, using the contents it is given', () => {
    const model = withFrame();
    render(<Harness initial={model} frameContents={new Map([[D_OK, { status: 'available', name: 'Inner', svg: SVG_TEXT }]])} />);
    const id = model.frames![0].id;
    expect(screen.getByTestId(`diagram-frame-${id}`).textContent).toContain('Inner');
  });

  it('selecting a frame offers Remove frame, which drops it from the model', () => {
    const model = withFrame();
    const id = model.frames![0].id;
    render(<Harness initial={model} onRequestFrame={() => undefined} />);
    expect(screen.queryByTestId('remove-frame')).toBeNull();
    fireEvent.pointerDown(screen.getByTestId(`diagram-frame-${id}`), { button: 0, clientX: 610, clientY: 50 });
    expect(screen.getByTestId(`frame-resize-${id}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId('remove-frame'));
    expect(latest.frames ?? []).toHaveLength(0);
    expect(screen.queryByTestId(`diagram-frame-${id}`)).toBeNull();
    expect(latest.nodes).toHaveLength(2);
  });

  it.each(['Delete', 'Backspace'])('%s removes the selected frame and leaves the shapes', (key) => {
    const model = withFrame();
    const id = model.frames![0].id;
    render(<Harness initial={model} />);
    fireEvent.pointerDown(screen.getByTestId(`diagram-frame-${id}`), { button: 0, clientX: 610, clientY: 50 });
    fireEvent.keyDown(screen.getByTestId('canvas-root'), { key });
    expect(latest.frames ?? []).toHaveLength(0);
    expect(latest.nodes).toHaveLength(2);
  });

  it('selecting a shape deselects the frame', () => {
    const model = withFrame();
    const id = model.frames![0].id;
    render(<Harness initial={model} onRequestFrame={() => undefined} />);
    fireEvent.pointerDown(screen.getByTestId(`diagram-frame-${id}`), { button: 0, clientX: 610, clientY: 50 });
    expect(screen.getByTestId(`frame-resize-${id}`)).toBeTruthy();
    fireEvent.pointerDown(screen.getByTestId('node-A'), { button: 0 });
    expect(screen.queryByTestId(`frame-resize-${id}`)).toBeNull();
    expect(screen.queryByTestId('remove-frame')).toBeNull();
  });

  it('read-only: no Delete removal, no resize handle', () => {
    const model = withFrame();
    const id = model.frames![0].id;
    render(<Harness initial={model} readOnly />);
    fireEvent.pointerDown(screen.getByTestId(`diagram-frame-${id}`), { button: 0, clientX: 610, clientY: 50 });
    expect(screen.queryByTestId(`frame-resize-${id}`)).toBeNull();
    fireEvent.keyDown(screen.getByTestId('canvas-root'), { key: 'Delete' });
    expect(latest.frames).toHaveLength(1);
  });
});
