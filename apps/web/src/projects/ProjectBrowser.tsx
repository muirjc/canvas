import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type DiagramSummaryDto, type DiagramTypeDto, type ProjectDto, type ProjectTreeNodeDto } from '../app/api';
import { ConfirmDialog } from '../canvas/ConfirmDialog';
import { Modal } from '../ui/Modal';
import { Icon } from '../ui/Icon';

export interface ProjectBrowserProps {
  rootProjectId: string;
  /** canvas-228.3: the destination choices for moving a diagram to a different project — every
   *  project the user has access to, passed down rather than fetched here so this component
   *  doesn't need its own copy of App.tsx's already-loaded project list. */
  projects: ProjectDto[];
  onOpenDiagram: (diagramId: string) => void;
  /** canvas-3vq.2: the breadcrumb's link back to the Projects screen — reuses App.tsx's existing
   *  requestViewProjects, same unsaved-changes guard as the header's own "Projects" button. */
  onBackToProjects: () => void;
}

interface DiagramActionsProps {
  diagramId: string;
  diagramName: string;
  currentProjectId: string;
  onOpenDiagram: (id: string) => void;
  onRequestDelete: (diagramId: string, diagramName: string) => void;
  onRequestMove: (diagramId: string, diagramName: string, currentProjectId: string) => void;
}

/** One diagram row's Open/Move/Delete actions — shared by the recursive tree view and the flat
 *  search-results view (canvas-3vq.1) so the two can't drift apart on testids or behavior. */
function DiagramRow({ diagramId, diagramName, currentProjectId, onOpenDiagram, onRequestDelete, onRequestMove }: DiagramActionsProps) {
  return (
    <li className="row">
      <Icon name="diamond" />
      <span className="row__main">
        <span className="row__title">{diagramName}</span>
      </span>
      <span className="row__actions">
        <button
          type="button"
          className="btn btn--tertiary btn--compact"
          data-testid={`open-diagram-${diagramId}`}
          onClick={() => onOpenDiagram(diagramId)}
        >
          Open
        </button>
        <button
          type="button"
          className="btn btn--tertiary btn--compact"
          data-testid={`move-diagram-${diagramId}`}
          onClick={() => onRequestMove(diagramId, diagramName, currentProjectId)}
        >
          Move
        </button>
        <button
          type="button"
          className="btn btn--tertiary-danger btn--compact"
          data-testid={`delete-diagram-${diagramId}`}
          onClick={() => onRequestDelete(diagramId, diagramName)}
        >
          Delete
        </button>
      </span>
    </li>
  );
}

interface TreeNodeProps {
  node: ProjectTreeNodeDto;
  onOpenDiagram: (id: string) => void;
  onRequestDelete: (diagramId: string, diagramName: string) => void;
  onRequestMove: (diagramId: string, diagramName: string, currentProjectId: string) => void;
}

function countDiagrams(node: ProjectTreeNodeDto): number {
  return node.diagrams.length + node.children.reduce((sum, child) => sum + countDiagrams(child), 0);
}

function TreeNode({ node, onOpenDiagram, onRequestDelete, onRequestMove }: TreeNodeProps) {
  const total = countDiagrams(node);
  return (
    <li className="project-node">
      <div className="project-node__header">
        <Icon name="chevron-down" />
        <strong className="row__title" data-testid={`project-node-${node.id}`}>
          {node.name}
        </strong>
        <span className="spacer" />
        <span className="meta">
          {total} diagram{total === 1 ? '' : 's'}
        </span>
      </div>
      <ul className="project-node__list">
        {node.diagrams.map((diagram) => (
          <DiagramRow
            key={diagram.id}
            diagramId={diagram.id}
            diagramName={diagram.name}
            currentProjectId={node.id}
            onOpenDiagram={onOpenDiagram}
            onRequestDelete={onRequestDelete}
            onRequestMove={onRequestMove}
          />
        ))}
        {node.children.map((child) => (
          <TreeNode key={child.id} node={child} onOpenDiagram={onOpenDiagram} onRequestDelete={onRequestDelete} onRequestMove={onRequestMove} />
        ))}
      </ul>
    </li>
  );
}

