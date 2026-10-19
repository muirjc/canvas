import { dslFamilies } from '@canvas/diagram-core';
import { getDb } from '../db/client.js';
import { dbBoolean, fromDbBoolean } from '../db/sql-helpers.js';
import {
  getDiagramTypePaletteLibrariesBatch,
  getDiagramTypePersonasBatch,
  setDiagramTypePaletteLibraries,
  setDiagramTypePersonas,
} from '../db/array-columns.js';
import { BUILTIN_DIAGRAM_TYPE_IDS, PERSONAS } from '../seed/diagram-types.seed.js';

/**
 * canvas-tfr: admin-defined diagram types -- the finer grain below a DSL family that a standard
 * attaches to (e.g. a "Value Chain" or "Process Map" that is a flowchart underneath but has its
 * own rules). Stored in the same `diagram_types` table as the seeded catalog, marked
 * `origin = 'custom'` so the catalog seed never overwrites one.
 */

export class DiagramTypeConflictError extends Error {}
export class DiagramTypeValidationError extends Error {}
export class DiagramTypeNotFoundError extends Error {}

export interface CustomDiagramTypeInput {
  name: string;
  dslFamily: string;
  personas: string[];
  paletteLibraryIds?: string[];
  description?: string | null;
  /** canvas-9ff: PATCH only -- hide/unhide (any type). */
  hidden?: boolean;
}

export interface DiagramTypeRecord {
  id: string;
  name: string;
  personas: string[];
  abstractionLevel: string;
  dslFamily: string;
  defaultPaletteLibraryIds: string[];
  origin: 'builtin' | 'custom';
  /** canvas-chq: a built-in type an admin has edited (the catalog seed no longer updates it). */
  adminEdited: boolean;
  description: string | null;
  /** canvas-9ff: left out of the create pickers; existing diagrams unaffected. */
  hidden: boolean;
}

/** "Process Map (Ops)" -> "process-map-ops". */
export function slugifyDiagramTypeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function validate(input: Partial<CustomDiagramTypeInput>): void {
  if (input.name !== undefined && !input.name.trim()) throw new DiagramTypeValidationError('A diagram type needs a name.');
  if (input.dslFamily !== undefined && !dslFamilies[input.dslFamily]) {
    throw new DiagramTypeValidationError(`Unknown diagram family "${input.dslFamily}" (${Object.keys(dslFamilies).join(', ')}).`);
  }
  if (input.personas !== undefined) {
    if (input.personas.length === 0) throw new DiagramTypeValidationError('Choose at least one persona.');
    const unknown = input.personas.filter((p) => !(PERSONAS as readonly string[]).includes(p));
    if (unknown.length > 0) throw new DiagramTypeValidationError(`Unknown persona(s): ${unknown.join(', ')}.`);
  }
  if (input.hidden !== undefined && typeof input.hidden !== 'boolean') {
    throw new DiagramTypeValidationError('hidden must be true or false.');
  }
}

export async function createCustomDiagramType(input: CustomDiagramTypeInput): Promise<DiagramTypeRecord> {
  validate(input);
  const id = slugifyDiagramTypeName(input.name);
  if (!id) throw new DiagramTypeValidationError('The name needs at least one letter or digit.');
  if ((BUILTIN_DIAGRAM_TYPE_IDS as readonly string[]).includes(id)) {
    throw new DiagramTypeConflictError(`"${input.name}" collides with the built-in diagram type "${id}".`);
  }
  const db = getDb();
  await db.transaction().execute(async (trx) => {
    const existing = await trx.selectFrom('diagram_types').select('id').where('id', '=', id).executeTakeFirst();
    if (existing) throw new DiagramTypeConflictError(`A diagram type with id "${id}" already exists.`);
    await trx
      .insertInto('diagram_types')
      .values({
        id,
        name: input.name.trim(),
        abstraction_level: 'N/A',
        dsl_family: input.dslFamily,
        origin: 'custom',
        description: input.description ?? null,
      })
      .execute();
    await setDiagramTypePersonas(trx, id, input.personas);
    await setDiagramTypePaletteLibraries(trx, id, input.paletteLibraryIds ?? []);
  });
  return getDiagramTypeRecord(id);
}

/** canvas-chq: any type can be edited. A built-in type's family can never change (its catalog
 *  definition, AI primer and tooling are family-specific); a custom type's family is locked once any
 *  diagram uses it (re-familying would leave those diagrams' DSL unparseable). Editing a built-in
 *  type marks it admin_edited so the catalog seed stops overwriting the admin's changes. */
