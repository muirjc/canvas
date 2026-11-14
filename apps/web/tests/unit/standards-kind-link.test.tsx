// canvas-8uh1.5: an element kind's "should link to" types, authored in the standards editor and checked live.
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDiagramModel, emptyStandardRules, type DiagramModel, type StandardRules } from '@canvas/diagram-core';
import { StandardsEditor } from '../../src/admin/StandardsEditor';
import { api, type DiagramTypeDto, type StandardDto } from '../../src/app/api';
import { linkTargetTypes, type LinkTarget } from '../../src/app/diagram-links';
import { useLiveViolations } from '../../src/standards/useStandard';

function type(id: string, name: string): DiagramTypeDto {
  return { id, name, personas: [], abstractionLevel: 'x', dslFamily: 'flowchart', defaultPaletteLibraryIds: [], origin: 'builtin', description: null } as DiagramTypeDto;
}
const TYPE = type('flowchart', 'Flowchart');

function draft(linkTo?: string[]): StandardDto {
  const rules: StandardRules = {
    ...emptyStandardRules(),
    elementKinds: [{ id: 'system', label: 'System', shapes: ['rectangle'], approvedFills: [], ...(linkTo ? { linkTo } : {}) }],
  };
  return { id: 's-1', diagramTypeId: 'flowchart', version: 1, status: 'draft', name: 'Rules', description: null, rules, publishedAt: null, createdAt: '', retiredAt: null };
}

describe('StandardsEditor "should link to"', () => {
  let update: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.spyOn(api, 'listDiagramTypes').mockResolvedValue({
      diagramTypes: [type('flowchart', 'Flowchart'), type('c4-container', 'C4 Container'), type('c4-component', 'C4 Component')],
    } as never);
    vi.spyOn(api, 'listAdminLibraries').mockResolvedValue({ libraries: [] } as never);
    update = vi.spyOn(api, 'updateStandard').mockImplementation(async (_id, body) => ({ standard: { ...draft(), rules: body as StandardRules } }) as never);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const open = (linkTo?: string[]) => render(<StandardsEditor diagramType={TYPE} standard={draft(linkTo)} onDone={vi.fn()} onCancel={vi.fn()} />);
  const savedKind = async () => {
    fireEvent.click(screen.getByTestId('standard-save'));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    return (update.mock.calls[0][1] as StandardRules).elementKinds![0];
  };

  it('offers one checkbox per diagram type, by name, and saves what is ticked', async () => {
    open();
    const box = (await screen.findByTestId('kind-link-to-0-c4-container')) as HTMLInputElement;
    expect(api.listDiagramTypes).toHaveBeenCalledWith(undefined, { includeHidden: true });
    const ids = Array.from(screen.getByTestId('kind-link-to-0').querySelectorAll('input')).map((i) => i.dataset.testid);
    expect(ids).toEqual(['kind-link-to-0-c4-component', 'kind-link-to-0-c4-container', 'kind-link-to-0-flowchart']);
    expect(box.checked).toBe(false);

    fireEvent.click(box);
    expect(box.checked).toBe(true);
    expect((await savedKind()).linkTo).toEqual(['c4-container']);
  });

  it('unticking removes the type; a kind with none saves without linkTo', async () => {
    open(['c4-container']);
    const box = (await screen.findByTestId('kind-link-to-0-c4-container')) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    const kind = await savedKind();
    expect('linkTo' in kind).toBe(false);
  });

  it('still shows a saved type that is no longer in the list, labelled by its id, and lets it be removed', async () => {
    open(['gone-type', 'c4-container']);
    const gone = (await screen.findByTestId('kind-link-to-0-gone-type')) as HTMLInputElement;
    expect(gone.checked).toBe(true);
    expect(screen.getByTestId('kind-link-to-0').textContent).toContain('gone-type');
    fireEvent.click(gone);
    expect((await savedKind()).linkTo).toEqual(['c4-container']);
  });
});

describe('linkTargetTypes', () => {
  it('maps only available targets that have a type', () => {
    const targets = new Map<string, LinkTarget>([
      ['a', { status: 'available', diagramTypeId: 'c4-container' }],
      ['b', { status: 'available' }],
      ['c', { status: 'deleted', diagramTypeId: 'flowchart' }],
      ['d', { status: 'checking', diagramTypeId: 'flowchart' }],
      ['e', { status: 'missing' }],
    ]);
    expect(linkTargetTypes(targets)).toEqual({ a: 'c4-container' });
    expect(linkTargetTypes(new Map())).toEqual({});
  });
});

describe('useLiveViolations with link targets', () => {
  const rules: StandardRules = {
    ...emptyStandardRules(),
    elementKinds: [{ id: 'system', label: 'System', shapes: [], approvedFills: [], linkTo: ['c4-container'] }],
  };
  function model(ref?: string): DiagramModel {
    const m = createEmptyDiagramModel('flowchart');
    m.nodes = [{ id: 'pay', label: 'Payments', shape: 'rectangle', role: 'system', position: { x: 0, y: 0 }, ...(ref ? { diagramRef: { diagramId: ref } } : {}) }];
    return m;
  }
  const kindLink = (m: DiagramModel, types?: Record<string, string>) =>
    renderHook(() => useLiveViolations(m, rules, types)).result.current?.filter((v) => v.rule === 'kind-link').map((v) => v.message);

  it('flags a missing link', () => {
    expect(kindLink(model())).toEqual(['System "Payments" should link to a diagram (c4-container).']);
  });
  it('flags a link whose known type differs', () => {
    expect(kindLink(model('d-1'), { 'd-1': 'flowchart' })).toEqual(['System "Payments" links to a flowchart diagram; it should link to c4-container.']);
  });
  it('accepts a matching type and does not judge an unknown one', () => {
    expect(kindLink(model('d-1'), { 'd-1': 'c4-container' })).toEqual([]);
    expect(kindLink(model('d-1'), {})).toEqual([]);
    expect(kindLink(model('d-1'))).toEqual([]);
  });
});
