import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type DiagramSummaryDto, type DiagramTypeDto, type ProjectDto } from '../../src/app/api';
import { LinkPickerDialog } from '../../src/links/LinkPickerDialog';

/** canvas-8uh1.3: the dialog that chooses (or makes) the diagram an element opens. */

const type = (id: string, name: string): DiagramTypeDto =>
  ({ id, name, personas: [], abstractionLevel: '', dslFamily: 'c4', defaultPaletteLibraryIds: [], origin: 'builtin', description: null }) as DiagramTypeDto;
const TYPES = [type('c4-code', 'C4 Code'), type('c4-component', 'C4 Component'), type('c4-container', 'C4 Container'), type('c4-context', 'C4 Context')];
const project = (id: string, name: string, accessLevel: ProjectDto['accessLevel']): ProjectDto => ({
  id, name, parentProjectId: null, createdAt: '', diagramCount: 0, ownerId: 'u', accessLevel,
});
const summary = (id: string, name: string, diagramTypeId = 'c4-container'): DiagramSummaryDto => ({ id, name, diagramTypeId, projectId: 'p1', updatedAt: '' });

function mockApi(projects: ProjectDto[] = [project('p1', 'Shop', 'edit')], diagrams: DiagramSummaryDto[] = [summary('self', 'Context'), summary('other', 'Payments containers')]) {
  vi.spyOn(api, 'listProjects').mockResolvedValue({ projects });
  vi.spyOn(api, 'listDiagramTypes').mockResolvedValue({ diagramTypes: TYPES });
  return vi.spyOn(api, 'searchProjectDiagrams').mockResolvedValue({ diagrams });
}

