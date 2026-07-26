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
    <div>
      <textarea
        data-testid="dsl-panel"
        aria-label="Mermaid DSL for this diagram"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={20}
        cols={60}
        spellCheck={false}
      />
      <div>
        <button type="button" data-testid="apply-dsl" onClick={() => onApply(draft)}>
          Apply
        </button>
      </div>
      <UnsupportedElementNotice errors={parseErrors} />
    </div>
  );
}
