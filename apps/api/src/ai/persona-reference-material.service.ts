import { getDslFamily } from '@canvas/diagram-core';
import { getPool } from '../db/pool.js';

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

function toRecord(row: {
  id: string;
  persona_id: string;
  content: string;
  diagram_families: string[] | null;
  created_at: string;
  updated_at: string;
}): PersonaReferenceMaterialRecord {
  return {
    id: row.id,
    personaId: row.persona_id,
    content: row.content,
    diagramFamilies: row.diagram_families ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

/** NULL rather than an empty array for "unscoped" — keeps the column's two possible NULL-ish
 *  representations (`NULL` and `'{}'`, both meaning the same thing per the migration's own
 *  comment) collapsed to exactly one on write, so nothing downstream needs to treat them as
 *  distinct. */
function toStoredFamilies(diagramFamilies: string[] | undefined): string[] | null {
  return diagramFamilies && diagramFamilies.length > 0 ? diagramFamilies : null;
}

export async function listReferenceMaterial(personaId: string): Promise<PersonaReferenceMaterialRecord[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM ai_persona_reference_material WHERE persona_id = $1 ORDER BY created_at',
    [personaId],
  );
  return rows.map(toRecord);
}

export async function getReferenceMaterialEntry(
  personaId: string,
  entryId: string,
): Promise<PersonaReferenceMaterialRecord | undefined> {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM ai_persona_reference_material WHERE id = $1 AND persona_id = $2',
    [entryId, personaId],
  );
  return rows[0] ? toRecord(rows[0]) : undefined;
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
  const pool = getPool();
  const { rows } = await pool.query(
    'INSERT INTO ai_persona_reference_material (persona_id, content, diagram_families) VALUES ($1, $2, $3) RETURNING *',
    [personaId, input.content, toStoredFamilies(input.diagramFamilies)],
  );
  return toRecord(rows[0]);
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

  const nextFamilies =
    input.diagramFamilies !== undefined ? toStoredFamilies(input.diagramFamilies) : toStoredFamilies(existing.diagramFamilies);

  const pool = getPool();
  const { rows } = await pool.query(
    'UPDATE ai_persona_reference_material SET content = $1, diagram_families = $2, updated_at = now() WHERE id = $3 AND persona_id = $4 RETURNING *',
    [input.content ?? existing.content, nextFamilies, entryId, personaId],
  );
  return toRecord(rows[0]);
}

/** FR-009: returns `false` (route layer 404s) for an entry that doesn't exist or doesn't belong
 *  to `personaId` — never touches `chat_messages`, matching `archivePersona`'s own precedent of
 *  never retroactively altering past chat turns. */
export async function deleteReferenceMaterial(personaId: string, entryId: string): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    'DELETE FROM ai_persona_reference_material WHERE id = $1 AND persona_id = $2',
    [entryId, personaId],
  );
  return (rowCount ?? 0) > 0;
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
