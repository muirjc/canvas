import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ElementLink, LinkTarget } from '../../src/app/diagram-links';
import { elementLinks } from '../../src/app/diagram-links';
import { LinksPanel, type LinksPanelProps } from '../../src/links/LinksPanel';

/** canvas-8uh1.3: the editor's Links tab. */

const links: ElementLink[] = [
  { elementId: 'pay', label: 'Payments', kind: 'node', diagramId: 'd-ok' },
  { elementId: 'bin', label: 'Binned', kind: 'node', diagramId: 'd-bin' },
  { elementId: 'gone', label: 'Gone', kind: 'container', diagramId: 'd-gone' },
  { elementId: 'draft', label: 'Draft', kind: 'node', diagramId: 'd-draft' },
  { elementId: 'wait', label: 'Waiting', kind: 'node', diagramId: 'd-wait' },
];
const targets = new Map<string, LinkTarget>([
  ['d-ok', { status: 'available', name: 'Payments containers', projectName: 'Shop' }],
  ['d-bin', { status: 'deleted' }],
  ['d-gone', { status: 'missing' }],
  ['d-draft', { status: 'unavailable' }],
  ['d-wait', { status: 'checking' }],
]);

function setup(over: Partial<LinksPanelProps> = {}) {
  const props: LinksPanelProps = {
    links,
    targets,
    usedIn: [],
    canEdit: true,
    onOpen: vi.fn(),
    onChange: vi.fn(),
    onRemove: vi.fn(),
    onSelectElement: vi.fn(),
    ...over,
  };
  render(<LinksPanel {...props} />);
  return props;
}

afterEach(cleanup);

describe('LinksPanel', () => {
  it('shows each link with its status and where it goes', () => {
    setup();
    const row = (id: string) => screen.getByTestId(`link-row-${id}`);
    expect(row('pay').getAttribute('data-status')).toBe('available');
    expect(row('pay').textContent).toContain('Payments containers');
    expect(row('pay').textContent).toContain('Shop');
    expect(row('bin').getAttribute('data-status')).toBe('deleted');
    expect(row('bin').textContent).toContain('Deleted (in the bin)');
    expect(row('gone').textContent).toContain('Diagram no longer exists');
    expect(row('draft').textContent).toContain('Not available');
    expect(row('wait').getAttribute('data-status')).toBe('checking');
    // A link with no entry yet counts as checking.
    cleanup();
    setup({ targets: new Map() });
    expect(screen.getByTestId('link-row-pay').getAttribute('data-status')).toBe('checking');
  });

  it('offers Open only for a link that can be opened', () => {
    const props = setup();
    expect(screen.queryByTestId('link-open-bin')).toBeNull();
    expect(screen.queryByTestId('link-open-gone')).toBeNull();
    expect(screen.queryByTestId('link-open-draft')).toBeNull();
    fireEvent.click(screen.getByTestId('link-open-pay'));
    expect(props.onOpen).toHaveBeenCalledWith('d-ok');
  });

  it('Change, Remove and the element name call back with the element id', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('link-change-bin'));
    expect(props.onChange).toHaveBeenCalledWith('bin');
    fireEvent.click(screen.getByTestId('link-remove-gone'));
    expect(props.onRemove).toHaveBeenCalledWith('gone');
    fireEvent.click(screen.getByText('Payments'));
    expect(props.onSelectElement).toHaveBeenCalledWith('pay');
  });

  it('read-only hides Change and Remove but keeps Open', () => {
    setup({ canEdit: false });
    expect(screen.queryByTestId('link-change-pay')).toBeNull();
    expect(screen.queryByTestId('link-remove-pay')).toBeNull();
    expect(screen.getByTestId('link-open-pay')).toBeTruthy();
  });

  it('says so when nothing links, with a hint only for editors', () => {
    setup({ links: [] });
    expect(screen.getByTestId('links-from-empty').textContent).toMatch(/Link to diagram/);
    cleanup();
    setup({ links: [], canEdit: false });
    expect(screen.getByTestId('links-from-empty').textContent).not.toMatch(/Link to diagram/);
  });

  it('lists the diagrams that link here, and opens one', () => {
    const props = setup({
      usedIn: [{ diagramId: 'u1', name: 'Context', diagramTypeId: 'c4-context', projectId: 'p', projectName: 'Shop', elementIds: ['a'] }],
    });
    expect(screen.queryByTestId('used-in-empty')).toBeNull();
    fireEvent.click(screen.getByTestId('used-in-open-u1'));
    expect(props.onOpen).toHaveBeenCalledWith('u1');
  });

  it('shows Used in as empty, and as loading while it is null', () => {
    setup({ usedIn: [] });
    expect(screen.getByTestId('used-in-empty')).toBeTruthy();
    cleanup();
    setup({ usedIn: null });
    expect(screen.queryByTestId('used-in-empty')).toBeNull();
    expect(screen.queryByTestId('used-in-list')).toBeNull();
  });
});

