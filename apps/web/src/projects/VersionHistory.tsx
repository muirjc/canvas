import { useEffect, useState } from 'react';
import { api, type DiagramVersionDto } from '../app/api';

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

  const refresh = () => {
    api.listDiagramVersions(diagramId).then(({ versions }) => setVersions(versions));
  };

  useEffect(refresh, [diagramId, refreshToken]);

  const handleRestore = async (versionId: string) => {
    await api.restoreDiagramVersion(diagramId, versionId);
    refresh();
    onRestored();
  };

  return (
    <div>
      <h3>Version History</h3>
      <ul data-testid="version-history">
        {versions.map((version) => (
          <li key={version.id} data-testid={`version-${version.sequenceNumber}`}>
            v{version.sequenceNumber} — {new Date(version.createdAt).toLocaleString()}
            <button type="button" data-testid={`restore-version-${version.sequenceNumber}`} onClick={() => handleRestore(version.id)}>
              Restore
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
