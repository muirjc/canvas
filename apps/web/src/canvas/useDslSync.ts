import { useCallback, useMemo, useState } from 'react';
import { getDslFamily, isParseSuccess, type DiagramModel, type ParseError } from '@canvas/diagram-core';

export interface UseDslSyncResult {
  dsl: string;
  parseErrors: ParseError[];
  /** Applies user-edited DSL text to the model. Returns false (and sets parseErrors) on failure. */
  applyDsl: (dslText: string) => boolean;
}

/**
 * Bidirectional DSL↔canvas sync (Constitution I / FR-003): the canvas always derives its Mermaid
 * DSL from the current model via the diagram-core serializer, and applying edited DSL text
 * re-parses it back into the model using the same diagram-core parser the backend uses — so the
 * editor and the server never disagree about what a diagram means.
 */
export function useDslSync(
  model: DiagramModel,
  onModelChange: (model: DiagramModel) => void,
  dslFamilyId: string,
): UseDslSyncResult {
  const [parseErrors, setParseErrors] = useState<ParseError[]>([]);
  const family = getDslFamily(dslFamilyId);

  const dsl = useMemo(() => {
    if (!family) return '';
    return family.serialize(model);
  }, [family, model]);

  const applyDsl = useCallback(
    (dslText: string): boolean => {
      if (!family) return false;
      const result = family.parse(dslText);
      if (!isParseSuccess(result)) {
        setParseErrors(result.errors);
        return false;
      }
      setParseErrors([]);
      onModelChange(result.model);
      return true;
    },
    [family, onModelChange],
  );

  return { dsl, parseErrors, applyDsl };
}