function renderPicker(over: Partial<React.ComponentProps<typeof LinkPickerDialog>> = {}) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(
    <LinkPickerDialog diagramId="self" diagramTypeId="c4-context" projectId="p1" elementLabel="Payments" onPick={onPick} onClose={onClose} {...over} />,
  );
  return { onPick, onClose };
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal ||= function () {};
  HTMLDialogElement.prototype.close ||= function () {};
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LinkPickerDialog', () => {
  it('preselects the type one level down and searches for it in this project', async () => {
    const search = mockApi();
    renderPicker();
    await screen.findByTestId('link-picker-result-other');
    expect((screen.getByTestId('link-picker-type') as HTMLSelectElement).value).toBe('c4-container');
    expect((screen.getByTestId('link-picker-new-type') as HTMLSelectElement).value).toBe('c4-container');
    expect(search).toHaveBeenCalledWith('p1', { query: undefined, type: 'c4-container' });
    // Suggested types are marked and come first.
    const options = Array.from((screen.getByTestId('link-picker-type') as HTMLSelectElement).options).map((o) => o.text);
    expect(options).toEqual(['Any type', 'C4 Container (suggested)', 'C4 Code', 'C4 Component', 'C4 Context']);
  });

  it('has no suggestion for a type with none (any type, new one of the same type)', async () => {
    const search = mockApi();
    renderPicker({ diagramTypeId: 'c4-code' });
    await screen.findByTestId('link-picker-result-other');
    expect((screen.getByTestId('link-picker-type') as HTMLSelectElement).value).toBe('');
    expect((screen.getByTestId('link-picker-new-type') as HTMLSelectElement).value).toBe('c4-code');
    expect(search).toHaveBeenCalledWith('p1', { query: undefined, type: undefined });
  });

  it('leaves the diagram being edited out of the results', async () => {
    mockApi();
    renderPicker();
    await screen.findByTestId('link-picker-result-other');
    expect(screen.queryByTestId('link-picker-result-self')).toBeNull();
  });

  it('shows an empty message when nothing matches', async () => {
    mockApi(undefined, []);
    renderPicker();
    expect(await screen.findByTestId('link-picker-empty')).toBeTruthy();
  });

  it('picking a result calls onPick with the diagram and what it is', async () => {
    mockApi();
    const { onPick } = renderPicker();
    fireEvent.click(await screen.findByTestId('link-picker-result-other'));
    expect(onPick).toHaveBeenCalledWith('other', {
      status: 'available', name: 'Payments containers', diagramTypeId: 'c4-container', projectId: 'p1', projectName: 'Shop',
    });
  });

  it('marks the diagram linked now', async () => {
    mockApi();
    renderPicker({ currentTargetId: 'other' });
    const row = await screen.findByTestId('link-picker-result-other');
    expect(row.textContent).toContain('Linked now');
    expect(row.getAttribute('aria-current')).toBe('true');
  });

  it('searches again for a typed name', async () => {
    const search = mockApi();
    renderPicker();
    await screen.findByTestId('link-picker-result-other');
    fireEvent.change(screen.getByTestId('link-picker-search'), { target: { value: ' pay ' } });
    await waitFor(() => expect(search).toHaveBeenCalledWith('p1', { query: 'pay', type: 'c4-container' }));
  });

  it('Create and link makes a diagram in this project, then picks it', async () => {
    mockApi();
    const create = vi.spyOn(api, 'createDiagram').mockResolvedValue({
      diagram: { id: 'new1', name: 'Payments', diagramTypeId: 'c4-container', projectId: 'p1' },
    } as never);
    const { onPick } = renderPicker();
    await screen.findByTestId('link-picker-result-other');
    expect((screen.getByTestId('link-picker-new-name') as HTMLInputElement).value).toBe('Payments');
    fireEvent.click(screen.getByTestId('link-picker-create'));
    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith('p1', { name: 'Payments', diagramTypeId: 'c4-container' });
    expect(onPick.mock.calls[0][0]).toBe('new1');
    expect(onPick.mock.calls[0][1]).toMatchObject({ status: 'available', name: 'Payments' });
  });

  it('does not create with an empty name', async () => {
    mockApi();
    renderPicker();
    await screen.findByTestId('link-picker-result-other');
    fireEvent.change(screen.getByTestId('link-picker-new-name'), { target: { value: '  ' } });
    expect((screen.getByTestId('link-picker-create') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows an API error from creating and lets the user try again', async () => {
    mockApi();
    vi.spyOn(api, 'createDiagram').mockRejectedValue(new ApiError('You cannot add diagrams here', 403));
    const { onPick } = renderPicker();
    await screen.findByTestId('link-picker-result-other');
    fireEvent.click(screen.getByTestId('link-picker-create'));
    expect((await screen.findByTestId('link-picker-error')).textContent).toContain('You cannot add diagrams here');
    expect(onPick).not.toHaveBeenCalled();
    expect((screen.getByTestId('link-picker-create') as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers no new diagram without edit access on the project, but still lets you pick', async () => {
    mockApi([project('p1', 'Shop', 'view')]);
    renderPicker();
    await screen.findByTestId('link-picker-result-other');
    expect(screen.queryByTestId('link-picker-create')).toBeNull();
    expect(screen.queryByTestId('link-picker-new-name')).toBeNull();
  });

  it('Cancel closes', async () => {
    mockApi();
    const { onClose } = renderPicker();
    fireEvent.click(screen.getByTestId('link-picker-cancel'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('LinkPickerDialog in frame mode', () => {
  it('says it embeds, not links', async () => {
    mockApi();
    renderPicker({ mode: 'frame' });
    await screen.findByTestId('link-picker-result-other');
    expect(document.querySelector('dialog')!.textContent).toContain('Embed a diagram');
    expect(document.querySelector('dialog')!.textContent).toContain('Choose a diagram to draw in a frame on this one');
    expect(document.querySelector('dialog')!.textContent).not.toContain('opens from');
    expect(screen.getByTestId('link-picker-create').textContent).toBe('Create and embed');
  });

  it('keeps the link wording by default', async () => {
    mockApi();
    renderPicker();
    await screen.findByTestId('link-picker-result-other');
    expect(screen.getByTestId('link-picker-create').textContent).toBe('Create and link');
    expect(document.querySelector('dialog')!.textContent).not.toContain('Embed a diagram');
  });

  it('picking a result still calls onPick', async () => {
    mockApi();
    const { onPick } = renderPicker({ mode: 'frame' });
    fireEvent.click(await screen.findByTestId('link-picker-result-other'));
    expect(onPick).toHaveBeenCalledWith('other', expect.objectContaining({ status: 'available', name: 'Payments containers' }));
  });
});
