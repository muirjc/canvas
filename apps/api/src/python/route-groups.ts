/**
 * canvas-1bty.6: the routes the Python service answers, by group, as "METHOD /fastify/route/:pattern".
 *
 * Each group's TypeScript routes stay registered for one release as the fallback: setting
 * PYTHON_ROUTE_GROUPS to leave a group out (or to "none") sends it back to TypeScript with no
 * deploy. Every route listed here must be in the API contract snapshot (apps/api/contract/openapi.json,
 * checked by tests/contract/openapi-snapshot.test.ts), which the Python tests hold their responses to.
 */
export const PYTHON_ROUTE_GROUPS = {
  // Phase 2 (canvas-1bty.6).
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
  'diagram-types': [
    'GET /diagram-types',
    'POST /admin/diagram-types',
    'PATCH /admin/diagram-types/:id',
    'DELETE /admin/diagram-types/:id',
  ],
  // POST /libraries (loading a built-in library, used by the catalog seed) stays with library admin.
  libraries: ['GET /libraries', 'GET /libraries/:id/versions/:version/icons', 'GET /icons/search'],
  'app-settings': ['GET /app-settings', 'PATCH /admin/app-settings'],
  // Phase 3 (canvas-1bty.7). Local accounts (create with a one-time password, reset password or
  // two-step verification, unlock) move with the rest of sign-in in phase 9.
  comments: [
    'GET /diagrams/:id/comments',
    'GET /diagrams/:id/comments/unread',
    'POST /diagrams/:id/comments/read',
    'POST /diagrams/:id/comments',
    'PATCH /diagrams/:id/comments/:commentId',
    'DELETE /diagrams/:id/comments/:commentId',
    'POST /diagrams/:id/comments/:commentId/resolve',
    'POST /diagrams/:id/comments/:commentId/reopen',
  ],
  sharing: [
    'POST /diagrams/:id/shares',
    'GET /diagrams/:id/shares',
    'POST /projects/:id/shares',
    'GET /projects/:id/shares',
    'GET /shared-diagrams',
    'DELETE /shares/:id',
    'GET /projects/:id/members',
    'POST /projects/:id/owner',
  ],
  'admin-users': [
    'GET /admin/users',
    'PATCH /admin/users/:id',
    'GET /admin/users/:id/deletion-impact',
    'DELETE /admin/users/:id',
    'GET /admin/audit',
    'GET /admin/overview',
    'GET /users/lookup',
    'GET /users/search',
  ],
  // Phase 4 (canvas-1bty.8). Parsing, validation and template compiling go through the diagram-core bridge.
  diagrams: [
    'POST /projects/:projectId/diagrams',
    'GET /projects/:projectId/diagrams',
    'POST /projects/:projectId/diagrams/import',
    'POST /projects/:projectId/diagrams/import-template',
    'GET /diagrams/:id',
    'PATCH /diagrams/:id',
    'PATCH /diagrams/:id/name',
    'PATCH /diagrams/:id/description',
    'PATCH /diagrams/:id/project',
    'GET /diagrams/:id/versions',
    'GET /diagrams/:id/versions/:versionId',
    'POST /diagrams/:id/versions/:versionId/restore',
    'PUT /diagrams/:id/presence',
    'POST /diagrams/:id/presence/leave',
    'DELETE /diagrams/:id',
    'GET /admin/deleted-diagrams',
    'POST /diagrams/:id/restore',
  ],
  // Phase 5 (canvas-1bty.9). Publishing or retiring re-checks every diagram of the type afterwards.
  standards: [
    'GET /diagram-types/:id/standard',
    'GET /diagram-types/:id/standards',
    'POST /diagram-types/:id/standards',
    'PUT /standards/:id',
    'POST /standards/:id/clone',
    'POST /standards/:id/publish',
    'POST /standards/:id/retire',
  ],
  // Phase 6 (canvas-1bty.10). SVG through the diagram-core bridge, PNG with resvg-py (the same Rust
  // renderer as @resvg/resvg-js; pixel-identical output).
  export: ['GET /diagrams/:id/export'],
} as const satisfies Record<string, readonly string[]>;

export type PythonRouteGroup = keyof typeof PYTHON_ROUTE_GROUPS;

export const PYTHON_ROUTE_GROUP_NAMES = Object.keys(PYTHON_ROUTE_GROUPS) as PythonRouteGroup[];
