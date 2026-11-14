import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type ProjectDto,
  type SessionUser,
  type SharedDiagramDto,
} from '../app/api';
import { ConfirmDialog } from '../canvas/ConfirmDialog';
import { Icon } from '../ui/Icon';
import { RecentDiagrams } from './RecentDiagrams';
import { SharedDiagramsList } from './SharedDiagramsList';

export interface ProjectsPageProps {
  /** The user's own projects (owned or a member of); everyone else's are searched on the server (canvas-g8i). */
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
  /** canvas-93n: a diagram's address, for the "Recently opened" links. */
  diagramHref?: (diagramId: string) => string;
}

/** canvas-g8i: "All projects" loads this many at a time, and searches this long after the last keystroke. */
const OTHERS_PAGE = 50;
const SEARCH_DELAY_MS = 300;

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
  diagramHref,
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
  // canvas-3vq.3: the filter narrows the user's own projects in the browser; canvas-g8i: "All projects" (everyone
  // else's, possibly thousands) is searched on the server as you type, a page at a time.
  const [filter, setFilter] = useState('');
  const [others, setOthers] = useState<{
    projects: ProjectDto[];
    total: number;
    query: string;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [othersError, setOthersError] = useState<string | null>(null);
  // Bumped after a rename or delete, so the server list shows it.
  const [othersVersion, setOthersVersion] = useState(0);
  const othersQuery = filter.trim();

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(
      () => {
        api
          .listProjects({ scope: 'others', q: othersQuery || undefined, limit: OTHERS_PAGE })
          .then(({ projects: page, total }) => {
            if (cancelled) return;
            setOthers({ projects: page, total: total ?? page.length, query: othersQuery });
            setOthersError(null);
          })
          .catch((err) => {
            if (!cancelled)
              setOthersError(
                err instanceof ApiError ? err.message : 'Couldn\u2019t load the other projects.',
              );
          });
      },
      othersQuery ? SEARCH_DELAY_MS : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [othersQuery, othersVersion]);

  const showMoreOthers = async () => {
    if (!others) return;
    setLoadingMore(true);
    try {
      const { projects: page, total } = await api.listProjects({
        scope: 'others',
        q: others.query || undefined,
        limit: OTHERS_PAGE,
        offset: others.projects.length,
      });
      setOthers((current) =>
        current && current.query === others.query
          ? { ...current, projects: [...current.projects, ...page], total: total ?? current.total }
          : current,
      );
    } catch (err) {
      setOthersError(err instanceof ApiError ? err.message : 'Couldn\u2019t load more projects.');
    } finally {
      setLoadingMore(false);
    }
  };

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
    window.setTimeout(
      () =>
        document
          .querySelector<HTMLElement>(`[data-testid="projects-page-rename-${projectId}"]`)
          ?.focus(),
      0,
    );
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
      setOthersVersion((v) => v + 1);
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
      setOthersVersion((v) => v + 1);
      setPendingDelete(null);
    } catch (err) {
      setPendingDelete(null);
      setDeleteError(err instanceof ApiError ? err.message : 'Failed to delete project.');
    }
  };

  const normalizedFilter = filter.trim().toLowerCase();
  // canvas-2h2w.1: every project is readable, so the list splits into the ones the user owns or is a
  // member of (here, filtered in the browser), and everything else (open read-only; from the server).
  const myProjects = normalizedFilter
    ? projects.filter((project) => project.name.toLowerCase().includes(normalizedFilter))
    : projects;
  const otherProjects = others?.projects ?? [];
  const othersSettled = others !== null && others.query === othersQuery;
  // Nothing at all to list: no project of the user's own and none of anyone else's (before any filter).
  const noProjects =
    projects.length === 0 && others !== null && others.query === '' && others.total === 0;
  const nothingMatches =
    normalizedFilter !== '' && myProjects.length === 0 && othersSettled && others.total === 0;

  const renderList = (list: ProjectDto[], testId: string) => (
    <ul className="card project-node__list stack" data-testid={testId}>
      {list.map((project) => {
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
                    if (event.key === 'Enter')
                      void commitRename(
                        project.id,
                        (event.target as HTMLInputElement).value,
                        project.name,
                      );
                    if (event.key === 'Escape') endRename(project.id);
                  }}
                  onBlur={(event) =>
                    void commitRename(project.id, event.target.value, project.name)
                  }
                />
              ) : (
                // The name is a real link to the project as well as the Open button
                // (design: names shouldn't read as dead text); a plain click stays in-app.
                <a
                  className="row__title"
                  href={projectHref(project.id)}
                  data-testid={`projects-page-name-${project.id}`}
                  onClick={(event) => {
                    if (
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return;
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
                      title={
                        project.diagramCount > 0
                          ? 'Only a project with no diagrams can be deleted.'
                          : undefined
                      }
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
  );

  return (
    <main className="page stack">
      {/* Focused after an in-app navigation lands here (design: Accessibility and focus). */}
      <h1 className="page__title" tabIndex={-1} data-browse-heading>
        Projects
      </h1>

      {/* Toolbar: filter first, then New Project (design: top level, keyboard order). The create
          form opens in a card of its own. */}
      <div className="cluster browse-toolbar">
        {!noProjects && (
          <input
            className="browse-toolbar__filter"
            data-testid="projects-page-filter"
            aria-label="Filter projects by name"
            placeholder="Filter projects…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        )}
        {/* canvas-2h2w.1: viewers are capped at Comment, so creating projects is for architects and admins. */}
        {!creating && currentUser.role !== 'viewer' && (
          <button
            type="button"
            className="btn btn--primary"
            data-testid="projects-page-start-create"
            onClick={() => setCreating(true)}
          >
            <Icon name="plus" />
            New Project
          </button>
        )}
      </div>
      {diagramHref && (
        <RecentDiagrams
          userId={currentUser.id}
          onOpenDiagram={onOpenDiagram}
          diagramHref={diagramHref}
        />
      )}
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
                <button
                  type="submit"
                  className="btn btn--primary btn--compact"
                  data-testid="projects-page-confirm-create"
                >
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

      {noProjects ? (
        // canvas-hmm: the zero-projects state lives here (App's separate "create first project"
        // form is gone; the toolbar's New Project creates it). Invite, never invent (feature 007
        // FR-014/015) -- but not for a user with diagrams shared with them, where "you have no
        // projects" would sit above a list proving they have work (feature 008 FR-003).
        sharedDiagrams.length > 0 ? null : (
          <section className="card empty-state" data-testid="projects-page-empty">
            <p>
              You don&rsquo;t have any projects yet. Create one with New Project to start drawing
              diagrams.
            </p>
          </section>
        )
      ) : (
        <>
          {nothingMatches ? (
            <>
              <p className="state" data-testid="projects-page-filter-empty">
                No projects match &ldquo;{filter}&rdquo;.
              </p>
              {sharedDiagrams.length > 0 && (
                <SharedDiagramsList diagrams={sharedDiagrams} onOpenDiagram={onOpenDiagram} />
              )}
            </>
          ) : (
            <>
              {myProjects.length > 0 && (
                <section className="stack" aria-labelledby="projects-page-mine-heading">
                  <h2 className="section-label" id="projects-page-mine-heading">
                    My projects
                  </h2>
                  {renderList(myProjects, 'projects-page-list')}
                </section>
              )}
              {/* Your own work first: shared-with-you sits between your projects and everyone else's. */}
              {sharedDiagrams.length > 0 && (
                <SharedDiagramsList diagrams={sharedDiagrams} onOpenDiagram={onOpenDiagram} />
              )}
              {otherProjects.length > 0 && (
                <section
                  className="stack"
                  aria-labelledby="projects-page-all-heading"
                  aria-busy={!othersSettled}
                >
                  <h2 className="section-label" id="projects-page-all-heading">
                    All projects
                  </h2>
                  <p className="meta">
                    Everyone can read these. Ask the owner to add you to change them.
                  </p>
                  {renderList(otherProjects, 'projects-page-all-list')}
                  {others && others.total > otherProjects.length && (
                    <div className="cluster">
                      <button
                        type="button"
                        className="btn btn--secondary btn--compact"
                        data-testid="projects-page-all-more"
                        disabled={loadingMore}
                        onClick={() => void showMoreOthers()}
                      >
                        {loadingMore ? 'Loading…' : 'Show more'}
                      </button>
                      <span className="meta" data-testid="projects-page-all-count" role="status">
                        Showing {otherProjects.length} of {others.total}
                      </span>
                    </div>
                  )}
                </section>
              )}
              {othersError && (
                <p
                  role="alert"
                  className="state state--error"
                  data-testid="projects-page-all-error"
                >
                  {othersError}
                </p>
              )}
            </>
          )}
        </>
      )}
      {noProjects && sharedDiagrams.length > 0 && (
        <SharedDiagramsList diagrams={sharedDiagrams} onOpenDiagram={onOpenDiagram} />
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
