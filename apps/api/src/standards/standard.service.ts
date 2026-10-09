import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { StandardRules, IconLibraryRef, ColorPaletteEntry, FontConstraints, NodeShape } from '@canvas/diagram-core';
import { getDb, type DbExecutor } from '../db/client.js';
import { currentTimestamp } from '../db/sql-helpers.js';
import {
  getStandardAllowedShapes,
  getStandardMandatoryShapes,
  getStandardShapesBatch,
  setStandardAllowedShapes,
  setStandardMandatoryShapes,
} from '../db/array-columns.js';

export type StandardStatus = 'draft' | 'published' | 'retired';

export interface StandardRecord {
  id: string;
  diagramTypeId: string;
  version: number;
  /** Human-readable identity. Backfilled for standards created before feature 006, so this is
   *  never absent in practice (FR-021, FR-026). */
  name: string | null;
  /** What the standard is for. Optional — a standard need not elaborate beyond its name. */
  description: string | null;
  status: StandardStatus;
  rules: StandardRules;
  publishedAt: string | null;
  createdAt: string;
  /** Set if and only if the standard has left force (FR-024, FR-025). */
  retiredAt: string | null;
}

export class StandardNotFoundError extends Error {}
export class StandardStateError extends Error {}

interface StandardRow {
  id: string;
  diagram_type_id: string;
  version: number;
  status: StandardStatus;
  allowed_icon_library_refs: IconLibraryRef[];
  color_palette: ColorPaletteEntry[];
  font_constraints: FontConstraints | null;
  name: string | null;
  description: string | null;
  published_at: Date | null;
  created_at: Date;
  retired_at: Date | null;
  kind_rules: Partial<StandardRules> | null;
}

/** Kysely infers `allowed_icon_library_refs`/`color_palette`/`font_constraints` as `unknown` on
 *  select (db/schema.ts's `JsonColumn<unknown>` — the JSONB payload's real shape isn't known
 *  statically). This cast trusts DB content matches `StandardRow` exactly like the pre-Kysely
 *  raw-SQL `pool.query<StandardRow>(...)` generic type parameter always implicitly did — no new
 *  runtime validation added or removed by moving to Kysely. */
function asStandardRow(row: Record<string, unknown>): StandardRow {
  return row as unknown as StandardRow;
}

function toRecord(
  row: StandardRow,
  shapes: { allowed: string[]; mandatory: string[] },
): StandardRecord {
  return {
    id: row.id,
    diagramTypeId: row.diagram_type_id,
    version: row.version,
    status: row.status,
    rules: {
      // The join tables store plain TEXT, not NodeShape — this cast trusts DB content matches the
      // union exactly like the pre-Kysely raw-SQL StandardRow's own generic type parameter always
      // implicitly did (no new runtime validation added or removed here).
      allowedShapeIds: shapes.allowed as NodeShape[],
      mandatoryShapeIds: shapes.mandatory as NodeShape[],
      allowedIconLibraryRefs: row.allowed_icon_library_refs ?? [],
      colorPalette: row.color_palette ?? [],
      fontConstraints: row.font_constraints ?? undefined,
      ...(row.kind_rules ?? {}),
    },
    name: row.name,
    description: row.description,
    // See diagram-chat.service.ts's getChatMessages for why these casts are the pre-existing
    // convention, not a new behavior change — node-postgres always returned a Date here.
    publishedAt: row.published_at as unknown as string | null,
    createdAt: row.created_at as unknown as string,
    retiredAt: row.retired_at as unknown as string | null,
  };
}

/** canvas-tfr: the v2 rule fields, stored together in `standards.kind_rules`. */
const V2_RULE_KEYS = [
  'elementKinds',
  'connectorRules',
  'connectorPolicy',
  'containers',
  'requireKnownKinds',
  'severityOverrides',
  'guidance',
] as const satisfies readonly (keyof StandardRules)[];

function v2RulesJson(rules: StandardRules): string {
  const v2: Partial<StandardRules> = {};
  for (const key of V2_RULE_KEYS) {
    if (rules[key] !== undefined) (v2 as Record<string, unknown>)[key] = rules[key];
  }
  return JSON.stringify(v2);
}

export interface CreateDraftStandardInput {
  diagramTypeId: string;
  rules: StandardRules;
  name?: string;
  description?: string;
}

