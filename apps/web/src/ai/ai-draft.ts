/**
 * canvas-j6v: Create with AI makes a DRAFT diagram on the server -- an empty placeholder that holds
 * the AI conversation, not the drawing. The drawing itself stays in this tab until the user saves
 * it, so a reload in the same tab doesn't lose it. Closing the tab does: nothing was saved.
 * sessionStorage can be missing or throw (private mode, blocked storage); every call tolerates that.
 */
const key = (diagramId: string) => `canvas.aiDraft.${diagramId}`;

export function stashDraftDsl(diagramId: string, dsl: string): void {
  try {
    window.sessionStorage.setItem(key(diagramId), dsl);
  } catch {
    /* storage unavailable: a reload just won't bring the drawing back */
  }
}

export function readDraftDsl(diagramId: string): string | null {
  try {
    return window.sessionStorage.getItem(key(diagramId));
  } catch {
    return null;
  }
}

export function clearDraftDsl(diagramId: string): void {
  try {
    window.sessionStorage.removeItem(key(diagramId));
  } catch {
    /* nothing to clear */
  }
}
