// canvas-g8i: "My projects" are filtered in the browser; "All projects" are searched on the server, a page at a time.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ProjectDto, type SessionUser } from '../../src/app/api';
import { ProjectsPage } from '../../src/projects/ProjectsPage';

const USER: SessionUser = { id: 'u-me', email: 'me@example.com', name: 'Me', role: 'architect' };

function project(id: string, name: string, extra: Partial<ProjectDto> = {}): ProjectDto {
  return {
    id,
    name,
    parentProjectId: null,
    createdAt: '2026-01-01T00:00:00Z',
    diagramCount: 0,
    ownerId: 'u-other',
    accessLevel: 'view',
    membership: null,
    ...extra,
  };
}

const MINE = [
  project('m1', 'Payments platform', { ownerId: USER.id, accessLevel: 'manage', membership: 'owner' }),
  project('m2', 'Billing', { ownerId: USER.id, accessLevel: 'manage', membership: 'owner' }),
];

function renderPage(projects: ProjectDto[] = MINE, sharedDiagrams: never[] = []) {
  return render(
    <ProjectsPage
      projects={projects}
      currentUser={USER}
      onCreated={vi.fn()}
      onRenamed={vi.fn()}
      onDeleted={vi.fn()}
      onViewDiagrams={vi.fn()}
      sharedDiagrams={sharedDiagrams}
      onOpenDiagram={vi.fn()}
      projectHref={(id) => `/?projectId=${id}`}
    />,
  );
}

function others(from: number, to: number): ProjectDto[] {
  return Array.from({ length: to - from }, (_, i) => project(`o${from + i}`, `Other ${from + i}`));
}

/** Lets the page's effect run (and any timer it set at 0 ms), then its answers settle. */
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('ProjectsPage server-side list', () => {
  let listProjects: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    listProjects = vi.spyOn(api, 'listProjects');
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fetches the others straight away (no debounce) with scope, no query, and a limit', async () => {
    listProjects.mockResolvedValue({ projects: others(0, 2), total: 2 });
    renderPage();
    await settle(0);
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(listProjects).toHaveBeenCalledWith({ scope: 'others', q: undefined, limit: 50 });
    expect(screen.getByTestId('projects-page-all-list').children).toHaveLength(2);
    expect(screen.queryByTestId('projects-page-all-more')).toBeNull();
  });

  it('filters my projects in the browser, and asks the server for the others only after the debounce', async () => {
    listProjects.mockResolvedValue({ projects: others(0, 1), total: 1 });
    renderPage();
    await settle(0);
    listProjects.mockClear();
    listProjects.mockResolvedValue({ projects: [project('o9', 'Pay others')], total: 1 });

    fireEvent.change(screen.getByTestId('projects-page-filter'), { target: { value: 'pay' } });
    // My list narrows at once, without a request.
    expect(screen.getByTestId('projects-page-list').children).toHaveLength(1);
    expect(screen.getByTestId('projects-page-name-m1')).toBeTruthy();
    expect(screen.queryByTestId('projects-page-name-m2')).toBeNull();
    await settle(299);
    expect(listProjects).not.toHaveBeenCalled();
    await settle(1);
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(listProjects).toHaveBeenCalledWith({ scope: 'others', q: 'pay', limit: 50 });
    expect(screen.getByTestId('projects-page-name-o9')).toBeTruthy();
  });

  it('sends one request for a burst of keystrokes', async () => {
    listProjects.mockResolvedValue({ projects: others(0, 1), total: 1 });
    renderPage();
    await settle(0);
    listProjects.mockClear();
    const filter = screen.getByTestId('projects-page-filter');
    fireEvent.change(filter, { target: { value: 'o' } });
    await settle(200);
    fireEvent.change(filter, { target: { value: 'ot' } });
    await settle(200);
    expect(listProjects).not.toHaveBeenCalled();
    await settle(100);
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(listProjects).toHaveBeenCalledWith({ scope: 'others', q: 'ot', limit: 50 });
  });

  it('Show more appends the next page with an offset, and goes away once all are shown', async () => {
    listProjects.mockResolvedValueOnce({ projects: others(0, 50), total: 60 });
    renderPage();
    await settle(0);
    expect(screen.getByTestId('projects-page-all-count').textContent).toBe('Showing 50 of 60');

    listProjects.mockResolvedValueOnce({ projects: others(50, 60), total: 60 });
    fireEvent.click(screen.getByTestId('projects-page-all-more'));
    await settle(0);
    expect(listProjects).toHaveBeenLastCalledWith({ scope: 'others', q: undefined, limit: 50, offset: 50 });
    expect(screen.getByTestId('projects-page-all-list').children).toHaveLength(60);
    expect(screen.queryByTestId('projects-page-all-more')).toBeNull();
  });

  it('shows the empty state only when the user has no projects and nobody else has any', async () => {
    listProjects.mockResolvedValue({ projects: [], total: 0 });
    renderPage([]);
    await settle(0);
    expect(screen.getByTestId('projects-page-empty')).toBeTruthy();
    expect(screen.queryByTestId('projects-page-filter')).toBeNull();
  });

  it('does not show the empty state for a user with no projects when others exist', async () => {
    listProjects.mockResolvedValue({ projects: others(0, 3), total: 3 });
    renderPage([]);
    await settle(0);
    expect(screen.queryByTestId('projects-page-empty')).toBeNull();
    expect(screen.getByTestId('projects-page-all-list').children).toHaveLength(3);
  });

  it('says nothing matches when the filter finds neither mine nor others', async () => {
    listProjects.mockResolvedValueOnce({ projects: others(0, 2), total: 2 });
    renderPage();
    await settle(0);
    listProjects.mockResolvedValue({ projects: [], total: 0 });
    fireEvent.change(screen.getByTestId('projects-page-filter'), { target: { value: 'zzz' } });
    // Mine are gone at once, but the server has not answered: no verdict yet.
    expect(screen.queryByTestId('projects-page-filter-empty')).toBeNull();
    await settle(300);
    expect(screen.getByTestId('projects-page-filter-empty')).toBeTruthy();
    expect(screen.queryByTestId('projects-page-list')).toBeNull();
    expect(screen.queryByTestId('projects-page-empty')).toBeNull();
  });

  it('does not say nothing matches when only the server has matches', async () => {
    listProjects.mockResolvedValueOnce({ projects: [], total: 0 });
    renderPage();
    await settle(0);
    listProjects.mockResolvedValue({ projects: [project('o1', 'Zzz found')], total: 1 });
    fireEvent.change(screen.getByTestId('projects-page-filter'), { target: { value: 'zzz' } });
    await settle(300);
    expect(screen.queryByTestId('projects-page-filter-empty')).toBeNull();
    expect(screen.getByTestId('projects-page-name-o1')).toBeTruthy();
  });

  it('fetches the others again after a rename', async () => {
    listProjects.mockResolvedValue({ projects: others(0, 1), total: 1 });
    vi.spyOn(api, 'renameProject').mockResolvedValue({ project: { ...MINE[1], name: 'Invoicing' } } as never);
    renderPage();
    await settle(0);
    expect(listProjects).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('projects-page-rename-m2'));
    const input = screen.getByTestId('projects-page-rename-input-m2');
    fireEvent.change(input, { target: { value: 'Invoicing' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle(0); // the rename answers and the list is marked stale
    await settle(0); // the refetch's 0 ms timer fires
    expect(api.renameProject).toHaveBeenCalledWith('m2', 'Invoicing');
    expect(listProjects).toHaveBeenCalledTimes(2);
  });
});
