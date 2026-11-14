// canvas-g8i: the Move dialog reads every project when it opens and offers only those the user can edit.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ProjectDto } from '../../src/app/api';
import { ProjectBrowser } from '../../src/projects/ProjectBrowser';

function project(id: string, name: string, accessLevel: ProjectDto['accessLevel']): ProjectDto {
  return {
    id,
    name,
    parentProjectId: null,
    createdAt: '2026-01-01T00:00:00Z',
    diagramCount: 0,
    ownerId: 'u-other',
    accessLevel,
    membership: null,
  };
}

beforeAll(() => {
  // jsdom has no <dialog> methods.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

beforeEach(() => {
  vi.spyOn(api, 'getProjectTree').mockResolvedValue({
    tree: { id: 'home', name: 'Home', diagrams: [{ id: 'd1', name: 'Flow', diagramTypeId: 'flowchart' }], children: [] },
  });
  vi.spyOn(api, 'listDiagramTypes').mockResolvedValue({ diagramTypes: [] } as never);
  vi.spyOn(api, 'getSubmissionBadges').mockResolvedValue({ statuses: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ProjectBrowser Move dialog', () => {
  it('lists every project you can edit, and not the current one or read-only ones', async () => {
    const listProjects = vi.spyOn(api, 'listProjects').mockResolvedValue({
      projects: [
        project('home', 'Home', 'manage'),
        project('p-manage', 'Manageable', 'manage'),
        project('p-edit', 'Editable', 'edit'),
        project('p-comment', 'Commentable', 'comment'),
        project('p-view', 'Viewable', 'view'),
      ],
    });
    render(<ProjectBrowser rootProjectId="home" projects={[project('home', 'Home', 'manage')]} onOpenDiagram={vi.fn()} />);

    expect(listProjects).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('move-diagram-d1'));
    expect(listProjects).toHaveBeenCalledWith();

    const select = await screen.findByTestId('move-diagram-destination');
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(1));
    const names = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(names).toEqual(['Select a project…', 'Manageable', 'Editable']);
  });
});
