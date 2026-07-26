import { useEffect, useState } from 'react';
import { api, ApiError, type DeletedDiagramDto } from '../app/api';

/**
 * Admin-only view of soft-deleted diagrams (FR-020): metadata only (name, owner, project,
 * deletion date) — never the diagram's content. Restoring is the only way to see it again.
 */
export function DeletedDiagramsPage() {
  const [diagrams, setDiagrams] = useState<DeletedDiagramDto[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => {
    api.listDeletedDiagrams().then(({ diagrams }) => setDiagrams(diagrams));
  };

  useEffect(refresh, []);

  const handleRestore = async (id: string) => {
    setMessage(null);
    try {
      await api.restoreDiagram(id);
      setMessage('Diagram restored.');
      refresh();
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'Failed to restore diagram.');
    }
  };

  return (
    <div>
      <h2>Deleted Diagrams</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Owner</th>
            <th>Project</th>
            <th>Deleted</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {diagrams.map((diagram) => (
            <tr key={diagram.id} data-testid={`deleted-diagram-row-${diagram.id}`}>
              <td>{diagram.name}</td>
              <td>{diagram.ownerId}</td>
              <td>{diagram.projectId}</td>
              <td>{new Date(diagram.deletedAt).toLocaleString()}</td>
              <td>
                <button type="button" data-testid={`restore-diagram-${diagram.id}`} onClick={() => handleRestore(diagram.id)}>
                  Restore
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {diagrams.length === 0 && <p>No deleted diagrams within the retention window.</p>}
      {message && (
        <p role="status" data-testid="deleted-diagrams-message">
          {message}
        </p>
      )}
    </div>
  );
}
