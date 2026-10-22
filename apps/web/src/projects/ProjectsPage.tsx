import { useState } from 'react';
import { api, ApiError, type ProjectDto, type SessionUser, type SharedDiagramDto } from '../app/api';
import { ConfirmDialog } from '../canvas/ConfirmDialog';
import { Icon } from '../ui/Icon';
import { SharedDiagramsList } from './SharedDiagramsList';

export interface ProjectsPageProps {
  projects: ProjectDto[];
  currentUser: SessionUser;
  onCreated: (project: ProjectDto) => void;
  onRenamed: (projectId: string, name: string) => void;
  onDeleted: (projectId: string) => void;
  /** Opens that project's diagrams (canvas-3vq.2; the drill-in of canvas-t3b.3's Browse screen). */
  onViewDiagrams: (projectId: string) => void;
  /** canvas-t3b.3: diagrams shared directly with the user, listed under the projects (design §6). */
  sharedDiagrams: SharedDiagramDto[];
  onOpenDiagram: (diagramId: string) => void;
  /** The address of a project's screen, so its name is a real link (open in a new tab, copy). */
  projectHref: (projectId: string) => string;
}

/**
 * The Browse top level (canvas-t3b.3, docs/browse-screen-design.md): every project the user can
 * see -- filter, create, rename, delete (canvas-228.1/.2/.3) -- each opening onto its diagrams, and
 * below them the diagrams shared directly with the user.
 */
