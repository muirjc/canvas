import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkStandardDefinition } from '@canvas/diagram-core';
import { buildTestApp, closeTestDb, resetDatabase } from '../helpers/setup.js';
import { getDb } from '../../src/db/client.js';
import { seedDiagramTypes } from '../../src/seed/diagram-types.seed.js';
import {
  C4_CONTEXT_STANDARD,
  REFERENCE_STANDARDS,
  VALUE_CHAIN_STANDARD,
  seedReferenceStandards,
} from '../../src/seed/reference-standards.seed.js';
import { createDraftStandard, listStandards, retireStandard } from '../../src/standards/standard.service.js';

/** canvas-tfr: the two published reference standards. */
describe('Reference standards seed', () => {
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

  it('publishes exactly one standard per reference type whose rules equal the exported constants', async () => {
    expect((await seedReferenceStandards()).sort()).toEqual(['c4-context', 'value-chain']);

    for (const [typeId, expected] of [
      ['value-chain', VALUE_CHAIN_STANDARD],
      ['c4-context', C4_CONTEXT_STANDARD],
    ] as const) {
      const standards = await listStandards(typeId);
      expect(standards).toHaveLength(1);
      expect(standards[0].status).toBe('published');
      expect(standards[0].rules).toEqual(expect.objectContaining(expected));
      expect(standards[0].rules.elementKinds).toEqual(expected.elementKinds);
      expect(standards[0].rules.connectorRules).toEqual(expected.connectorRules);
      expect(standards[0].rules.guidance).toBe(expected.guidance);
    }
  });

  it('gives each seeded standard the reference name and description', async () => {
    await seedReferenceStandards();
    for (const ref of REFERENCE_STANDARDS) {
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
    expect(before).toBe(2);
  });

  it('skips a type that has any existing standard, even a retired one', async () => {
    const draft = await createDraftStandard({
      diagramTypeId: 'value-chain',
      rules: { allowedShapeIds: [], mandatoryShapeIds: [], allowedIconLibraryRefs: [], colorPalette: [] },
      name: 'Admin Made',
    });
    await retireStandard(draft.id);

    expect(await seedReferenceStandards()).toEqual(['c4-context']);
    const standards = await listStandards('value-chain');
    expect(standards).toHaveLength(1);
    expect(standards[0].status).toBe('retired');
    expect(standards[0].name).toBe('Admin Made');
  });

  it('skips silently when the diagram type does not exist', async () => {
    await getDb().deleteFrom('diagram_type_palette_libraries').where('diagram_type_id', '=', 'c4-context').execute();
    await getDb().deleteFrom('diagram_types_personas').where('diagram_type_id', '=', 'c4-context').execute();
    await getDb().deleteFrom('diagram_types').where('id', '=', 'c4-context').execute();
    expect(await seedReferenceStandards()).toEqual(['value-chain']);
  });

  it.each([
    ['value-chain', VALUE_CHAIN_STANDARD, 'flowchart'],
    ['c4-context', C4_CONTEXT_STANDARD, 'c4'],
  ] as const)('the %s reference standard passes checkStandardDefinition for the %s family', (_id, rules, family) => {
    expect(checkStandardDefinition(rules, family)).toEqual([]);
  });
});
