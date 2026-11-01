import type { FastifyInstance } from 'fastify';

/**
 * canvas-1bty.6 / canvas-62y: the response shapes of the routes that have moved to the Python
 * service, as shared JSON schemas. They do two jobs:
 * - here, Fastify serializes each response through them and /docs shows them;
 * - the OpenAPI snapshot (apps/api/contract/openapi.json, tests/contract/openapi-snapshot.test.ts)
 *   carries them to the Python service, whose tests check every response against them. So both
 *   services answer the same shapes, whichever one serves a route.
 *
 * Each route group adds its schemas when it moves (docs/python-backend-assessment.md, phase 0a done
 * group by group). `additionalProperties: false` keeps the Python side from sending extra fields.
 * Fastify drops fields a response schema doesn't list, so a schema here must list every field the
 * route really sends.
 */

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
const dateTime = { type: 'string', format: 'date-time' } as const;
const accessLevel = { type: 'string', enum: ['view', 'comment', 'edit', 'manage'] } as const;
const role = { type: 'string', enum: ['admin', 'architect', 'viewer'] } as const;

export const contractSchemas = [
  {
    $id: 'Error',
    type: 'object',
    required: ['error'],
    additionalProperties: false,
    // details: a parse error list (422) or a save conflict's current version (409, code version_conflict).
    properties: { error: { type: 'string' }, code: { type: 'string' }, details: {} },
  },
  {
    $id: 'Project',
    type: 'object',
    required: ['id', 'name', 'parentProjectId', 'createdAt'],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      parentProjectId: nullable({ type: 'string' }),
      createdAt: dateTime,
    },
  },
  {
    $id: 'ProjectListItem',
    type: 'object',
    required: [
      'id',
      'name',
      'parentProjectId',
      'createdAt',
      'diagramCount',
      'ownerId',
      'accessLevel',
      'membership',
    ],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      parentProjectId: nullable({ type: 'string' }),
      createdAt: dateTime,
      diagramCount: { type: 'integer', minimum: 0 },
      ownerId: { type: 'string' },
      accessLevel,
      membership: nullable({ type: 'string', enum: ['owner', 'member'] }),
    },
  },
  {
    $id: 'ProjectTreeNode',
    type: 'object',
    required: ['id', 'name', 'diagrams', 'children'],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      diagrams: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'name', 'diagramTypeId'],
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            diagramTypeId: { type: 'string' },
          },
        },
      },
      children: { type: 'array', items: { $ref: 'ProjectTreeNode#' } },
    },
  },
  {
    $id: 'DeletedProject',
    type: 'object',
    required: ['id', 'name', 'ownerId', 'deletedAt'],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      ownerId: { type: 'string' },
      deletedAt: dateTime,
    },
  },
  {
    $id: 'DiagramType',
    type: 'object',
    required: [
      'id',
      'name',
      'personas',
      'abstractionLevel',
      'dslFamily',
      'defaultPaletteLibraryIds',
      'origin',
      'adminEdited',
      'description',
      'hidden',
    ],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      personas: { type: 'array', items: { type: 'string' } },
      abstractionLevel: { type: 'string' },
      dslFamily: { type: 'string' },
      defaultPaletteLibraryIds: { type: 'array', items: { type: 'string' } },
      origin: { type: 'string', enum: ['builtin', 'custom'] },
      adminEdited: { type: 'boolean' },
      description: nullable({ type: 'string' }),
      hidden: { type: 'boolean' },
    },
  },
  {
    $id: 'LibrarySummary',
    type: 'object',
    required: ['id', 'version', 'license', 'iconCount'],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      version: { type: 'string' },
      license: nullable({ type: 'string' }),
      iconCount: { type: 'integer', minimum: 0 },
    },
  },
  {
    $id: 'Icon',
    type: 'object',
    required: [
      'libraryId',
      'libraryVersion',
      'id',
      'displayName',
      'keywords',
      'category',
      'assetRef',
    ],
    additionalProperties: false,
    properties: {
      libraryId: { type: 'string' },
      libraryVersion: { type: 'string' },
      id: { type: 'string' },
      displayName: { type: 'string' },
      keywords: { type: 'array', items: { type: 'string' } },
      category: { type: 'string' },
      assetRef: { type: 'string' },
    },
  },
  // Phase 3 (canvas-1bty.7): comments, sharing and members, admin users, audit, user lookup.
  {
    $id: 'CommentAuthor',
    type: 'object',
    required: ['id', 'name'],
    additionalProperties: false,
    properties: { id: { type: 'string' }, name: { type: 'string' } },
  },
  {
    $id: 'Comment',
    type: 'object',
    required: ['id', 'threadRootId', 'author', 'body', 'createdAt', 'editedAt', 'deleted'],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      threadRootId: nullable({ type: 'string' }),
      author: { $ref: 'CommentAuthor#' },
      body: { type: 'string' },
      createdAt: dateTime,
      editedAt: nullable(dateTime),
      deleted: { type: 'boolean' },
    },
  },
  {
    $id: 'CommentThread',
    type: 'object',
    required: [
      'id',
      'threadRootId',
      'author',
      'body',
      'createdAt',
      'editedAt',
      'deleted',
      'anchor',
      'resolved',
      'replies',
    ],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      threadRootId: { type: 'null' },
      author: { $ref: 'CommentAuthor#' },
      body: { type: 'string' },
      createdAt: dateTime,
      editedAt: nullable(dateTime),
      deleted: { type: 'boolean' },
      anchor: nullable({
        type: 'object',
        required: ['type', 'id'],
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['node', 'edge', 'container'] },
          id: { type: 'string' },
        },
      }),
      resolved: nullable({
        type: 'object',
        required: ['at', 'by'],
        additionalProperties: false,
        properties: { at: dateTime, by: nullable({ type: 'string' }) },
      }),
      replies: { type: 'array', items: { $ref: 'Comment#' } },
    },
  },
  {
    $id: 'ShareGrant',
    type: 'object',
    required: [
      'id',
      'subjectType',
      'subjectId',
      'granteeUserId',
      'accessLevel',
      'grantedByUserId',
      'createdAt',
    ],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      subjectType: { type: 'string', enum: ['diagram', 'project'] },
      subjectId: { type: 'string' },
      granteeUserId: { type: 'string' },
      accessLevel,
      grantedByUserId: { type: 'string' },
      createdAt: dateTime,
    },
  },
  {
    $id: 'ListedShareGrant',
    type: 'object',
    required: [
      'id',
      'subjectType',
      'subjectId',
      'granteeUserId',
      'accessLevel',
      'grantedByUserId',
      'createdAt',
      'granteeName',
      'granteeEmail',
    ],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      subjectType: { type: 'string', enum: ['diagram', 'project'] },
      subjectId: { type: 'string' },
      granteeUserId: { type: 'string' },
      accessLevel,
      grantedByUserId: { type: 'string' },
      createdAt: dateTime,
      granteeName: nullable({ type: 'string' }),
      granteeEmail: nullable({ type: 'string' }),
    },
  },
  {
    $id: 'SharedDiagram',
    type: 'object',
    required: [
      'diagramId',
      'diagramName',
      'diagramTypeId',
      'projectName',
      'accessLevel',
      'sharedByName',
      'sharedByEmail',
      'sharedAt',
    ],
    additionalProperties: false,
    properties: {
      diagramId: { type: 'string' },
      diagramName: { type: 'string' },
      diagramTypeId: { type: 'string' },
      projectName: { type: 'string' },
      accessLevel,
      sharedByName: { type: 'string' },
      sharedByEmail: { type: 'string' },
      sharedAt: dateTime,
    },
  },
  {
    $id: 'ProjectMembers',
    type: 'object',
    required: ['owner', 'members'],
    additionalProperties: false,
    properties: {
      owner: {
        type: 'object',
        required: ['id', 'name', 'email'],
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          name: nullable({ type: 'string' }),
          email: nullable({ type: 'string' }),
        },
      },
      members: {
        type: 'array',
        items: {
          type: 'object',
          required: ['grantId', 'userId', 'name', 'email', 'accessLevel'],
          additionalProperties: false,
          properties: {
            grantId: { type: 'string' },
            userId: { type: 'string' },
            name: nullable({ type: 'string' }),
            email: nullable({ type: 'string' }),
            accessLevel,
          },
        },
      },
      // GET /projects/:id/members only: the caller's own access (may they manage?).
      yourAccess: accessLevel,
    },
  },
  {
    $id: 'AdminUser',
    type: 'object',
    required: [
      'id',
      'name',
      'email',
      'role',
      'personas',
      'active',
      'hasPassword',
      'locked',
      'mfaEnabled',
    ],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      email: { type: 'string' },
      role,
      personas: { type: 'array', items: { type: 'string' } },
      active: { type: 'boolean' },
      hasPassword: { type: 'boolean' },
      locked: { type: 'boolean' },
      mfaEnabled: { type: 'boolean' },
    },
  },
  {
    $id: 'UpdatedUser',
    type: 'object',
    required: ['id', 'name', 'email', 'role', 'personas', 'active'],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      email: { type: 'string' },
      role,
      personas: { type: 'array', items: { type: 'string' } },
      active: { type: 'boolean' },
    },
  },
  {
    $id: 'AuditEvent',
    type: 'object',
    required: ['id', 'occurredAt', 'event', 'actorEmail', 'targetEmail', 'ip', 'detail'],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      occurredAt: dateTime,
      event: { type: 'string' },
      actorEmail: nullable({ type: 'string' }),
      targetEmail: nullable({ type: 'string' }),
      ip: nullable({ type: 'string' }),
      // Free-form per event (audit.service.ts AuditEvent).
      detail: nullable({ type: 'object', additionalProperties: true }),
    },
  },
  {
    $id: 'UserSummary',
    type: 'object',
    required: ['id', 'name', 'email'],
    additionalProperties: false,
    properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' } },
  },
  // Phase 4 (canvas-1bty.8): diagrams.
  {
    $id: 'Diagram',
    type: 'object',
    required: [
      'id',
      'name',
      'description',
      'diagramTypeId',
      'dslFamily',
      'projectId',
      'ownerId',
      'ownerName',
      'dslContent',
      'lastValidationResult',
      'standardVersionAtLastCheck',
      'currentVersionId',
      'createdAt',
      'updatedAt',
      'draft',
    ],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      description: nullable({ type: 'string' }),
      diagramTypeId: { type: 'string' },
      dslFamily: { type: 'string' },
      projectId: { type: 'string' },
      ownerId: { type: 'string' },
      ownerName: { type: 'string' },
      dslContent: { type: 'string' },
      // diagram-core Violation objects, as the validator returns them.
      lastValidationResult: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
      standardVersionAtLastCheck: nullable({ type: 'integer' }),
      currentVersionId: { type: 'string' },
      createdAt: dateTime,
      updatedAt: dateTime,
      draft: { type: 'boolean' },
      // GET /diagrams/:id only: the caller's own access.
      accessLevel,
    },
  },
  {
    $id: 'DiagramSummary',
    type: 'object',
    required: ['id', 'name', 'diagramTypeId', 'projectId', 'updatedAt'],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      diagramTypeId: { type: 'string' },
      projectId: { type: 'string' },
      updatedAt: dateTime,
    },
  },
  {
    $id: 'DeletedDiagram',
    type: 'object',
    required: ['id', 'name', 'ownerId', 'ownerName', 'projectId', 'projectName', 'deletedAt'],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      ownerId: { type: 'string' },
      ownerName: { type: 'string' },
      projectId: { type: 'string' },
      projectName: { type: 'string' },
      deletedAt: dateTime,
    },
  },
  {
    $id: 'DiagramVersion',
    type: 'object',
    required: [
      'id',
      'sequenceNumber',
      'authorId',
      'authorName',
      'createdAt',
      'restoredFromSequence',
    ],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      sequenceNumber: { type: 'integer', minimum: 1 },
      authorId: { type: 'string' },
      authorName: { type: 'string' },
      createdAt: dateTime,
      restoredFromSequence: nullable({ type: 'integer' }),
      // GET /diagrams/:id/versions/:versionId only.
      dslContent: { type: 'string' },
    },
  },
  {
    $id: 'OtherEditor',
    type: 'object',
    required: ['userId', 'name', 'since', 'isYou'],
    additionalProperties: false,
    properties: {
      userId: { type: 'string' },
      name: { type: 'string' },
      since: dateTime,
      isYou: { type: 'boolean' },
    },
  },
  {
    $id: 'AppSettings',
    type: 'object',
    required: ['sharingEnabled'],
    additionalProperties: false,
    properties: { sharingEnabled: { type: 'boolean' } },
  },
] as const;

export function registerContractSchemas(app: FastifyInstance): void {
  for (const schema of contractSchemas) app.addSchema(schema);
}

/** `{ <key>: <shared schema> }`, the usual `{ project: {...} }` envelope. */
export const envelope = (key: string, ref: string) => ({
  type: 'object',
  required: [key],
  additionalProperties: false,
  properties: { [key]: { $ref: `${ref}#` } },
});

export const listEnvelope = (key: string, ref: string) => ({
  type: 'object',
  required: [key],
  additionalProperties: false,
  properties: { [key]: { type: 'array', items: { $ref: `${ref}#` } } },
});

export const errorResponse = { $ref: 'Error#' } as const;
export const noContent = { type: 'null', description: 'No content' } as const;
/** An inline object response: `{ a: <schema>, ... }`, every key required. */
export const objectResponse = (properties: Record<string, unknown>) => ({
  type: 'object',
  required: Object.keys(properties),
  additionalProperties: false,
  properties,
});

export const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
} as const;
