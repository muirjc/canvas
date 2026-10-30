import { useCallback, useEffect, useState } from 'react';
import { accessAtLeast, api, ApiError, type SubmissionBadgeDto, type DiagramSummaryDto, type DiagramTypeDto, type ProjectDto, type ProjectTreeNodeDto } from '../app/api';
import { ConfirmDialog } from '../canvas/ConfirmDialog';
import { Modal } from '../ui/Modal';
import { Icon } from '../ui/Icon';
import { deriveBadge } from '../app/submission-state';

export interface ProjectBrowserProps {
  rootProjectId: string;
  /** canvas-228.3: the destination choices for moving a diagram to a different project — every
   *  project the user has access to, passed down rather than fetched here so this component
   *  doesn't need its own copy of App.tsx's already-loaded project list. */
  projects: ProjectDto[];
  onOpenDiagram: (diagramId: string) => void;
}

interface DiagramActionsProps {
  diagramId: string;
  diagramName: string;
  /** canvas-t3b.3: the diagram type's name, shown beside the diagram's (design: project level). */
  typeName?: string;
  currentProjectId: string;
  /** canvas-3s5.2: the diagram's approval badge, when it has been submitted. */
  badge?: SubmissionBadgeDto;
  onOpenDiagram: (id: string) => void;
  onRequestDelete: (diagramId: string, diagramName: string) => void;
  onRequestMove: (diagramId: string, diagramName: string, currentProjectId: string) => void;
  /** canvas-2h2w.1: whether to offer Move/Delete -- everyone can open every diagram, few can change it. */
  canChange: boolean;
}

function SubmissionBadge({ badge }: { badge: SubmissionBadgeDto }) {
  const { kind, label } = deriveBadge(badge);
  const text = badge.prNumber ? `${label} · PR #${badge.prNumber}` : label;
  return (
    <span className={`badge diagram-badge diagram-badge--${kind}`} data-testid="submission-badge" data-state={kind} title={text}>
      {label}
    </span>
  );
}

/** One diagram row's Open/Move/Delete actions — shared by the recursive tree view and the flat
 *  search-results view (canvas-3vq.1) so the two can't drift apart on testids or behavior. */
function DiagramRow({ diagramId, diagramName, typeName, currentProjectId, badge, onOpenDiagram, onRequestDelete, onRequestMove, canChange }: DiagramActionsProps) {
  return (
    <li className="row">
      <Icon name="diamond" />
      <span className="row__main">
        <span className="row__title">{diagramName}</span>
        {typeName && <span className="meta">{typeName}</span>}
      </span>
      {badge && <SubmissionBadge badge={badge} />}
      <span className="row__actions">
        <button
          type="button"
          className="btn btn--tertiary btn--compact"
          data-testid={`open-diagram-${diagramId}`}
          aria-label={`Open diagram ${diagramName}`}
          onClick={() => onOpenDiagram(diagramId)}
        >
          Open
        </button>
        {canChange && (
        <>
        <button
          type="button"
          className="btn btn--tertiary btn--compact"
          data-testid={`move-diagram-${diagramId}`}
          aria-label={`Move diagram ${diagramName}`}
          onClick={() => onRequestMove(diagramId, diagramName, currentProjectId)}
        >
          <Icon name="arrow-right" size={12} />
          Move
        </button>
        <button
          type="button"
          className="btn btn--tertiary-danger btn--compact"
          data-testid={`delete-diagram-${diagramId}`}
          aria-label={`Delete diagram ${diagramName}`}
          onClick={() => onRequestDelete(diagramId, diagramName)}
        >
          <Icon name="trash" size={12} />
          Delete
        </button>
        </>
        )}
      </span>
    </li>
  );
}

interface TreeNodeProps {
  node: ProjectTreeNodeDto;
  /** canvas-t3b.6: the project the page is about -- its name is already the page's <h1>, so its
   *  own header row is left out (nested projects, should they ever exist, keep theirs). */
  isRoot?: boolean;
  typeNameOf: (diagramTypeId: string) => string | undefined;
  badges: Record<string, SubmissionBadgeDto>;
  onOpenDiagram: (id: string) => void;
  onRequestDelete: (diagramId: string, diagramName: string) => void;
  onRequestMove: (diagramId: string, diagramName: string, currentProjectId: string) => void;
  canChange: (projectId: string) => boolean;
}