describe('LinksPanel embedded diagrams', () => {
  const frames = [
    { id: 'f1', diagramId: 'd-ok', position: { x: 0, y: 0 }, size: { width: 300, height: 200 } },
    { id: 'f2', diagramId: 'd-bin', position: { x: 0, y: 0 }, size: { width: 300, height: 200 } },
    { id: 'f3', diagramId: 'd-wait', position: { x: 0, y: 0 }, size: { width: 300, height: 200 } },
  ];
  const contents = new Map([
    ['d-ok', { status: 'available' as const, name: 'Payments containers' }],
    ['d-bin', { status: 'deleted' as const }],
  ]);

  it('lists nothing when there are no frames', () => {
    setup();
    expect(screen.queryByTestId('frames-list')).toBeNull();
  });

  it('shows each frame with its state; Open only when it can be opened', () => {
    const props = setup({ frames, frameContents: contents, onRemoveFrame: vi.fn() });
    expect(screen.getByTestId('frame-row-f1').getAttribute('data-status')).toBe('available');
    expect(screen.getByTestId('frame-row-f1').textContent).toContain('Payments containers');
    expect(screen.getByTestId('frame-row-f2').getAttribute('data-status')).toBe('deleted');
    expect(screen.getByTestId('frame-row-f2').textContent).toContain('Deleted (in the bin)');
    expect(screen.getByTestId('frame-row-f3').getAttribute('data-status')).toBe('checking');
    expect(screen.queryByTestId('frame-row-open-f2')).toBeNull();
    expect(screen.queryByTestId('frame-row-open-f3')).toBeNull();
    fireEvent.click(screen.getByTestId('frame-row-open-f1'));
    expect(props.onOpen).toHaveBeenCalledWith('d-ok');
  });

  it('Remove frame calls back with the frame id, for editors only', () => {
    const onRemoveFrame = vi.fn();
    setup({ frames, frameContents: contents, onRemoveFrame });
    fireEvent.click(screen.getByTestId('frame-row-remove-f2'));
    expect(onRemoveFrame).toHaveBeenCalledWith('f2');
    cleanup();
    setup({ frames, frameContents: contents, onRemoveFrame, canEdit: false });
    expect(screen.queryByTestId('frame-row-remove-f1')).toBeNull();
    expect(screen.getByTestId('frame-row-open-f1')).toBeTruthy();
  });
});

describe('elementLinks', () => {
  it('lists shapes first, then groups, falling back to the id for a missing label', () => {
    const model = {
      nodes: [{ id: 'n1', label: '', diagramRef: { diagramId: 'd1' } }, { id: 'n2', label: 'No link' }],
      containers: [{ id: 'c1', label: 'Group', diagramRef: { diagramId: 'd2' } }],
    };
    expect(elementLinks(model as never)).toEqual([
      { elementId: 'n1', label: 'n1', kind: 'node', diagramId: 'd1' },
      { elementId: 'c1', label: 'Group', kind: 'container', diagramId: 'd2' },
    ]);
  });
});
