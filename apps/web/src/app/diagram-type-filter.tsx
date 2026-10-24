import { useState } from 'react';
import type { DiagramTypeDto } from './api';

const KEY = 'canvas.showAllDiagramTypes';

const readShowAll = (): boolean => {
  try {
    return window.localStorage.getItem(KEY) === 'true';
  } catch {
    return false;
  }
};

const writeShowAll = (value: boolean) => {
  try {
    window.localStorage.setItem(KEY, String(value));
  } catch {
    // Remembering the choice is optional.
  }
};

/**
 * Narrows a diagram-type list to the signed-in user's personas. With no personas, or when the
 * filter would leave nothing, everything is shown (with a short note in the second case).
 * Returns the types to render and the checkbox/note to put above them.
 */
export function useDiagramTypeFilter(types: DiagramTypeDto[], userPersonas: string[] | undefined) {
  const [showAll, setShowAll] = useState(readShowAll);
  const personas = userPersonas ?? [];
  if (personas.length === 0) return { visible: types, control: null };

  const matching = types.filter((t) => t.personas.some((p) => personas.includes(p)));
  const nothingMatches = types.length > 0 && matching.length === 0;
  const visible = showAll || nothingMatches ? types : matching;

  const control = (
    <div className="stack" style={{ marginBlockEnd: 'var(--space-3)' }}>
      {nothingMatches ? (
        <p className="meta" data-testid="diagram-types-no-match">
          No diagram types are set up for your personas ({personas.join(', ')}), so all types are shown.
        </p>
      ) : (
        <label className="cluster" htmlFor="show-all-diagram-types">
          <input
            id="show-all-diagram-types"
            data-testid="show-all-diagram-types"
            type="checkbox"
            checked={showAll}
            onChange={(e) => {
              setShowAll(e.target.checked);
              writeShowAll(e.target.checked);
            }}
          />
          Show all diagram types
        </label>
      )}
    </div>
  );
  return { visible, control };
}
