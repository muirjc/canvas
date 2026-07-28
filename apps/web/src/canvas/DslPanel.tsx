import { useEffect, useState } from 'react';
import type { ParseError } from '@canvas/diagram-core';
import { UnsupportedElementNotice } from './UnsupportedElementNotice';

export interface DslPanelProps {
  dsl: string;
  parseErrors: ParseError[];
  onApply: (dslText: string) => void;
}

/** Editable Mermaid DSL text panel (FR-003): edits here update the canvas via onApply. */
export function DslPanel({ dsl, parseErrors, onApply }: DslPanelProps) {
  const [draft, setDraft] = useState(dsl);

  // Keep the draft in sync when the canvas changes the model (and thus the derived DSL),
  // but don't clobber in-progress typing.
  useEffect(() => {
    setDraft(dsl);
  }, [dsl]);

  return (
    <div className="panel">
      <div className="panel__body panel__body--flush dsl-panel">
        <textarea
          className="dsl-panel__editor"
          data-testid="dsl-panel"
          aria-label="Mermaid DSL for this diagram"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
        />
        <UnsupportedElementNotice errors={parseErrors} />
      </div>
      <div className="panel__footer">
        <button
          type="button"
          className="btn btn--primary btn--compact"
          data-testid="apply-dsl"
          onClick={() => onApply(draft)}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
