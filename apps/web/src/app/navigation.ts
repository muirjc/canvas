/**
 * canvas-t3b.2: where the user is, as one value derived from the address -- replacing the global
 * "current project" (docs/browse-screen-design.md §1-§3). Pure functions here; App.tsx owns the
 * state, the history writes and the unsaved-changes guard.
 */

export type Location =
  | { screen: 'projects' }
  | { screen: 'project'; projectId: string }
  | { screen: 'diagram'; diagramId: string }
  /** ?account=password: the signed-in user's own change-password screen. */
  | { screen: 'account' }
  /** canvas-fkp: ?help=<page>[&section=<heading id>]: in-app Help ('user', 'user/editor', 'admin/people'...). */
  | { screen: 'help'; page: string; section?: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The screen an address names. `?diagramId=` wins over `?projectId=` (an old link can't carry
 * both, but a hand-edited one might). A malformed id reads as the top level rather than being sent
 * to the API to fail there (feature 007's spec Edge Cases).
 */
export function parseLocation(search: string): Location {
  const params = new URLSearchParams(search);
  const diagramId = params.get('diagramId');
  if (diagramId && UUID_PATTERN.test(diagramId)) return { screen: 'diagram', diagramId };
  const projectId = params.get('projectId');
  if (projectId && UUID_PATTERN.test(projectId)) return { screen: 'project', projectId };
  if (params.get('account') === 'password') return { screen: 'account' };
  const help = params.get('help');
  if (help !== null && /^(user|admin)(\/[\w-]+)?$/.test(help || 'user')) {
    const section = params.get('section');
    return { screen: 'help', page: help || 'user', ...(section && /^[\w-]+$/.test(section) ? { section } : {}) };
  }
  return { screen: 'projects' };
}

/** True when the address names nothing (no screen and no admin page): only then do landing rules apply. */
export function isBareAddress(search: string): boolean {
  const params = new URLSearchParams(search);
  return !params.get('diagramId') && !params.get('projectId') && !params.get('admin') && !params.get('account') && params.get('help') === null;
}

/** The address for a location (path-relative query string; '?' for the top level). */
export function locationToSearch(location: Location): string {
  if (location.screen === 'diagram') return `?diagramId=${encodeURIComponent(location.diagramId)}`;
  if (location.screen === 'project') return `?projectId=${encodeURIComponent(location.projectId)}`;
  if (location.screen === 'account') return '?account=password';
  if (location.screen === 'help') {
    return `?help=${location.page}${location.section ? `&section=${encodeURIComponent(location.section)}` : ''}`;
  }
  return '?';
}

export function sameLocation(a: Location, b: Location): boolean {
  if (a.screen !== b.screen) return false;
  if (a.screen === 'project' && b.screen === 'project') return a.projectId === b.projectId;
  if (a.screen === 'diagram' && b.screen === 'diagram') return a.diagramId === b.diagramId;
  if (a.screen === 'help' && b.screen === 'help') return a.page === b.page && a.section === b.section;
  return true;
}

/**
 * Where a bare address lands (design "Landing and product decisions" 1-2): the only project when
 * there's exactly one and nothing shared; the last project opened in this browser when there are
 * two or more and it's still theirs; otherwise the top level.
 */
export function resolveLanding(projectIds: string[], sharedCount: number, lastProjectId: string | null): Location {
  if (projectIds.length === 1 && sharedCount === 0) return { screen: 'project', projectId: projectIds[0] };
  if (projectIds.length >= 2 && lastProjectId && projectIds.includes(lastProjectId)) {
    return { screen: 'project', projectId: lastProjectId };
  }
  return { screen: 'projects' };
}

const LAST_PROJECT_KEY = 'canvas.lastProjectId';

/** The last project opened in this browser -- a landing hint only, never "current project" state.
 *  Storage can be unavailable (private mode, blocked site data), so every access is guarded. */
export function readLastProjectId(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function writeLastProjectId(projectId: string | null): void {
  try {
    if (projectId) window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
    else window.localStorage.removeItem(LAST_PROJECT_KEY);
  } catch {
    // A landing hint is optional; losing it just means landing on the top level.
  }
}
