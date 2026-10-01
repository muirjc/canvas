import { getDb } from '../db/client.js';
import { currentTimestamp } from '../db/sql-helpers.js';

/** research.md §4: deliberately NOT named "Persona" — that word already means a simple
 * architect-category tag array on users/diagram_types, an unrelated, pre-existing concept. */
export interface AiPersonaRecord {
  id: string;
  name: string;
  category: string;
  systemPrompt: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export const AI_PERSONA_CATEGORIES = ['Business', 'Enterprise', 'Solution', 'Technical'] as const;
export type AiPersonaCategory = (typeof AI_PERSONA_CATEGORIES)[number];

export class InvalidPersonaCategoryError extends Error {}

function toRecord(row: {
  id: string;
  name: string;
  category: string;
  system_prompt: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}): AiPersonaRecord {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    systemPrompt: row.system_prompt,
    status: row.status as 'active' | 'archived',
    // See diagram-chat.service.ts's getChatMessages for why this cast is the pre-existing
    // convention, not a new behavior change — node-postgres always returned a Date here.
    createdAt: row.created_at as unknown as string,
    updatedAt: row.updated_at as unknown as string,
  };
}

/** FR-005: the source for the chat's persona-selection dropdown — active only. */
export async function listActivePersonas(): Promise<AiPersonaRecord[]> {
  const db = getDb();
  const rows = await db
    .selectFrom('ai_personas')
    .selectAll()
    .where('status', '=', 'active')
    .orderBy('category')
    .orderBy('name')
    .execute();
  return rows.map(toRecord);
}

/** User Story 3 admin screen: every persona regardless of status, so an admin can see and
 * manage archived ones too, not just what's currently offered in the chat dropdown. */
export async function listAllPersonas(): Promise<AiPersonaRecord[]> {
  const db = getDb();
  const rows = await db.selectFrom('ai_personas').selectAll().orderBy('category').orderBy('name').execute();
  return rows.map(toRecord);
}

export async function getPersona(id: string): Promise<AiPersonaRecord | undefined> {
  const db = getDb();
  const row = await db.selectFrom('ai_personas').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? toRecord(row) : undefined;
}

export interface CreatePersonaInput {
  name: string;
  category: string;
  systemPrompt: string;
}

/** User Story 3: admin-authored personas beyond the seeded defaults. Validates `category`
 * up front rather than relying on the DB's CHECK constraint, so callers get a clear 400 instead
 * of a raw constraint-violation error. */
export async function createPersona(input: CreatePersonaInput): Promise<AiPersonaRecord> {
  if (!AI_PERSONA_CATEGORIES.includes(input.category as AiPersonaCategory)) {
    throw new InvalidPersonaCategoryError(`category must be one of: ${AI_PERSONA_CATEGORIES.join(', ')}`);
  }
  const db = getDb();
  const row = await db
    .insertInto('ai_personas')
    .values({ name: input.name, category: input.category, system_prompt: input.systemPrompt })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toRecord(row);
}

export interface UpdatePersonaInput {
  name?: string;
  category?: string;
  systemPrompt?: string;
}

export async function updatePersona(id: string, input: UpdatePersonaInput): Promise<AiPersonaRecord | undefined> {
  if (input.category !== undefined && !AI_PERSONA_CATEGORIES.includes(input.category as AiPersonaCategory)) {
    throw new InvalidPersonaCategoryError(`category must be one of: ${AI_PERSONA_CATEGORIES.join(', ')}`);
  }
  const existing = await getPersona(id);
  if (!existing) return undefined;
  const db = getDb();
  const row = await db
    .updateTable('ai_personas')
    .set({
      name: input.name ?? existing.name,
      category: input.category ?? existing.category,
      system_prompt: input.systemPrompt ?? existing.systemPrompt,
      updated_at: currentTimestamp(),
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
  return toRecord(row);
}

/** Archiving is idempotent (User Story 3 acceptance) — an already-archived persona stays
 * archived without error, and any `DiagramChat` already referencing it is untouched (the row
 * itself is never deleted, only its `status`). */
export async function archivePersona(id: string): Promise<AiPersonaRecord | undefined> {
  const db = getDb();
  const row = await db
    .updateTable('ai_personas')
    .set({ status: 'archived', updated_at: currentTimestamp() })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
  return row ? toRecord(row) : undefined;
}
