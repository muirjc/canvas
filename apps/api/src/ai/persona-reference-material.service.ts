import { randomUUID } from 'node:crypto';
import { getDslFamily } from '@canvas/diagram-core';
import { getDb } from '../db/client.js';
import { currentTimestamp } from '../db/sql-helpers.js';
import {
  getReferenceMaterialFamilies,
  getReferenceMaterialFamiliesBatch,
  setReferenceMaterialFamilies,
} from '../db/array-columns.js';

/**
 * 010-ai-diagram-knowledge, User Story 4 (FR-006, FR-009, FR-010, data-model.md): zero or more
 * admin-curated reference-material entries per persona, each optionally scoped to one or more
 * diagram-type families — composing with, never replacing, a persona's own `systemPrompt`
 * (diagram-chat.service.ts's `buildSystemPrompt`, T031). No status/lifecycle field, unlike
 * `ai_personas`' active/archived — an entry is either present or removed.
 */
export interface PersonaReferenceMaterialRecord {
  id: string;
  personaId: string;
  content: string;
  /** Empty array means unscoped — applies regardless of the diagram's own `dslFamily`. */
  diagramFamilies: string[];
  createdAt: string;
  updatedAt: string;
}

export class InvalidReferenceMaterialContentError extends Error {}
export class InvalidReferenceMaterialFamilyError extends Error {}

/** `diagramFamilies` is supplied separately (from a join-table read, canvas-jtm.3) rather than
 *  read off `row` — `ai_persona_reference_material` itself no longer carries that column. */
function toRecord(
  row: { id: string; persona_id: string; content: string; created_at: Date; updated_at: Date },
  diagramFamilies: string[],
): PersonaReferenceMaterialRecord {
  return {
    id: row.id,
    personaId: row.persona_id,
    content: row.content,
    diagramFamilies,
    // See diagram-chat.service.ts's getChatMessages for why this cast is the pre-existing
    // convention, not a new behavior change — node-postgres always returned a Date here.
    createdAt: row.created_at as unknown as string,
    updatedAt: row.updated_at as unknown as string,
  };
}

/** FR-006: `content` must be non-empty. Checked up front, mirroring `createPersona`'s own
 *  validate-before-insert pattern, rather than relying on a DB NOT NULL/CHECK constraint whose
 *  violation would surface as an opaque 500. */
function validateContent(content: string): void {
  if (content.trim() === '') {
    throw new InvalidReferenceMaterialContentError('content must be non-empty');
  }
}

/** Every value, if given, must be one of `registry.ts`'s registered `dslFamily` ids — mirrors
 *  `createPersona`'s `InvalidPersonaCategoryError` message convention (lists the invalid values,
 *  not just "invalid input"). */
function validateFamilies(diagramFamilies: string[] | undefined): void {
  if (!diagramFamilies) return;
  const invalid = diagramFamilies.filter((id) => !getDslFamily(id));
  if (invalid.length > 0) {
    throw new InvalidReferenceMaterialFamilyError(
      `diagramFamilies must be registered diagram-type family ids, got invalid value(s): ${invalid.join(', ')}`,
    );
  }
}

export async function listReferenceMaterial(personaId: string): Promise<PersonaReferenceMaterialRecord[]> {
  const db = getDb();
  const rows = await db
    .selectFrom('ai_persona_reference_material')
    .selectAll()
    .where('persona_id', '=', personaId)
    .orderBy('created_at')
    .execute();
  const familiesByEntry = await getReferenceMaterialFamiliesBatch(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => toRecord(row, familiesByEntry.get(row.id) ?? []));
}

export async function getReferenceMaterialEntry(
  personaId: string,
  entryId: string,
): Promise<PersonaReferenceMaterialRecord | undefined> {
  const db = getDb();
  const row = await db
    .selectFrom('ai_persona_reference_material')
    .selectAll()
    .where('id', '=', entryId)
    .where('persona_id', '=', personaId)
    .executeTakeFirst();
  if (!row) return undefined;
  return toRecord(row, await getReferenceMaterialFamilies(db, row.id));
}

export interface CreateReferenceMaterialInput {
  content: string;
  diagramFamilies?: string[];
}

export async function createReferenceMaterial(
  personaId: string,
  input: CreateReferenceMaterialInput,
): Promise<PersonaReferenceMaterialRecord> {
  validateContent(input.content);
  validateFamilies(input.diagramFamilies);
  const db = getDb();
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('ai_persona_reference_material')
      .values({ id: randomUUID(), persona_id: personaId, content: input.content })
      .returningAll()
      .executeTakeFirstOrThrow();
    const diagramFamilies = input.diagramFamilies ?? [];
    if (diagramFamilies.length > 0) {
      await setReferenceMaterialFamilies(trx, row.id, diagramFamilies);
    }
    return toRecord(row, diagramFamilies);
  });
}

export interface UpdateReferenceMaterialInput {
  content?: string;
  diagramFamilies?: string[];
}

/** FR-009: edits content/scope in place. No-op (returns `undefined`) for an entry that doesn't
 *  exist or doesn't belong to `personaId` — the route layer turns that into a 404. Never touches
 *  `chat_messages` (existing chat history referencing this persona is unaffected by design, since
 *  reference material is composed into the system prompt fresh on every turn, not persisted into
 *  past messages). */
export async function updateReferenceMaterial(
  personaId: string,
  entryId: string,
  input: UpdateReferenceMaterialInput,
): Promise<PersonaReferenceMaterialRecord | undefined> {
  if (input.content !== undefined) validateContent(input.content);
  if (input.diagramFamilies !== undefined) validateFamilies(input.diagramFamilies);

  const existing = await getReferenceMaterialEntry(personaId, entryId);
  if (!existing) return undefined;

  const nextFamilies = input.diagramFamilies !== undefined ? input.diagramFamilies : existing.diagramFamilies;

  const db = getDb();
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable('ai_persona_reference_material')
      .set({ content: input.content ?? existing.content, updated_at: currentTimestamp() })
      .where('id', '=', entryId)
      .where('persona_id', '=', personaId)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (input.diagramFamilies !== undefined) {
      await setReferenceMaterialFamilies(trx, entryId, nextFamilies);
    }
    return toRecord(row, nextFamilies);
  });
}

/** FR-009: returns `false` (route layer 404s) for an entry that doesn't exist or doesn't belong
 *  to `personaId` — never touches `chat_messages`, matching `archivePersona`'s own precedent of
 *  never retroactively altering past chat turns. `ai_persona_reference_material_families` rows
 *  cascade-delete via the FK (0011_array_columns_to_join_tables.sql), no explicit cleanup needed. */
export async function deleteReferenceMaterial(personaId: string, entryId: string): Promise<boolean> {
  const db = getDb();
  const result = await db
    .deleteFrom('ai_persona_reference_material')
    .where('id', '=', entryId)
    .where('persona_id', '=', personaId)
    .executeTakeFirst();
  return result.numDeletedRows > 0;
}

/** T031 (diagram-chat.service.ts's system-prompt composition): entries scoped to `dslFamily`, or
 *  unscoped, for the given persona — never entries scoped to a *different* family only. */
export async function listReferenceMaterialForFamily(
  personaId: string,
  dslFamily: string,
): Promise<PersonaReferenceMaterialRecord[]> {
  const all = await listReferenceMaterial(personaId);
  return all.filter((entry) => entry.diagramFamilies.length === 0 || entry.diagramFamilies.includes(dslFamily));
}
