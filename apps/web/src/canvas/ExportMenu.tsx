import { loadWebConfig } from '../config';

export interface ExportMenuProps {
  diagramId: string;
  diagramName: string;
}

const FORMAT_EXTENSIONS: Record<string, string> = {
  mermaid: 'mmd',
  svg: 'svg',
  png: 'png',
};

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
export function ExportMenu({ diagramId, diagramName }: ExportMenuProps) {
  return (
    <div role="group" aria-label="Export diagram">
      {(['mermaid', 'svg', 'png'] as const).map((format) => (
        <button
          key={format}
          type="button"
          data-testid={`export-${format}`}
          onClick={() => downloadExport(diagramId, diagramName, format)}
        >
          Export {format.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
