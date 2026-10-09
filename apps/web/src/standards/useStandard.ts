import { useEffect, useMemo, useState } from 'react';
import { validate, type DiagramModel, type StandardRules, type Violation } from '@canvas/diagram-core';
import { api, ApiError, type StandardDto } from '../app/api';

/**
 * Fetches the active (published) Standard for a diagram type, if one exists. No published
 * standard is a normal state (404), not an error -- every diagram type starts unrestricted.
 * `refreshKey` lets the caller re-fetch (e.g. after a save reports a different standard version).
 *
 * canvas-tfr: replaces palette/StandardDefaults.ts, whose helpers were never wired to anything.
 */
export function useActiveStandard(diagramTypeId: string | undefined, refreshKey = 0): StandardDto | null {
  const [standard, setStandard] = useState<StandardDto | null>(null);

  useEffect(() => {
    if (!diagramTypeId) {
      setStandard(null);
      return;
    }
    let cancelled = false;
    api
      .getActiveStandard(diagramTypeId)
      .then(({ standard }) => {
        if (!cancelled) setStandard(standard);
      })
      .catch((error) => {
        if (!cancelled && !(error instanceof ApiError && error.status === 404)) {
          console.error('Failed to load active standard', error);
        }
        if (!cancelled) setStandard(null);
      });
    return () => {
      cancelled = true;
    };
  }, [diagramTypeId, refreshKey]);

  return standard;
}

/**
 * canvas-tfr: live standards check of the model being edited -- the same pure diagram-core
 * `validate` the server runs on save, so the Issues tab reflects every edit immediately instead
 * of only the last saved result. `undefined` while there is no model or no standard.
 */
export function useLiveViolations(model: DiagramModel | null | undefined, rules: StandardRules | undefined): Violation[] | undefined {
  return useMemo(() => (model && rules ? validate(model, rules) : undefined), [model, rules]);
}
