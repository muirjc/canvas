import { useState } from 'react';
import { api, ApiError, type ProjectDto } from '../app/api';
import { Icon } from '../ui/Icon';

export interface ProjectsPageProps {
  projects: ProjectDto[];
  onCreated: (project: ProjectDto) => void;
  onClose: () => void;
}

/**
 * canvas-228.1: the only way to create a project used to be App.tsx's zero-projects onboarding
 * flow (createFirstProject) — once a user had one, there was no way to create another. This
 * screen generalizes that (same createProject API), and gives every project a permanent,
 * navigable home for the rename/delete actions canvas-228.2/canvas-228.3 add next.
 */
export function ProjectsPage({ projects, onCreated, onClose }: ProjectsPageProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

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
          {projects.map((project) => (
            <li key={project.id} className="row" data-testid={`projects-page-row-${project.id}`}>
              <Icon name="diamond" />
              <span className="row__main">
                <span className="row__title">{project.name}</span>
                <span className="meta" data-testid={`projects-page-diagram-count-${project.id}`}>
                  {project.diagramCount} diagram{project.diagramCount === 1 ? '' : 's'}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
