import { useEffect, useState } from 'react';
import { api, ApiError, type ProjectDto, type ProjectTreeNodeDto } from '../app/api';
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
          <li key={diagram.id} className="row">
            <Icon name="diamond" />
            <span className="row__main">
              <span className="row__title">{diagram.name}</span>
            </span>
            <span className="row__actions">
              <button
                type="button"
                className="btn btn--tertiary btn--compact"
                data-testid={`open-diagram-${diagram.id}`}
                onClick={() => onOpenDiagram(diagram.id)}
              >
                Open
              </button>
              <button
                type="button"
                className="btn btn--tertiary btn--compact"
                data-testid={`move-diagram-${diagram.id}`}
                onClick={() => onRequestMove(diagram.id, diagram.name, node.id)}
              >
                Move
              </button>
              <button
                type="button"
                className="btn btn--tertiary-danger btn--compact"
                data-testid={`delete-diagram-${diagram.id}`}
                onClick={() => onRequestDelete(diagram.id, diagram.name)}
              >
                Delete
              </button>
            </span>
          </li>
        ))}
        {node.children.map((child) => (
          <TreeNode key={child.id} node={child} onOpenDiagram={onOpenDiagram} onRequestDelete={onRequestDelete} onRequestMove={onRequestMove} />
        ))}
      </ul>
    </li>
  );
}

/** Project/folder browser (FR-016): browse a nested project hierarchy, open, or delete a diagram. */
export function ProjectBrowser({ rootProjectId, projects, onOpenDiagram }: ProjectBrowserProps) {
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

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleteError(null);
    try {
      await api.deleteDiagram(pendingDelete.id);
      setPendingDelete(null);
      refresh();
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

  return (
    <div>
      <ul className="card" data-testid="project-browser">
        <TreeNode
          node={tree}
          onOpenDiagram={onOpenDiagram}
          onRequestDelete={(id, name) => setPendingDelete({ id, name })}
          onRequestMove={(id, name, projectId) => {
            setDestinationProjectId('');
            setMoveError(null);
            setMovingDiagram({ id, name, projectId });
          }}
        />
      </ul>
      {isEmpty && (
        <p className="state" data-testid="project-browser-empty">
          No diagrams yet — create one to get started.
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
