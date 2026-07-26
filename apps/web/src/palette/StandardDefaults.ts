import { useEffect, useState } from 'react';
import { api, ApiError, type StandardDto } from '../app/api';

/**
 * Fetches the active Standard for a diagram type, if one exists (FR-012: new diagrams of a type
 * with an active Standard default to its approved shapes/colors). No published standard is a
 * normal state (404), not an error — every diagram type starts unrestricted.
 */
export function useActiveStandard(diagramTypeId: string): StandardDto | null {
  const [standard, setStandard] = useState<StandardDto | null>(null);

  useEffect(() => {
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
  }, [diagramTypeId]);

  return standard;
}

/** The approved color for a semantic node role under a given Standard, if one is defined. */
export function approvedColorForRole(standard: StandardDto | null, role: string): string | undefined {
  return standard?.colorPalette.find((entry) => entry.role === role)?.colorHex;
}

/** Whether a shape is restricted to the Standard's approved list (empty list = unrestricted). */
export function isShapeApproved(standard: StandardDto | null, shape: string): boolean {
  if (!standard || standard.allowedShapeIds.length === 0) return true;
  return standard.allowedShapeIds.includes(shape);
}
