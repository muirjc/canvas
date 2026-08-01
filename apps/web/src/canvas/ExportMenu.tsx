import { loadWebConfig } from '../config';

export interface ExportMenuProps {
  diagramId: string;
  diagramName: string;
  /** canvas-uaq: export reads the diagram's last-SAVED dslContent (getDiagram() on the server),
   *  never the live editor state — there is no way to export unsaved work. Without this, exporting
   *  right after adding shapes (before clicking Save) silently downloaded stale content: a
   *  freshly-created diagram's export was just its empty initial template, and SVG/PNG came out
   *  valid but completely blank. Disabling export until the change is saved turns that silent,
   *  confusing gap into a one-click fix (Save sits right next to Export already). */
  hasUnsavedChanges: boolean;
}

const FORMAT_EXTENSIONS: Record<string, string> = {
  mermaid: 'mmd',
  svg: 'svg',
  png: 'png',
};

const UNSAVED_CHANGES_MESSAGE = 'Save your changes first — export always reflects the diagram\'s last saved version.';

async function downloadExport(diagramId: string, diagramName: string, format: 'mermaid' | 'svg' | 'png') {
  const { apiBaseUrl } = loadWebConfig();
  const response = await fetch(`${apiBaseUrl}/diagrams/${diagramId}/export?format=${format}`, {
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`Export failed with status ${response.status}`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${diagramName}.${FORMAT_EXTENSIONS[format]}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** FR-004: export any diagram as Mermaid DSL, SVG, and PNG on demand. */
export function ExportMenu({ diagramId, diagramName, hasUnsavedChanges }: ExportMenuProps) {
  return (
    <div role="group" aria-label="Export diagram">
      {hasUnsavedChanges && (
        <span className="meta" data-testid="export-unsaved-warning" title={UNSAVED_CHANGES_MESSAGE}>
          Save to enable export
        </span>
      )}
      {(['mermaid', 'svg', 'png'] as const).map((format) => (
        <button
          key={format}
          type="button"
          data-testid={`export-${format}`}
          disabled={hasUnsavedChanges}
          title={hasUnsavedChanges ? UNSAVED_CHANGES_MESSAGE : undefined}
          onClick={() => downloadExport(diagramId, diagramName, format)}
        >
          Export {format.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
