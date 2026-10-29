import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type DiagramVersionDto } from '../app/api';
import { Icon } from '../ui/Icon';

const SEARCH_DEBOUNCE_MS = 250;

export interface VersionHistoryProps {
  diagramId: string;
  /** Bump this (e.g. a counter) whenever the host saves a new version elsewhere — the list only
   * knows to re-fetch when either this or diagramId changes. */
  refreshToken: number;
  /** Called after a successful restore with the (new) current diagram content, so the editor
   * can reload it — restoring never rewrites history, it appends a new version (FR-017). */
  onRestored: () => void;
}

/** Version history panel: view and restore prior versions of a diagram (FR-017). */
export function VersionHistory({ diagramId, refreshToken, onRestored }: VersionHistoryProps) {
  const [versions, setVersions] = useState<DiagramVersionDto[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [search, setSearch] = useState('');
  // canvas-547: the query actually sent, trailing `search` by SEARCH_DEBOUNCE_MS so typing doesn't
  // fire one request per keystroke.
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  // canvas-547: once the first page has loaded, later fetches (a search, a save elsewhere) keep the
  // panel -- and the search input with its focus -- mounted; only the list shows it's busy.
  // Before, every keystroke swapped the whole panel for the loading skeleton, unmounting the input.
  const [loaded, setLoaded] = useState(false);
  // Only the newest request may update the list, so a slow reply can't overwrite newer results.
  const latestRequest = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const refresh = useCallback(() => {
    const request = ++latestRequest.current;
    setStatus('loading');
    api
      .listDiagramVersions(diagramId, { q: query || undefined })
      .then((page) => {
        if (request !== latestRequest.current) return;
        setVersions(page.versions);
        setHasMore(page.hasMore);
        setStatus('ready');
        setLoaded(true);
      })
      .catch(() => {
        if (request === latestRequest.current) setStatus('error');
      });
  }, [diagramId, query]);

  useEffect(refresh, [refresh, refreshToken]);

  const handleRestore = async (versionId: string) => {
    await api.restoreDiagramVersion(diagramId, versionId);
    refresh();
    onRestored();
  };

  const errorMessage = (
    <p className="state state--error" data-testid="version-history-error">
      <Icon name="warning" className="state__icon" />
      Could not load version history.
      <button type="button" className="btn btn--tertiary btn--compact" onClick={refresh}>
        Retry
      </button>
    </p>
  );

  if (!loaded && status === 'loading') {
    return (
      <div className="panel">
        <div className="panel__header">Version History</div>
        <div className="panel__body" aria-busy="true">
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
        </div>
      </div>
    );
  }

  if (!loaded && status === 'error') {
    return (
      <div className="panel">
        <div className="panel__header">Version History</div>
        <div className="panel__body">{errorMessage}</div>
      </div>
    );
  }

  if (versions.length === 0 && !search && !query) {
    return (
      <div className="panel">
        <div className="panel__header">Version History</div>
        <div className="panel__body">
          <p className="state" data-testid="version-history-empty">
            <Icon name="history" className="state__icon" />
            No saved versions yet — save this diagram to create one.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel__header">Version History</div>
      <div className="version-search">
        <input
          data-testid="version-search"
          aria-label="Search versions by number or date"
          placeholder="Search by version or date…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {/* FR-029: older versions are not hidden silently — the architect is told they exist. */}
      {hasMore && !search && (
        <p className="meta version-more" data-testid="version-history-more">
          Showing the {versions.length} most recent. Search to find older versions.
        </p>
      )}
      {status === 'error' && errorMessage}
      {status === 'ready' && versions.length === 0 && query && (
        <p className="state" data-testid="version-search-empty">
          No versions match &ldquo;{query}&rdquo;.
        </p>
      )}
      <ul className="panel__body panel__body--flush" data-testid="version-history" aria-busy={status === 'loading'}>
        {versions.map((version) => (
          <li key={version.id} className="row" data-testid={`version-${version.sequenceNumber}`}>
            <span className="row__main">
              <span className="row__title">v{version.sequenceNumber}</span>
              <span className="meta">{new Date(version.createdAt).toLocaleString()}</span>
            </span>
            <button
              type="button"
              className="btn btn--tertiary btn--compact"
              data-testid={`restore-version-${version.sequenceNumber}`}
              onClick={() => handleRestore(version.id)}
            >
              Restore
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
