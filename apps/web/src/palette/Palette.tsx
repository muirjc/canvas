import { useEffect, useState } from 'react';
import { api, type IconDto } from '../app/api';

export interface PaletteProps {
  diagramTypeId: string;
  onSelectIcon: (icon: IconDto) => void;
}

/**
 * Searchable shape/icon palette scoped to the current diagram type's default libraries
 * (FR-007/FR-009) — e.g. a cloud-infrastructure diagram only searches azure-icons/aws-icons,
 * never surfacing unrelated notation.
 */
export function Palette({ diagramTypeId, onSelectIcon }: PaletteProps) {
  const [query, setQuery] = useState('');
  const [icons, setIcons] = useState<IconDto[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .searchIcons(diagramTypeId, query)
      .then(({ icons }) => {
        if (!cancelled) setIcons(icons);
      })
      .catch(() => {
        if (!cancelled) setIcons([]);
      });
    return () => {
      cancelled = true;
    };
  }, [diagramTypeId, query]);

  return (
    <div>
      <input
        data-testid="palette-search"
        aria-label="Search shapes and icons"
        placeholder="Search shapes/icons…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul data-testid="palette-results">
        {icons.map((icon) => (
          <li key={`${icon.libraryId}:${icon.id}`}>
            <button type="button" data-testid={`palette-icon-${icon.libraryId}-${icon.id}`} onClick={() => onSelectIcon(icon)}>
              {icon.displayName}
            </button>
          </li>
        ))}
        {icons.length === 0 && <li data-testid="palette-no-results">No matches.</li>}
      </ul>
    </div>
  );
}
