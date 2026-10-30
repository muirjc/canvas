import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type DiagramVersionDto } from '../app/api';
import { parseVersionQuery } from './version-query';
import { Icon } from '../ui/Icon';

const SEARCH_DEBOUNCE_MS = 250;

export interface VersionHistoryProps {
  diagramId: string;
  /** Bump this (e.g. a counter) whenever the host saves a new version elsewhere — the list only
   * knows to re-fetch when either this or diagramId changes. */
  refreshToken: number;
  /** canvas-3fha: open a version read-only on the canvas. Restoring happens from that preview. */
  onPreview: (version: DiagramVersionDto) => void;
  /** The version being previewed, if any (its row is marked current). */
  previewedVersionId?: string;
}

/** Version history panel: find a prior version of a diagram and open it to view or restore (FR-017). */
export function VersionHistory({ diagramId, refreshToken, onPreview, previewedVersionId }: VersionHistoryProps) {
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
      // canvas-zfe: version numbers and author names go as text; a typed date becomes a range.
      .listDiagramVersions(diagramId, parseVersionQuery(query))
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
          aria-label="Search versions by number (v3), date (Oct 26, today) or author name"
          placeholder="Search: v3, Oct 26, or a name…"
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
          No versions match &ldquo;{query}&rdquo;. Try a version like v3, a date like Oct 26 or today, or a name.
        </p>
      )}
      <ul className="panel__body panel__body--flush" data-testid="version-history" aria-busy={status === 'loading'}>
        {versions.map((version) => {
          const previewing = version.id === previewedVersionId;
          return (
            <li
              key={version.id}
              className={`row${previewing ? ' row--selected' : ''}`}
              data-testid={`version-${version.sequenceNumber}`}
              aria-current={previewing ? 'true' : undefined}
            >
              <span className="row__main">
                <span className="row__title">
                  v{version.sequenceNumber}
                  {version.restoredFromSequence !== null && (
                    <span className="badge" data-testid={`version-restored-from-${version.sequenceNumber}`}>
                      Restored from v{version.restoredFromSequence}
                    </span>
                  )}
                </span>
                <span className="meta">
                  {version.authorName} · {new Date(version.createdAt).toLocaleString()}
                </span>
              </span>
              <button
                type="button"
                className="btn btn--tertiary btn--compact"
                data-testid={`view-version-${version.sequenceNumber}`}
                aria-label={`View v${version.sequenceNumber}`}
                aria-pressed={previewing}
                onClick={() => onPreview(version)}
              >
                {previewing ? 'Viewing' : 'View'}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
