import { useEffect, useState } from 'react';
import { api, type ProjectTreeNodeDto } from '../app/api';
import { ConfirmDialog } from '../canvas/ConfirmDialog';
import { Icon } from '../ui/Icon';

export interface ProjectBrowserProps {
  rootProjectId: string;
  onOpenDiagram: (diagramId: string) => void;
}

interface TreeNodeProps {
  node: ProjectTreeNodeDto;
  onOpenDiagram: (id: string) => void;
  onRequestDelete: (diagramId: string, diagramName: string) => void;
}

function countDiagrams(node: ProjectTreeNodeDto): number {
  return node.diagrams.length + node.children.reduce((sum, child) => sum + countDiagrams(child), 0);
}

function TreeNode({ node, onOpenDiagram, onRequestDelete }: TreeNodeProps) {
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
          <TreeNode key={child.id} node={child} onOpenDiagram={onOpenDiagram} onRequestDelete={onRequestDelete} />
        ))}
      </ul>
    </li>
  );
}

/** Project/folder browser (FR-016): browse a nested project hierarchy, open, or delete a diagram. */
export function ProjectBrowser({ rootProjectId, onOpenDiagram }: ProjectBrowserProps) {
  const [tree, setTree] = useState<ProjectTreeNodeDto | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

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
    await api.deleteDiagram(pendingDelete.id);
    setPendingDelete(null);
    refresh();
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
    </div>
  );
}
