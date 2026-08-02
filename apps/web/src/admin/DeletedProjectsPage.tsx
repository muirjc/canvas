import { useEffect, useState } from 'react';
import { api, ApiError, type DeletedProjectDto } from '../app/api';

/**
 * Admin-only view of soft-deleted projects (canvas-228.2) — metadata only (name, owner, deletion
 * date). Restoring is the only way to see it again. Mirrors DeletedDiagramsPage exactly.
 */
export function DeletedProjectsPage() {
  const [projects, setProjects] = useState<DeletedProjectDto[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => {
    api.listDeletedProjects().then(({ projects }) => setProjects(projects));
  };

  useEffect(refresh, []);

  const handleRestore = async (id: string) => {
    setMessage(null);
    try {
      await api.restoreProject(id);
      setMessage('Project restored.');
      refresh();
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'Failed to restore project.');
    }
  };

  return (
    <div>
      <h2>Deleted Projects</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Owner</th>
            <th>Deleted</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr key={project.id} data-testid={`deleted-project-row-${project.id}`}>
              <td>{project.name}</td>
              <td>{project.ownerId}</td>
              <td>{new Date(project.deletedAt).toLocaleString()}</td>
              <td>
                <button type="button" data-testid={`restore-project-${project.id}`} onClick={() => handleRestore(project.id)}>
                  Restore
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {projects.length === 0 && <p>No deleted projects within the retention window.</p>}
      {message && (
        <p role="status" data-testid="deleted-projects-message">
          {message}
        </p>
      )}
    </div>
  );
}
