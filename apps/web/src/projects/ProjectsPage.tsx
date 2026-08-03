import { useState } from 'react';
import { api, ApiError, type ProjectDto, type SessionUser } from '../app/api';
import { ConfirmDialog } from '../canvas/ConfirmDialog';
import { Icon } from '../ui/Icon';

export interface ProjectsPageProps {
  projects: ProjectDto[];
  currentUser: SessionUser;
  onCreated: (project: ProjectDto) => void;
  onRenamed: (projectId: string, name: string) => void;
  onDeleted: (projectId: string) => void;
  /** canvas-3vq.2: switches to that project and returns to the diagram browser — this screen
   *  used to be a dead end with no way to actually go look at a project's diagrams. */
  onViewDiagrams: (projectId: string) => void;
  onClose: () => void;
}

/**
 * canvas-228.1: the only way to create a project used to be App.tsx's zero-projects onboarding
 * flow (createFirstProject) — once a user had one, there was no way to create another. This
 * screen generalizes that (same createProject API), and gives every project a permanent,
 * navigable home for the rename and delete (canvas-228.3/canvas-228.2) actions.
 */
export function ProjectsPage({ projects, currentUser, onCreated, onRenamed, onDeleted, onViewDiagrams, onClose }: ProjectsPageProps) {
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

  const commitRename = async (projectId: string, newName: string, previousName: string) => {
    if (!newName.trim() || newName === previousName) {
      setRenamingId(null);
      return;
    }
    setRenameError(null);
    try {
      const { project } = await api.renameProject(projectId, newName);
      onRenamed(projectId, project.name);
      setRenamingId(null);
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

  return (
    <main className="page">
      <div className="cluster" style={{ justifyContent: 'space-between' }}>
        <h1 className="page__title">Projects</h1>
        <button type="button" className="btn btn--secondary btn--compact" data-testid="close-projects-page" onClick={onClose}>
          <Icon name="chevron-right" className="icon--flip" />
          Back
        </button>
      </div>

      <section className="card">
        <div className="panel__body">
          {creating ? (
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
          ) : (
            <button type="button" className="btn btn--primary" data-testid="projects-page-start-create" onClick={() => setCreating(true)}>
              <Icon name="plus" />
              New Project
            </button>
          )}
          {error && (
            <p role="alert" data-testid="projects-page-error">
              {error}
            </p>
          )}
        </div>
      </section>

      {projects.length === 0 ? (
        <p className="state" data-testid="projects-page-empty">
          No projects yet — create one to get started.
        </p>
      ) : (
        <ul className="card project-node__list stack" data-testid="projects-page-list">
          {projects.map((project) => {
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
                        if (event.key === 'Escape') setRenamingId(null);
                      }}
                      onBlur={(event) => void commitRename(project.id, event.target.value, project.name)}
                    />
                  ) : (
                    <span className="row__title">{project.name}</span>
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
                      data-testid={`projects-page-view-diagrams-${project.id}`}
                      onClick={() => onViewDiagrams(project.id)}
                    >
                      View Diagrams
                    </button>
                    {canManage && (
                      <>
                        <button
                          type="button"
                          className="btn btn--tertiary btn--compact"
                          data-testid={`projects-page-rename-${project.id}`}
                          onClick={() => setRenamingId(project.id)}
                        >
                          <Icon name="pencil" size={12} />
                          Rename
                        </button>
                        <button
                          type="button"
                          className="btn btn--tertiary-danger btn--compact"
                          data-testid={`projects-page-delete-${project.id}`}
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
