import { useEffect, useState } from 'react';
import { api, type ProjectTreeNodeDto } from '../app/api';
import { ConfirmDialog } from '../canvas/ConfirmDialog';

export interface ProjectBrowserProps {
  rootProjectId: string;
  onOpenDiagram: (diagramId: string) => void;
}

interface TreeNodeProps {
  node: ProjectTreeNodeDto;
  onOpenDiagram: (id: string) => void;
  onRequestDelete: (diagramId: string, diagramName: string) => void;
}

function TreeNode({ node, onOpenDiagram, onRequestDelete }: TreeNodeProps) {
  return (
    <li>
      <strong data-testid={`project-node-${node.id}`}>{node.name}</strong>
      <ul>
        {node.diagrams.map((diagram) => (
          <li key={diagram.id}>
            <button type="button" data-testid={`open-diagram-${diagram.id}`} onClick={() => onOpenDiagram(diagram.id)}>
              {diagram.name}
            </button>
            <button
              type="button"
              data-testid={`delete-diagram-${diagram.id}`}
              onClick={() => onRequestDelete(diagram.id, diagram.name)}
            >
              Delete
            </button>
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
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

  const refresh = () => {
    api.getProjectTree(rootProjectId).then(({ tree }) => setTree(tree));
  };

  useEffect(refresh, [rootProjectId]);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    await api.deleteDiagram(pendingDelete.id);
    setPendingDelete(null);
    refresh();
  };

  if (!tree) return <p>Loading…</p>;

  return (
    <div>
      <ul data-testid="project-browser">
        <TreeNode
          node={tree}
          onOpenDiagram={onOpenDiagram}
          onRequestDelete={(id, name) => setPendingDelete({ id, name })}
        />
      </ul>
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
