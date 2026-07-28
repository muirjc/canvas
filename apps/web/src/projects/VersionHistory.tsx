import { useEffect, useState } from 'react';
import { api, type DiagramVersionDto } from '../app/api';
import { Icon } from '../ui/Icon';

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
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  const refresh = () => {
    setStatus('loading');
    api
      .listDiagramVersions(diagramId)
      .then(({ versions }) => {
        setVersions(versions);
        setStatus('ready');
      })
      .catch(() => setStatus('error'));
  };

  useEffect(refresh, [diagramId, refreshToken]);

  const handleRestore = async (versionId: string) => {
    await api.restoreDiagramVersion(diagramId, versionId);
    refresh();
    onRestored();
  };

  if (status === 'loading') {
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

  if (status === 'error') {
    return (
      <div className="panel">
        <div className="panel__header">Version History</div>
        <div className="panel__body">
          <p className="state state--error" data-testid="version-history-error">
            <Icon name="warning" className="state__icon" />
            Could not load version history.
            <button type="button" className="btn btn--tertiary btn--compact" onClick={refresh}>
              Retry
            </button>
          </p>
        </div>
      </div>
    );
  }

  if (versions.length === 0) {
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
      <ul className="panel__body panel__body--flush" data-testid="version-history">
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
