/**
 * canvas-1bty.6: the routes the Python service answers, by group, as "METHOD /fastify/route/:pattern".
 *
 * Each group's TypeScript routes stay registered for one release as the fallback: setting
 * PYTHON_ROUTE_GROUPS to leave a group out (or to "none") sends it back to TypeScript with no
 * deploy. Every route listed here must be in the API contract snapshot (apps/api/contract/openapi.json,
 * checked by tests/contract/openapi-snapshot.test.ts), which the Python tests hold their responses to.
 */
export const PYTHON_ROUTE_GROUPS = {
  // Phase 2 (canvas-1bty.6). Project members and ownership move with sharing in phase 3.
  projects: [
    'POST /projects',
    'GET /projects',
    'GET /projects/:id',
    'GET /projects/:id/tree',
    'PATCH /projects/:id',
    'DELETE /projects/:id',
    'GET /admin/deleted-projects',
    'POST /projects/:id/restore',
  ],
  'diagram-types': ['GET /diagram-types', 'POST /admin/diagram-types', 'PATCH /admin/diagram-types/:id', 'DELETE /admin/diagram-types/:id'],
  // POST /libraries (loading a built-in library, used by the catalog seed) stays with library admin.
  libraries: ['GET /libraries', 'GET /libraries/:id/versions/:version/icons', 'GET /icons/search'],
  'app-settings': ['GET /app-settings', 'PATCH /admin/app-settings'],
} as const satisfies Record<string, readonly string[]>;

export type PythonRouteGroup = keyof typeof PYTHON_ROUTE_GROUPS;

export const PYTHON_ROUTE_GROUP_NAMES = Object.keys(PYTHON_ROUTE_GROUPS) as PythonRouteGroup[];
