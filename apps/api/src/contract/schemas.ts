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

export const contractSchemas = [
  {
    $id: 'Error',
    type: 'object',
    required: ['error'],
    additionalProperties: false,
    properties: { error: { type: 'string' }, code: { type: 'string' } },
  },
  {
    $id: 'Project',
    type: 'object',
    required: ['id', 'name', 'parentProjectId', 'createdAt'],
    additionalProperties: false,
    properties: { id: { type: 'string' }, name: { type: 'string' }, parentProjectId: nullable({ type: 'string' }), createdAt: dateTime },
  },
  {
    $id: 'ProjectListItem',
    type: 'object',
    required: ['id', 'name', 'parentProjectId', 'createdAt', 'diagramCount', 'ownerId', 'accessLevel', 'membership'],
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
          properties: { id: { type: 'string' }, name: { type: 'string' }, diagramTypeId: { type: 'string' } },
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
    properties: { id: { type: 'string' }, name: { type: 'string' }, ownerId: { type: 'string' }, deletedAt: dateTime },
  },
  {
    $id: 'DiagramType',
    type: 'object',
    required: ['id', 'name', 'personas', 'abstractionLevel', 'dslFamily', 'defaultPaletteLibraryIds', 'origin', 'adminEdited', 'description', 'hidden'],
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
    properties: { id: { type: 'string' }, version: { type: 'string' }, license: nullable({ type: 'string' }), iconCount: { type: 'integer', minimum: 0 } },
  },
  {
    $id: 'Icon',
    type: 'object',
    required: ['libraryId', 'libraryVersion', 'id', 'displayName', 'keywords', 'category', 'assetRef'],
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
export const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } as const;