/** Project/folder browser (FR-016): browse a nested project hierarchy, open, or delete a diagram. */
export function ProjectBrowser({ rootProjectId, projects, onOpenDiagram, onBackToProjects }: ProjectBrowserProps) {
  const [tree, setTree] = useState<ProjectTreeNodeDto | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  // canvas-40t: deleteDiagram requires being the diagram's owner or an admin (DELETE
  // /diagrams/:id) — a user with only edit access (project membership or a share grant) gets a
  // 403. Without this, that rejection had nowhere to go: confirmDelete's un-caught throw left
  // pendingDelete set and refresh() never called, so the confirm dialog just sat there forever
  // with no error, indistinguishable from a hang.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // canvas-228.3: the diagram being moved, its current project (excluded from the destination
  // choices), and the chosen destination — a separate small piece of state per dialog field
  // rather than one combined object, since the destination resets each time a new move starts.
  const [movingDiagram, setMovingDiagram] = useState<{ id: string; name: string; projectId: string } | null>(null);
  const [destinationProjectId, setDestinationProjectId] = useState('');
  const [moveError, setMoveError] = useState<string | null>(null);
  // canvas-3vq.1: search/type-filter over this project's direct diagrams, via the pre-existing
  // GET /projects/:projectId/diagrams?query=&type= endpoint (perf-tested at 1,200 diagrams) that
  // had no frontend caller until now. Not recursive into child projects — same limitation
  // `searchDiagrams` already has server-side; harmless today since this app has no UI to create
  // nested projects, so every tree is in practice one level deep.
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [diagramTypes, setDiagramTypes] = useState<DiagramTypeDto[]>([]);
  const [searchResults, setSearchResults] = useState<DiagramSummaryDto[]>([]);
  const [searchStatus, setSearchStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  const isFiltering = query.trim() !== '' || typeFilter !== '';

  useEffect(() => {
    api.listDiagramTypes().then(({ diagramTypes }) => setDiagramTypes(diagramTypes)).catch(() => {});
  }, []);

  const refresh = () => {
    setStatus('loading');
    api
      .getProjectTree(rootProjectId)
      .then(({ tree }) => {
        setTree(tree);
        setStatus('ready');
      })
      .catch(() => setStatus('error'));
  };

  useEffect(refresh, [rootProjectId]);

  const runSearch = useCallback(() => {
    if (!isFiltering) {
      setSearchStatus('idle');
      return;
    }
    setSearchStatus('loading');
    api
      .searchProjectDiagrams(rootProjectId, { query: query.trim() || undefined, type: typeFilter || undefined })
      .then(({ diagrams }) => {
        setSearchResults(diagrams);
        setSearchStatus('ready');
      })
      .catch(() => setSearchStatus('error'));
  }, [rootProjectId, query, typeFilter, isFiltering]);

  useEffect(runSearch, [runSearch]);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleteError(null);
    try {
      await api.deleteDiagram(pendingDelete.id);
      setPendingDelete(null);
      refresh();
      runSearch();
    } catch (err) {
      setPendingDelete(null);
      setDeleteError(err instanceof ApiError ? err.message : 'Failed to delete diagram.');
    }
  };

  const confirmMove = async () => {
    if (!movingDiagram || !destinationProjectId) return;
    setMoveError(null);
    try {
      await api.moveDiagram(movingDiagram.id, destinationProjectId);
      setMovingDiagram(null);
      setDestinationProjectId('');
      refresh();
      runSearch();
    } catch (err) {
      setMoveError(err instanceof ApiError ? err.message : 'Failed to move diagram.');
    }
  };

  if (status === 'loading') {
    return (
      <div className="card" data-testid="project-browser-loading" aria-busy="true">
        <div style={{ padding: 'var(--space-4)' }}>
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
        </div>
      </div>
    );
  }

  if (status === 'error' || !tree) {
    return (
      <div className="card">
        <p className="state state--error" data-testid="project-browser-error">
          <Icon name="warning" className="state__icon" />
          Could not load projects.
          <button type="button" className="btn btn--tertiary btn--compact" onClick={refresh}>
            Retry
          </button>
        </p>
      </div>
    );
  }

  const isEmpty = countDiagrams(tree) === 0;
  const requestDelete = (id: string, name: string) => setPendingDelete({ id, name });
  const requestMove = (id: string, name: string, projectId: string) => {
    setDestinationProjectId('');
    setMoveError(null);
    setMovingDiagram({ id, name, projectId });
  };

  return (
    <div>
      <nav className="project-browser__breadcrumb" data-testid="project-browser-breadcrumb" aria-label="Breadcrumb">
        <button
          type="button"
          className="btn btn--tertiary btn--compact"
          data-testid="project-browser-breadcrumb-back"
          onClick={onBackToProjects}
        >
          <Icon name="chevron-right" className="icon--flip" />
          Projects
        </button>
        <Icon name="chevron-right" size={12} />
        <span data-testid="project-browser-breadcrumb-current">{tree.name}</span>
      </nav>

      <div className="cluster project-browser__filters">
        <input
          data-testid="project-browser-search"
          aria-label="Search diagrams by name"
          placeholder="Search diagrams…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          data-testid="project-browser-type-filter"
          aria-label="Filter by diagram type"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
        >
          <option value="">All types</option>
          {diagramTypes.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
      </div>

      {isFiltering ? (
        <>
          {searchStatus === 'loading' && (
            <div className="card" data-testid="project-browser-search-loading" aria-busy="true">
              <div style={{ padding: 'var(--space-4)' }}>
                <div className="skeleton skeleton--row" />
                <div className="skeleton skeleton--row" />
              </div>
            </div>
          )}
          {searchStatus === 'error' && (
            <p className="state state--error" data-testid="project-browser-search-error">
              <Icon name="warning" className="state__icon" />
              Could not search diagrams.
              <button type="button" className="btn btn--tertiary btn--compact" onClick={runSearch}>
                Retry
              </button>
            </p>
          )}
          {searchStatus === 'ready' && searchResults.length === 0 && (
            <p className="state" data-testid="project-browser-search-empty">
              No diagrams match your search.
            </p>
          )}
          {searchStatus === 'ready' && searchResults.length > 0 && (
            <ul className="card project-node__list" data-testid="project-browser-search-results">
              {searchResults.map((diagram) => (
                <DiagramRow
                  key={diagram.id}
                  diagramId={diagram.id}
                  diagramName={diagram.name}
                  currentProjectId={diagram.projectId}
                  onOpenDiagram={onOpenDiagram}
                  onRequestDelete={requestDelete}
                  onRequestMove={requestMove}
                />
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <ul className="card" data-testid="project-browser">
            <TreeNode node={tree} onOpenDiagram={onOpenDiagram} onRequestDelete={requestDelete} onRequestMove={requestMove} />
          </ul>
          {isEmpty && (
            <p className="state" data-testid="project-browser-empty">
              No diagrams yet — create one to get started.
            </p>
          )}
        </>
      )}
      {pendingDelete && (
        <ConfirmDialog
          message={`Delete "${pendingDelete.name}"? It can be recovered by an admin for a limited time.`}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      {deleteError && (
        <p role="alert" data-testid="delete-diagram-error">
          {deleteError}
        </p>
      )}
      {movingDiagram && (
        <Modal
          label="Move diagram"
          testId="move-diagram-dialog"
          onClose={() => setMovingDiagram(null)}
          footer={
            <>
              <button
                type="button"
                className="btn btn--secondary"
                data-testid="cancel-move-diagram"
                onClick={() => setMovingDiagram(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                data-testid="confirm-move-diagram"
                disabled={!destinationProjectId}
                onClick={confirmMove}
              >
                Move
              </button>
            </>
          }
        >
          <div className="field">
            <label className="field__label" htmlFor="move-diagram-destination">
              Move &ldquo;{movingDiagram.name}&rdquo; to
            </label>
            <select
              id="move-diagram-destination"
              data-testid="move-diagram-destination"
              value={destinationProjectId}
              onChange={(event) => setDestinationProjectId(event.target.value)}
            >
              <option value="" disabled>
                Select a project…
              </option>
              {projects
                .filter((project) => project.id !== movingDiagram.projectId)
                .map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
            </select>
          </div>
          {moveError && (
            <p role="alert" data-testid="move-diagram-error">
              {moveError}
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
