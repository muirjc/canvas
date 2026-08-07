import { useEffect, useRef, useState } from 'react';
import { loadWebConfig } from '../config';
import { Icon } from '../ui/Icon';

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

const FORMATS = [
  { format: 'mermaid', label: 'Mermaid' },
  { format: 'svg', label: 'SVG' },
  { format: 'png', label: 'PNG' },
] as const;

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

/**
 * FR-004: export any diagram as Mermaid DSL, SVG, and PNG on demand. canvas-23t.5's US6/finding
 * #6: consolidated into a single "Export ▾" disclosure button (ui-design-spec.md §3.3's
 * `[⤒ Export ▾]` doc-bar control) instead of three always-visible, unstyled buttons — Mermaid
 * didn't exist as an export format when that mockup was drawn, so its two-format dropdown
 * generalizes to three rather than changing shape.
 *
 * A plain disclosure (toggle button + absolutely-positioned list, `aria-haspopup`/`aria-expanded`)
 * rather than a full ARIA `role="menu"` widget — this app has no existing menu/roving-tabindex
 * pattern to extend, and a disclosure needs none of that machinery to pass an axe audit or behave
 * predictably with a screen reader: each item is just a normal, individually-tabbable button.
 */
export function ExportMenu({ diagramId, diagramName, hasUnsavedChanges }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  const closeAndFocusTrigger = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleSelect = (format: (typeof FORMATS)[number]['format']) => {
    downloadExport(diagramId, diagramName, format);
    closeAndFocusTrigger();
  };

  return (
    <div
      className="export-menu"
      ref={containerRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          closeAndFocusTrigger();
        }
      }}
    >
      {hasUnsavedChanges && (
        <span className="meta" data-testid="export-unsaved-warning" title={UNSAVED_CHANGES_MESSAGE}>
          Save to enable export
        </span>
      )}
      <button
        ref={triggerRef}
        type="button"
        className="btn btn--secondary btn--compact"
        data-testid="export-menu-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={hasUnsavedChanges}
        title={hasUnsavedChanges ? UNSAVED_CHANGES_MESSAGE : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="download" />
        Export
        <Icon name="chevron-down" />
      </button>
      {open && (
        <ul className="export-menu__list" data-testid="export-menu-list">
          {FORMATS.map(({ format, label }) => (
            <li key={format}>
              <button
                type="button"
                className="export-menu__item"
                data-testid={`export-${format}`}
                onClick={() => handleSelect(format)}
              >
                {label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
