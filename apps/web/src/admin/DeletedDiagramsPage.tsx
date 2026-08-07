import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type DeletedDiagramDto } from '../app/api';

/**
 * Admin-only view of soft-deleted diagrams (FR-020): metadata only (name, owner, project,
 * deletion date) — never the diagram's content. Restoring is the only way to see it again.
 *
 * canvas-23t.3: owner/project now show resolved names (server-joined), not raw UUIDs, and the
 * list is capped with a search input — the same shape as VersionHistory.tsx's own search/cap UX,
 * reusing the generic `.meta`/`.state` utility classes rather than inventing panel-specific ones
 * (this screen has no `.panel` wrapper to begin with — it's a bare admin table, styled by
 * base.css's element selectors, not a canvas side-panel).
 */
export function DeletedDiagramsPage() {
  const [diagrams, setDiagrams] = useState<DeletedDiagramDto[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setStatus('loading');
    api
      .listDeletedDiagrams({ q: search || undefined })
      .then((page) => {
        setDiagrams(page.diagrams);
        setHasMore(page.hasMore);
        setStatus('ready');
      })
      .catch(() => setStatus('error'));
  }, [search]);

  useEffect(refresh, [refresh]);

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
      <input
        data-testid="deleted-diagrams-search"
        aria-label="Search deleted diagrams by name, owner, or project"
        placeholder="Search by name, owner, or project…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {status === 'error' && (
        <p className="state state--error" data-testid="deleted-diagrams-error">
          Could not load deleted diagrams.
          <button type="button" onClick={refresh}>
            Retry
          </button>
        </p>
      )}
      {status === 'ready' && (
        <>
          {/* FR-029: older deletions are not hidden silently — the admin is told they exist. */}
          {hasMore && !search && (
            <p className="meta" data-testid="deleted-diagrams-more">
              Showing the {diagrams.length} most recent. Search to find older deletions.
            </p>
          )}
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
                  <td>{diagram.ownerName}</td>
                  <td>{diagram.projectName}</td>
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
          {diagrams.length === 0 && !search && <p>No deleted diagrams within the retention window.</p>}
          {diagrams.length === 0 && search && (
            <p className="state" data-testid="deleted-diagrams-search-empty">
              No deleted diagrams match &ldquo;{search}&rdquo;.
            </p>
          )}
        </>
      )}
      {message && (
        <p role="status" data-testid="deleted-diagrams-message">
          {message}
        </p>
      )}
    </div>
  );
}