export function ProjectsPage({
  projects,
  currentUser,
  onCreated,
  onRenamed,
  onDeleted,
  onViewDiagrams,
  sharedDiagrams,
  onOpenDiagram,
  projectHref,
}: ProjectsPageProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  // canvas-228.3: rename is owner-or-admin only (requireProjectOwnerOrAdmin on the server) — at
  // most one row is ever in rename mode, so a single id is enough rather than a Set.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  // canvas-228.2: same shape as ProjectBrowser's own pendingDelete/deleteError pair.
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // canvas-3vq.3: client-side filter over the already-fetched project list — GET /projects takes
  // no query params (project.service.ts's own comment: "no search or paging, the clarified scale
  // is tens of projects"), so no API round-trip is needed here. Server-side search (canvas-g8i) is
  // a separate, gated follow-up if real project counts ever justify it.
  const [filter, setFilter] = useState('');

  const handleCreate = async () => {
    setError(null);
    try {
      const { project } = await api.createProject({ name });
      setName('');
      setCreating(false);
      onCreated(project);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  /** Leaves rename mode and puts focus back on that row's Rename button (canvas-t3b.3). */
  const endRename = (projectId: string) => {
    setRenamingId(null);
    window.setTimeout(() => document.querySelector<HTMLElement>(`[data-testid="projects-page-rename-${projectId}"]`)?.focus(), 0);
  };

  const commitRename = async (projectId: string, newName: string, previousName: string) => {
    if (!newName.trim() || newName === previousName) {
      endRename(projectId);
      return;
    }
    setRenameError(null);
    try {
      const { project } = await api.renameProject(projectId, newName);
      onRenamed(projectId, project.name);
      endRename(projectId);
    } catch (err) {
      setRenameError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleteError(null);
    try {
      await api.deleteProject(pendingDelete.id);
      onDeleted(pendingDelete.id);
      setPendingDelete(null);
    } catch (err) {
      setPendingDelete(null);
      setDeleteError(err instanceof ApiError ? err.message : 'Failed to delete project.');
    }
  };

  const normalizedFilter = filter.trim().toLowerCase();
  const filteredProjects = normalizedFilter ? projects.filter((project) => project.name.toLowerCase().includes(normalizedFilter)) : projects;

  return (
    <main className="page stack">
      {/* Focused after an in-app navigation lands here (design: Accessibility and focus). */}
      <h1 className="page__title" tabIndex={-1} data-browse-heading>
        Projects
      </h1>

      {/* Toolbar: filter first, then New Project (design: top level, keyboard order). The create
          form opens in a card of its own. */}
      <div className="cluster browse-toolbar">
        {projects.length > 0 && (
          <input
            className="browse-toolbar__filter"
            data-testid="projects-page-filter"
            aria-label="Filter projects by name"
            placeholder="Filter projects…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        )}
        {!creating && (
          <button type="button" className="btn btn--primary" data-testid="projects-page-start-create" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            New Project
          </button>
        )}
      </div>
      {creating && (
        <section className="card">
          <div className="panel__body">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (name.trim()) void handleCreate();
              }}
            >
              <div className="field">
                <label className="field__label" htmlFor="projects-page-new-name">
                  Project name
                </label>
                <input
                  id="projects-page-new-name"
                  data-testid="projects-page-new-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div className="cluster">
                <button type="submit" className="btn btn--primary btn--compact" data-testid="projects-page-confirm-create">
                  Create Project
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--compact"
                  data-testid="projects-page-cancel-create"
                  onClick={() => {
                    setCreating(false);
                    setName('');
                    setError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </section>
      )}
      {error && (
        <p role="alert" data-testid="projects-page-error">
          {error}
        </p>
      )}

      {projects.length === 0 ? (
        // canvas-hmm: the zero-projects state lives here (App's separate "create first project"
        // form is gone; the toolbar's New Project creates it). Invite, never invent (feature 007
        // FR-014/015) -- but not for a user with diagrams shared with them, where "you have no
        // projects" would sit above a list proving they have work (feature 008 FR-003).
        sharedDiagrams.length > 0 ? null : (
          <section className="card empty-state" data-testid="projects-page-empty">
            <p>You don&rsquo;t have any projects yet. Create one with New Project to start drawing diagrams.</p>
          </section>
        )
      ) : (
        <>
          {filteredProjects.length === 0 ? (
            <p className="state" data-testid="projects-page-filter-empty">
              No projects match &ldquo;{filter}&rdquo;.
            </p>
          ) : (
            <ul className="card project-node__list stack" data-testid="projects-page-list">
              {filteredProjects.map((project) => {
                // requireProjectOwnerOrAdmin's exact rule, mirrored client-side purely to decide
                // whether to show the control — the server is what actually enforces it.
                const canManage = project.ownerId === currentUser.id || currentUser.role === 'admin';
                const isRenaming = renamingId === project.id;
                return (
                  <li key={project.id} className="row" data-testid={`projects-page-row-${project.id}`}>
                    <Icon name="diamond" />
                    <span className="row__main">
                      {isRenaming ? (
                        <input
                          data-testid={`projects-page-rename-input-${project.id}`}
                          autoFocus
                          defaultValue={project.name}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void commitRename(project.id, (event.target as HTMLInputElement).value, project.name);
                            if (event.key === 'Escape') endRename(project.id);
                          }}
                          onBlur={(event) => void commitRename(project.id, event.target.value, project.name)}
                        />
                      ) : (
                        // The name is a real link to the project as well as the Open button
                        // (design: names shouldn't read as dead text); a plain click stays in-app.
                        <a
                          className="row__title"
                          href={projectHref(project.id)}
                          data-testid={`projects-page-name-${project.id}`}
                          onClick={(event) => {
                            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                            event.preventDefault();
                            onViewDiagrams(project.id);
                          }}
                        >
                          {project.name}
                        </a>
                      )}
                      <span className="meta" data-testid={`projects-page-diagram-count-${project.id}`}>
                        {project.diagramCount} diagram{project.diagramCount === 1 ? '' : 's'}
                      </span>
                    </span>
                    {!isRenaming && (
                      <span className="row__actions">
                        <button
                          type="button"
                          className="btn btn--tertiary btn--compact"
                          data-testid={`projects-page-open-${project.id}`}
                          aria-label={`Open project ${project.name}`}
                          onClick={() => onViewDiagrams(project.id)}
                        >
                          Open
                        </button>
                        {canManage && (
                          <>
                            <button
                              type="button"
                              className="btn btn--tertiary btn--compact"
                              data-testid={`projects-page-rename-${project.id}`}
                              aria-label={`Rename project ${project.name}`}
                              onClick={() => setRenamingId(project.id)}
                            >
                              <Icon name="pencil" size={12} />
                              Rename
                            </button>
                            <button
                              type="button"
                              className="btn btn--tertiary-danger btn--compact"
                              data-testid={`projects-page-delete-${project.id}`}
                              aria-label={`Delete project ${project.name}`}
                              disabled={project.diagramCount > 0}
                              title={project.diagramCount > 0 ? 'Only a project with no diagrams can be deleted.' : undefined}
                              onClick={() => setPendingDelete({ id: project.id, name: project.name })}
                            >
                              <Icon name="trash" size={12} />
                              Delete
                            </button>
                          </>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>

      )}
      {sharedDiagrams.length > 0 && <SharedDiagramsList diagrams={sharedDiagrams} onOpenDiagram={onOpenDiagram} />}
      {renameError && (
        <p role="alert" data-testid="projects-page-rename-error">
          {renameError}
        </p>
      )}
      {pendingDelete && (
        <ConfirmDialog
          message={`Delete "${pendingDelete.name}"? It can be recovered by an admin for a limited time.`}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      {deleteError && (
        <p role="alert" data-testid="projects-page-delete-error">
          {deleteError}
        </p>
      )}
    </main>
  );
}
