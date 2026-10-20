import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkStandardDefinition, standardDefinitionNotices } from '@canvas/diagram-core';
import { buildTestApp, closeTestDb, resetDatabase, seedProject, seedUser } from '../helpers/setup.js';
import { getDb } from '../../src/db/client.js';
import { seedDiagramTypes } from '../../src/seed/diagram-types.seed.js';
import { BUILT_IN_STANDARDS, REFERENCE_STANDARDS, seedReferenceStandards } from '../../src/seed/reference-standards.seed.js';
import { createDraftStandard, listStandards, retireStandard } from '../../src/standards/standard.service.js';

/** canvas-tfr / canvas-chq: a published standard for every built-in diagram type. */
describe('Built-in standards seed', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedDiagramTypes();
  });

  async function totalStandards(): Promise<number> {
    const row = await getDb().selectFrom('standards').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async function builtInTypeIds(): Promise<string[]> {
    const rows = await getDb().selectFrom('diagram_types').select('id').where('origin', '=', 'builtin').execute();
    return rows.map((r) => r.id);
  }

  it('covers every built-in diagram type exactly once', async () => {
    expect(BUILT_IN_STANDARDS.map((s) => s.diagramTypeId).sort()).toEqual((await builtInTypeIds()).sort());
  });

  it('publishes exactly one standard per built-in type whose rules equal its constant', async () => {
    const seeded = await seedReferenceStandards();
    expect(seeded.sort()).toEqual(BUILT_IN_STANDARDS.map((s) => s.diagramTypeId).sort());

    for (const expected of BUILT_IN_STANDARDS) {
      const standards = await listStandards(expected.diagramTypeId);
      expect(standards, expected.diagramTypeId).toHaveLength(1);
      expect(standards[0].status).toBe('published');
      expect(standards[0].rules).toEqual(expect.objectContaining(expected.rules));
      expect(standards[0].rules.elementKinds).toEqual(expected.rules.elementKinds);
      expect(standards[0].rules.connectorRules).toEqual(expected.rules.connectorRules);
      expect(standards[0].rules.guidance).toBe(expected.rules.guidance);
    }
  });

  it('gives each seeded standard its name and description', async () => {
    await seedReferenceStandards();
    for (const ref of BUILT_IN_STANDARDS) {
      const [standard] = await listStandards(ref.diagramTypeId);
      expect(standard.name).toBe(ref.name);
      expect(standard.description).toBe(ref.description);
    }
  });

  it('is a no-op on the second run', async () => {
    await seedReferenceStandards();
    const before = await totalStandards();
    expect(await seedReferenceStandards()).toEqual([]);
    expect(await totalStandards()).toBe(before);
    expect(before).toBe(BUILT_IN_STANDARDS.length);
  });

  it('skips a type that has any existing standard, even a retired one', async () => {
    const draft = await createDraftStandard({
      diagramTypeId: 'value-chain',
      rules: { allowedShapeIds: [], mandatoryShapeIds: [], allowedIconLibraryRefs: [], colorPalette: [] },
      name: 'Admin Made',
    });
    await retireStandard(draft.id);

    const seeded = await seedReferenceStandards();
    expect(seeded).not.toContain('value-chain');
    expect(seeded).toContain('c4-context');
    const standards = await listStandards('value-chain');
    expect(standards).toHaveLength(1);
    expect(standards[0].status).toBe('retired');
    expect(standards[0].name).toBe('Admin Made');
  });

  it('skips silently when the diagram type does not exist', async () => {
    await getDb().deleteFrom('diagram_type_palette_libraries').where('diagram_type_id', '=', 'c4-context').execute();
    await getDb().deleteFrom('diagram_types_personas').where('diagram_type_id', '=', 'c4-context').execute();
    await getDb().deleteFrom('diagram_types').where('id', '=', 'c4-context').execute();
    const seeded = await seedReferenceStandards();
    expect(seeded).not.toContain('c4-context');
    expect(seeded).toContain('value-chain');
    expect(seeded).toHaveLength(BUILT_IN_STANDARDS.length - 1);
  });

  it('keeps the strict reference standards unchanged: value-chain and c4-context are REFERENCE_STANDARDS', () => {
    expect(REFERENCE_STANDARDS.map((s) => s.diagramTypeId).sort()).toEqual(['c4-context', 'value-chain']);
  });

  it.each(BUILT_IN_STANDARDS.map((s) => [s.diagramTypeId, s] as const))(
    'the %s standard passes checkStandardDefinition for its type family, with no notices',
    async (typeId, standard) => {
      const row = await getDb().selectFrom('diagram_types').select('dsl_family').where('id', '=', typeId).executeTakeFirstOrThrow();
      expect(checkStandardDefinition(standard.rules, row.dsl_family as never)).toEqual([]);
      // canvas-e05: no built-in standard should ship with kinds that shadow each other.
      expect(standardDefinitionNotices(standard.rules, row.dsl_family as never)).toEqual([]);
    },
  );

  describe('starter standards in use', () => {
    let adminCookie: string;
    let architectCookie: string;
    let architectId: string;

    async function login(email: string, password: string): Promise<string> {
      const response = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
      const setCookie = response.headers['set-cookie'];
      return (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
    }

    beforeEach(async () => {
      await seedReferenceStandards();
      await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
      architectId = (await seedUser({ email: 'architect@example.com', password: 'architect-pass', role: 'architect' })).id;
      adminCookie = await login('admin@example.com', 'admin-pass');
      architectCookie = await login('architect@example.com', 'architect-pass');
    });

    async function createDiagram(typeId: string, dsl: string) {
      const project = await seedProject('P', architectId);
      const response = await app.inject({
        method: 'POST',
        url: `/projects/${project.id}/diagrams`,
        headers: { cookie: architectCookie },
        payload: { name: 'D', diagramTypeId: typeId, initialDslContent: dsl },
      });
      expect(response.statusCode).toBe(201);
      return response.json().diagram as { lastValidationResult: Array<{ rule: string; severity: string; elementId: string }> };
    }

    const C4_HEAD = [
      'C4Container',
      '  Person(user, "Customer")',
      '  System_Ext(mail, "Mail System")',
      '  Container(web, "Web App")',
    ];

    it('a well-formed C4 Container diagram has no violations against the c4-container starter', async () => {
      const diagram = await createDiagram(
        'c4-container',
        [...C4_HEAD, '  Rel(user, web, "Uses")', '  Rel(web, mail, "Sends email")', ''].join('\n'),
      );
      expect(diagram.lastValidationResult).toEqual([]);
    });

    it('an unlabelled Rel is flagged connector-label-required as a warning', async () => {
      const diagram = await createDiagram('c4-container', [...C4_HEAD, '  Rel(user, web, "Uses")', '  Rel(web, mail, "")', ''].join('\n'));
      const flagged = diagram.lastValidationResult.filter((v) => v.rule === 'connector-label-required');
      expect(flagged).toHaveLength(1);
      expect(flagged[0].severity).toBe('warning');
    });

    it('revising a published standard (new version from its rules, then publish) retires the previous one', async () => {
      const [original] = await listStandards('c4-context');
      const created = await app.inject({
        method: 'POST',
        url: '/diagram-types/c4-context/standards',
        headers: { cookie: adminCookie },
        payload: { ...original.rules, name: original.name, description: original.description },
      });
      expect(created.statusCode).toBe(201);
      const draft = created.json().standard;
      expect(draft.status).toBe('draft');
      expect(draft.version).toBe(original.version + 1);
      expect(draft.rules.elementKinds).toEqual(original.rules.elementKinds);

      const published = await app.inject({ method: 'POST', url: `/standards/${draft.id}/publish`, headers: { cookie: adminCookie } });
      expect(published.statusCode).toBe(200);

      const all = await listStandards('c4-context');
      const byId = new Map(all.map((s) => [s.id, s]));
      expect(byId.get(draft.id)?.status).toBe('published');
      expect(byId.get(original.id)?.status).toBe('retired');
      expect(all.filter((s) => s.status === 'published')).toHaveLength(1);
    });
  });
});
