/**
 * canvas-93n: the diagrams this person opened most recently, on this browser (localStorage, per
 * user). A shortcut only: the Projects page re-checks each one with the server before showing it,
 * so a deleted diagram, or one they've lost access to, drops out.
 */
export interface RecentDiagram {
  id: string;
  name: string;
  openedAt: string;
}

export const RECENT_LIMIT = 5;
const key = (userId: string) => `canvas.recentDiagrams.${userId}`;

export function readRecentDiagrams(userId: string): RecentDiagram[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key(userId)) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((d): d is RecentDiagram => typeof d?.id === 'string' && typeof d?.name === 'string' && typeof d?.openedAt === 'string')
      : [];
  } catch {
    return [];
  }
}

function write(userId: string, list: RecentDiagram[]): void {
  try {
    window.localStorage.setItem(key(userId), JSON.stringify(list.slice(0, RECENT_LIMIT)));
  } catch {
    /* storage unavailable: no recents, nothing else affected */
  }
}

/** Puts a diagram at the top of the list (moving it if it was already there). */
export function recordRecentDiagram(userId: string, diagram: { id: string; name: string }, now = new Date()): void {
  write(userId, [{ id: diagram.id, name: diagram.name, openedAt: now.toISOString() }, ...readRecentDiagrams(userId).filter((d) => d.id !== diagram.id)]);
}

/** Keeps only the diagrams still available, with their current names. */
export function replaceRecentDiagrams(userId: string, list: RecentDiagram[]): void {
  write(userId, list);
}