function countDiagrams(node: ProjectTreeNodeDto): number {
  return node.diagrams.length + node.children.reduce((sum, child) => sum + countDiagrams(child), 0);
}

function TreeNode({ node, isRoot = false, typeNameOf, badges, onOpenDiagram, onRequestDelete, onRequestMove, canChange }: TreeNodeProps) {
  const total = countDiagrams(node);
  return (
    <li className="project-node">
      {!isRoot && (
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
      )}
      <ul className="project-node__list">
        {node.diagrams.map((diagram) => (
          <DiagramRow
            key={diagram.id}
            diagramId={diagram.id}
            diagramName={diagram.name}
            typeName={typeNameOf(diagram.diagramTypeId)}
            currentProjectId={node.id}
            badge={badges[diagram.id]}
            onOpenDiagram={onOpenDiagram}
            onRequestDelete={onRequestDelete}
            onRequestMove={onRequestMove}
            canChange={canChange(node.id)}
          />
        ))}
        {node.children.map((child) => (
          <TreeNode
            key={child.id}
            node={child}
            typeNameOf={typeNameOf}
            badges={badges}
            onOpenDiagram={onOpenDiagram}
            onRequestDelete={onRequestDelete}
            onRequestMove={onRequestMove}
            canChange={canChange}
          />
        ))}
      </ul>
    </li>
  );
}

/** Project/folder browser (FR-016): browse a nested project hierarchy, open, or delete a diagram. */
export function ProjectBrowser({ rootProjectId, projects, onOpenDiagram }: ProjectBrowserProps) {
  // canvas-2h2w.1: Move/Delete only where the user can edit (the API still decides).
  const canChange = (projectId: string) => accessAtLeast(projects.find((p) => p.id === projectId)?.accessLevel ?? 'edit', 'edit');
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

  // canvas-3s5.2: one request per project page load; empty (or a failure) means no badges at all.
  const [badges, setBadges] = useState<Record<string, SubmissionBadgeDto>>({});
  useEffect(() => {
    let cancelled = false;
    api
      .getSubmissionBadges(rootProjectId)
      .then(({ statuses }) => !cancelled && setBadges(statuses ?? {}))
      .catch(() => !cancelled && setBadges({}));
    return () => {
      cancelled = true;
    };
  }, [rootProjectId]);

  const isFiltering = query.trim() !== '' || typeFilter !== '';

  useEffect(() => {
    // canvas-9ff: includes hidden types -- existing diagrams of a hidden type still need its name.
    api.listDiagramTypes(undefined, { includeHidden: true }).then(({ diagramTypes }) => setDiagramTypes(diagramTypes)).catch(() => {});
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
  const typeNameOf = (diagramTypeId: string) => diagramTypes.find((type) => type.id === diagramTypeId)?.name;
  const requestDelete = (id: string, name: string) => setPendingDelete({ id, name });
  const requestMove = (id: string, name: string, projectId: string) => {
    setDestinationProjectId('');
    setMoveError(null);
    setMovingDiagram({ id, name, projectId });
  };

  return (
    <div>
      {/* canvas-t3b.3: the breadcrumb now sits above the project's <h1>, in App.tsx. */}
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
                  typeName={typeNameOf(diagram.diagramTypeId)}
                  currentProjectId={diagram.projectId}
                  badge={badges[diagram.id]}
                  onOpenDiagram={onOpenDiagram}
                  onRequestDelete={requestDelete}
                  onRequestMove={requestMove}
                  canChange={canChange(diagram.projectId)}
                />
              ))}
            </ul>
          )}
        </>
      ) : (
        isEmpty ? (
          <div className="card" data-testid="project-browser">
            <p className="state" data-testid="project-browser-empty">
              No diagrams yet — create one to get started.
            </p>
          </div>
        ) : (
          <ul className="card" data-testid="project-browser">
            <TreeNode
              node={tree}
              isRoot
              typeNameOf={typeNameOf}
              badges={badges}
              onOpenDiagram={onOpenDiagram}
              onRequestDelete={requestDelete}
              onRequestMove={requestMove}
              canChange={canChange}
            />
          </ul>
        )
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
