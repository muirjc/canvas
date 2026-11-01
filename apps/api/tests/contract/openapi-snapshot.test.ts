import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { dslFamilies } from '@canvas/diagram-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { PYTHON_ROUTE_GROUPS } from '../../src/python/route-groups.js';
import { BUILTIN_DIAGRAM_TYPE_IDS, PERSONAS } from '../../src/seed/diagram-types.seed.js';
import { closeTestDb } from '../helpers/setup.js';

/**
 * canvas-1bty.6 (phase 0a, done route group by route group): the API contract the Python service is
 * held to, as checked-in files in apps/api/contract/:
 * - openapi.json: the OpenAPI operations of every route that has moved to Python, with their
 *   request and response schemas. The Python tests check each response against it.
 * - constants.json: catalog values the moved routes validate against (diagram families, personas,
 *   built-in diagram type ids), so the Python copies can't drift.
 *
 * A change to a moved route's shape fails here until the files are regenerated:
 *   UPDATE_CONTRACT=1 npx vitest run tests/contract/openapi-snapshot.test.ts
 * and then the Python side has to agree (apps/api-py tests).
 */

const CONTRACT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contract');

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** "PATCH /projects/:id" -> ["patch", "/projects/{id}"], the OpenAPI document's keys. */
function openApiKey(route: string): [string, string] {
  const [method, path] = route.split(' ');
  return [method.toLowerCase(), path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')];
}

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

function referencedSchemas(value: Json, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => referencedSchemas(v, out));
  else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (key === '$ref' && typeof v === 'string') out.add(v.replace('#/components/schemas/', ''));
      else referencedSchemas(v, out);
    }
  }
  return out;
}

const write = (value: Json) => JSON.stringify(sortKeys(value), null, 2) + '\n';

function checkOrUpdate(file: string, content: string): void {
  const path = join(CONTRACT_DIR, file);
  if (process.env.UPDATE_CONTRACT === '1') {
    writeFileSync(path, content);
    return;
  }
  let current = '';
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    // missing: fails below with the same hint
  }
  expect(current, `apps/api/contract/${file} is out of date: UPDATE_CONTRACT=1 npx vitest run tests/contract/openapi-snapshot.test.ts`).toBe(content);
}

describe('API contract snapshot for the routes moved to Python (canvas-1bty.6)', () => {
  let app: FastifyInstance;
  let document: { paths: Record<string, Record<string, Json>>; components: { schemas: Record<string, Json> } };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    await runMigrations();
    app = await buildApp({ config: { ...loadConfig(), enableApiDocs: true }, logger: false });
    await app.ready();
    document = app.swagger() as unknown as typeof document;
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const moved = Object.values(PYTHON_ROUTE_GROUPS).flat();

  it.each(moved)('%s has a success response schema', (route) => {
    const [method, path] = openApiKey(route);
    const operation = document.paths[path]?.[method] as { responses?: Record<string, { content?: unknown; description?: string }> } | undefined;
    expect(operation, `${route} is not in the OpenAPI document`).toBeDefined();
    const success = Object.entries(operation!.responses ?? {}).filter(([status]) => status.startsWith('2'));
    expect(success.length, `${route} has no 2xx response schema`).toBeGreaterThan(0);
    for (const [status, response] of success) {
      if (status !== '204') expect(response.content, `${route} ${status} has no body schema`).toBeDefined();
    }
  });

  it('matches apps/api/contract/openapi.json', () => {
    const paths: Record<string, Record<string, Json>> = {};
    for (const route of moved) {
      const [method, path] = openApiKey(route);
      (paths[path] ??= {})[method] = document.paths[path][method];
    }
    const wanted = referencedSchemas(paths as Json);
    // Shared schemas can refer to each other (a tree node's children).
    for (let grew = true; grew; ) {
      const before = wanted.size;
      for (const name of [...wanted]) referencedSchemas(document.components.schemas[name], wanted);
      grew = wanted.size > before;
    }
    const schemas = Object.fromEntries([...wanted].sort().map((name) => [name, document.components.schemas[name]]));
    checkOrUpdate('openapi.json', write({ openapi: '3.0.3', info: { title: 'Canvas API contract (routes moved to Python)', version: '1' }, paths, components: { schemas } }));
  });

  it('matches apps/api/contract/constants.json', () => {
    checkOrUpdate(
      'constants.json',
      write({ builtinDiagramTypeIds: [...BUILTIN_DIAGRAM_TYPE_IDS], dslFamilies: Object.keys(dslFamilies), personas: [...PERSONAS] }),
    );
  });
});