export async function createDraftStandard(input: CreateDraftStandardInput): Promise<StandardRecord> {
  const db = getDb();
  return db.transaction().execute(async (trx) => {
    const { next_version: nextVersion } = await trx
      .selectFrom('standards')
      .select(sql<number>`COALESCE(MAX(version), 0) + 1`.as('next_version'))
      .where('diagram_type_id', '=', input.diagramTypeId)
      .executeTakeFirstOrThrow();

    const row = await trx
      .insertInto('standards')
      .values({
        id: randomUUID(),
        diagram_type_id: input.diagramTypeId,
        version: nextVersion,
        status: 'draft',
        allowed_icon_library_refs: JSON.stringify(input.rules.allowedIconLibraryRefs),
        color_palette: JSON.stringify(input.rules.colorPalette),
        font_constraints: input.rules.fontConstraints ? JSON.stringify(input.rules.fontConstraints) : null,
        // Fall back to the same derivation the migration used, so no standard is ever nameless.
        name: input.name ?? `${input.diagramTypeId} v${nextVersion}`,
        description: input.description ?? null,
        kind_rules: v2RulesJson(input.rules),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await setStandardAllowedShapes(trx, row.id, input.rules.allowedShapeIds);
    await setStandardMandatoryShapes(trx, row.id, input.rules.mandatoryShapeIds);

    return toRecord(asStandardRow(row), { allowed: input.rules.allowedShapeIds, mandatory: input.rules.mandatoryShapeIds });
  });
}

export interface UpdateDraftStandardInput {
  rules: StandardRules;
  name?: string;
  description?: string | null;
}

/** canvas-tfr: edits a draft in place. Published/retired standards are immutable -- change them by
 *  cloning to a new draft (`cloneStandard`) and publishing that. */
export async function updateDraftStandard(id: string, input: UpdateDraftStandardInput): Promise<StandardRecord> {
  const existing = await getStandardById(id);
  if (existing.status !== 'draft') {
    throw new StandardStateError(`Standard ${id} is "${existing.status}", only "draft" standards can be edited`);
  }
  const db = getDb();
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable('standards')
      .set({
        allowed_icon_library_refs: JSON.stringify(input.rules.allowedIconLibraryRefs),
        color_palette: JSON.stringify(input.rules.colorPalette),
        font_constraints: input.rules.fontConstraints ? JSON.stringify(input.rules.fontConstraints) : null,
        kind_rules: v2RulesJson(input.rules),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await setStandardAllowedShapes(trx, id, input.rules.allowedShapeIds);
    await setStandardMandatoryShapes(trx, id, input.rules.mandatoryShapeIds);
    return toRecord(asStandardRow(row), { allowed: input.rules.allowedShapeIds, mandatory: input.rules.mandatoryShapeIds });
  });
}

/** canvas-tfr: copies any standard (typically the published one) into a new draft at the next
 *  version, so an admin can change a standard without editing the one currently in force. */
export async function cloneStandard(id: string): Promise<StandardRecord> {
  const source = await toRecordWithShapes(await getStandardById(id));
  return createDraftStandard({
    diagramTypeId: source.diagramTypeId,
    rules: source.rules,
    name: `${source.name ?? source.diagramTypeId} (copy)`,
    description: source.description ?? undefined,
  });
}

async function getStandardById(id: string): Promise<StandardRow> {
  const db = getDb();
  const row = await db.selectFrom('standards').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) {
    throw new StandardNotFoundError(`No standard with id ${id}`);
  }
  return asStandardRow(row);
}

/**
 * Takes an optional `DbExecutor` (defaulting to the standalone `getDb()` singleton) so a caller
 * already inside a transaction can pass its own `trx` instead — required, not just tidier:
 * `publishStandard` used to always call this with the implicit standalone `db`, which under
 * Postgres's connection-pooled `pg.Pool` silently ran on a second, independent connection
 * alongside the still-open outer transaction; under SQLite's single-connection `better-sqlite3`,
 * that second query can never acquire the one connection the open transaction is still holding —
 * a real deadlock, confirmed live (every `publishStandard` call hung until Vitest's own test
 * timeout fired).
 */
async function toRecordWithShapes(row: StandardRow, executor: DbExecutor = getDb()): Promise<StandardRecord> {
  const [allowed, mandatory] = await Promise.all([
    getStandardAllowedShapes(executor, row.id),
    getStandardMandatoryShapes(executor, row.id),
  ]);
  return toRecord(row, { allowed, mandatory });
}

/** Publishes a draft Standard, retiring whatever was previously published for its diagram type. */
export async function publishStandard(id: string): Promise<StandardRecord> {
  const row = await getStandardById(id);
  if (row.status !== 'draft') {
    throw new StandardStateError(`Standard ${id} is "${row.status}", only "draft" standards can be published`);
  }

  const db = getDb();
  return db.transaction().execute(async (trx) => {
    // Supersession: the more common way a standard leaves force. Missing retired_at here would
    // leave most retired standards undated (contracts/api-standards-versions.md).
    await trx
      .updateTable('standards')
      .set({ status: 'retired', retired_at: sql<Date>`COALESCE(retired_at, ${currentTimestamp()})` })
      .where('diagram_type_id', '=', row.diagram_type_id)
      .where('status', '=', 'published')
      .execute();
    const published = await trx
      .updateTable('standards')
      .set({ status: 'published', published_at: currentTimestamp() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRecordWithShapes(asStandardRow(published), trx);
  });
}

export async function retireStandard(id: string): Promise<StandardRecord> {
  const db = getDb();
  const row = await db
    .updateTable('standards')
    .set({ status: 'retired', retired_at: sql<Date>`COALESCE(retired_at, ${currentTimestamp()})` })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
  if (!row) {
    throw new StandardNotFoundError(`No standard with id ${id}`);
  }
  return toRecordWithShapes(asStandardRow(row));
}

/** canvas-tfr: one standard by id (any status). */
export async function getStandardRecord(id: string): Promise<StandardRecord> {
  return toRecordWithShapes(await getStandardById(id));
}

export async function getActiveStandard(diagramTypeId: string): Promise<StandardRecord | null> {
  const db = getDb();
  const row = await db
    .selectFrom('standards')
    .selectAll()
    .where('diagram_type_id', '=', diagramTypeId)
    .where('status', '=', 'published')
    .executeTakeFirst();
  return row ? toRecordWithShapes(asStandardRow(row)) : null;
}

export async function listStandards(diagramTypeId: string): Promise<StandardRecord[]> {
  const db = getDb();
  const rows = await db
    .selectFrom('standards')
    .selectAll()
    .where('diagram_type_id', '=', diagramTypeId)
    .orderBy('version', 'desc')
    .execute();
  const { allowed, mandatory } = await getStandardShapesBatch(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) =>
    toRecord(asStandardRow(row), { allowed: allowed.get(row.id) ?? [], mandatory: mandatory.get(row.id) ?? [] }),
  );
}
