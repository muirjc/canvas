/**
 * The project the user is working in (feature 007).
 *
 * Before this, `projectId` lived only in the address bar: the application read it and never wrote
 * it, so landing on the root and clicking New Diagram failed outright, and every `<a href="?…">`
 * discarded it because each one is an absolute query-string replacement. The only way to hold a
 * project context was to type it into the address bar.
 *
 * The selection is per-tab application state seeded from the address — two tabs can sit on
 * different projects without fighting — and the address keeps naming the project in view so links
 * stay shareable (FR-011).
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The project named by the current address, or null. A malformed identifier reads as "no project"
 * rather than being passed to the API to fail there (spec Edge Cases).
 */
export function readProjectIdFromUrl(): string | null {
  const raw = new URLSearchParams(window.location.search).get('projectId');
  if (!raw || !UUID_PATTERN.test(raw)) return null;
  return raw;
}

/**
 * Points the address at `projectId` without adding a history entry.
 *
 * Replacing rather than pushing is deliberate: the address must keep reflecting the selection so
 * a copied link opens the same project (FR-011), but pushing on every switch would make the back
 * control require one press per switch to escape (FR-012).
 */
export function syncProjectIdToUrl(projectId: string | null): void {
  const url = new URL(window.location.href);
  if (projectId) url.searchParams.set('projectId', projectId);
  else url.searchParams.delete('projectId');
  window.history.replaceState(window.history.state, '', url);
}

/**
 * Builds an in-app destination that carries the current project.
 *
 * Every link in the app is an absolute query-string replacement, which is exactly why the context
 * was lost on the first hop into the admin console. Routing them all through here makes carrying
 * the project the default rather than something each new link has to remember — the eleventh link
 * someone adds gets it for free.
 */
export function withProjectContext(params: Record<string, string>, projectId: string | null): string {
  const search = new URLSearchParams(params);
  if (projectId) search.set('projectId', projectId);
  const query = search.toString();
  return query ? `?${query}` : '?';
}
