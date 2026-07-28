import { getPool } from '../db/pool.js';

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
  created_at: string;
  updated_at: string;
}): AiPersonaRecord {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    systemPrompt: row.system_prompt,
    status: row.status as 'active' | 'archived',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** FR-005: the source for the chat's persona-selection dropdown — active only. */
export async function listActivePersonas(): Promise<AiPersonaRecord[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT * FROM ai_personas WHERE status = 'active' ORDER BY category, name",
  );
  return rows.map(toRecord);
}

/** User Story 3 admin screen: every persona regardless of status, so an admin can see and
 * manage archived ones too, not just what's currently offered in the chat dropdown. */
export async function listAllPersonas(): Promise<AiPersonaRecord[]> {
  const pool = getPool();
  const { rows } = await pool.query('SELECT * FROM ai_personas ORDER BY category, name');
  return rows.map(toRecord);
}

export async function getPersona(id: string): Promise<AiPersonaRecord | undefined> {
  const pool = getPool();
  const { rows } = await pool.query('SELECT * FROM ai_personas WHERE id = $1', [id]);
  return rows[0] ? toRecord(rows[0]) : undefined;
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
  const pool = getPool();
  const { rows } = await pool.query(
    'INSERT INTO ai_personas (name, category, system_prompt) VALUES ($1, $2, $3) RETURNING *',
    [input.name, input.category, input.systemPrompt],
  );
  return toRecord(rows[0]);
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
  const pool = getPool();
  const { rows } = await pool.query(
    'UPDATE ai_personas SET name = $1, category = $2, system_prompt = $3, updated_at = now() WHERE id = $4 RETURNING *',
    [input.name ?? existing.name, input.category ?? existing.category, input.systemPrompt ?? existing.systemPrompt, id],
  );
  return toRecord(rows[0]);
}

/** Archiving is idempotent (User Story 3 acceptance) — an already-archived persona stays
 * archived without error, and any `DiagramChat` already referencing it is untouched (the row
 * itself is never deleted, only its `status`). */
export async function archivePersona(id: string): Promise<AiPersonaRecord | undefined> {
  const pool = getPool();
  const { rows } = await pool.query(
    "UPDATE ai_personas SET status = 'archived', updated_at = now() WHERE id = $1 RETURNING *",
    [id],
  );
  return rows[0] ? toRecord(rows[0]) : undefined;
}