export async function updateDiagramType(
  id: string,
  patch: Partial<CustomDiagramTypeInput>,
): Promise<DiagramTypeRecord> {
  validate(patch);
  const db = getDb();
  const row = await db.selectFrom('diagram_types').select(['origin', 'dsl_family']).where('id', '=', id).executeTakeFirst();
  if (!row) throw new DiagramTypeNotFoundError(`No diagram type with id ${id}`);
  if (row.origin === 'builtin' && patch.dslFamily !== undefined && patch.dslFamily !== row.dsl_family) {
    throw new DiagramTypeConflictError(`"${id}" is a built-in diagram type, so its family can't change.`);
  }
  if (patch.dslFamily !== undefined && patch.dslFamily !== row.dsl_family) {
    const used = await db.selectFrom('diagrams').select('id').where('diagram_type_id', '=', id).executeTakeFirst();
    if (used) throw new DiagramTypeConflictError(`"${id}" already has diagrams, so its family can't change.`);
  }
  // canvas-9ff: hiding isn't editing the type's definition, so it doesn't mark a built-in
  // admin-edited (catalog updates keep reaching it); the catalog seed never touches `hidden`.
  const editsDefinition =
    patch.name !== undefined ||
    patch.dslFamily !== undefined ||
    patch.description !== undefined ||
    patch.personas !== undefined ||
    patch.paletteLibraryIds !== undefined;
  await db.transaction().execute(async (trx) => {
    const set = {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.dslFamily !== undefined ? { dsl_family: patch.dslFamily } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.hidden !== undefined ? { hidden: dbBoolean(patch.hidden) } : {}),
      ...(row.origin === 'builtin' && editsDefinition ? { admin_edited: dbBoolean(true) } : {}),
    };
    if (Object.keys(set).length > 0) await trx.updateTable('diagram_types').set(set).where('id', '=', id).execute();
    if (patch.personas !== undefined) await setDiagramTypePersonas(trx, id, patch.personas);
    if (patch.paletteLibraryIds !== undefined) await setDiagramTypePaletteLibraries(trx, id, patch.paletteLibraryIds);
  });
  return getDiagramTypeRecord(id);
}

export async function getDiagramTypeRecord(id: string): Promise<DiagramTypeRecord> {
  const records = await listDiagramTypeRecords([id]);
  if (records.length === 0) throw new DiagramTypeNotFoundError(`No diagram type with id ${id}`);
  return records[0];
}

/** All diagram types (or just `ids`), ordered by name. */
export async function listDiagramTypeRecords(ids?: string[]): Promise<DiagramTypeRecord[]> {
  const db = getDb();
  let query = db
    .selectFrom('diagram_types')
    .select(['id', 'name', 'abstraction_level', 'dsl_family', 'origin', 'admin_edited', 'description', 'hidden'])
    .orderBy('name');
  if (ids) query = query.where('id', 'in', ids.length > 0 ? ids : ['']);
  const rows = await query.execute();
  const rowIds = rows.map((r) => r.id);
  const [personasByType, paletteLibrariesByType] = await Promise.all([
    getDiagramTypePersonasBatch(db, rowIds),
    getDiagramTypePaletteLibrariesBatch(db, rowIds),
  ]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    personas: personasByType.get(r.id) ?? [],
    abstractionLevel: r.abstraction_level,
    dslFamily: r.dsl_family,
    defaultPaletteLibraryIds: paletteLibrariesByType.get(r.id) ?? [],
    origin: r.origin,
    adminEdited: fromDbBoolean(r.admin_edited),
    description: r.description,
    hidden: fromDbBoolean(r.hidden),
  }));
}

/**
 * canvas-9ff: deletes a custom diagram type no diagram or template uses, with its standards (its
 * persona and palette links cascade). Built-in types can only be hidden -- the catalog seed would
 * recreate a deleted one. A soft-deleted diagram still counts as a use: it can be restored, and its
 * row still references the type.
 */
export async function deleteCustomDiagramType(id: string): Promise<void> {
  const db = getDb();
  const row = await db.selectFrom('diagram_types').select(['origin']).where('id', '=', id).executeTakeFirst();
  if (!row) throw new DiagramTypeNotFoundError(`No diagram type with id ${id}`);
  if (row.origin === 'builtin') {
    throw new DiagramTypeConflictError(`"${id}" is a built-in diagram type and can't be deleted; hide it instead.`);
  }
  const countOf = async (table: 'diagrams' | 'templates') =>
    Number(
      (
        await db
          .selectFrom(table)
          .select((eb) => eb.fn.countAll<string | number>().as('n'))
          .where('diagram_type_id', '=', id)
          .executeTakeFirstOrThrow()
      ).n,
    );
  const [diagrams, templates] = await Promise.all([countOf('diagrams'), countOf('templates')]);
  if (diagrams > 0 || templates > 0) {
    const uses = [
      diagrams > 0 ? `${diagrams} diagram${diagrams === 1 ? '' : 's'}` : '',
      templates > 0 ? `${templates} template${templates === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    throw new DiagramTypeConflictError(
      `"${id}" is used by ${uses.join(' and ')} (deleted diagrams included), so it can't be deleted; hide it instead.`,
    );
  }
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('standards').where('diagram_type_id', '=', id).execute();
    await trx.deleteFrom('diagram_types').where('id', '=', id).execute();
  });
}
