import { randomUUID } from 'node:crypto';
import { createEmptyDiagramModel, getDslFamily, validate, type DiagramModel, type ParseError } from '@canvas/diagram-core';
import { getDb } from '../db/client.js';
import { caseInsensitiveLike, toDate } from '../db/sql-helpers.js';
import { recordDiagramVersion } from './version.service.js';
import { getActiveStandard } from '../standards/standard.service.js';
import type { Violation } from '@canvas/diagram-core';

export interface DiagramRecord {
  id: string;
  name: string;
  /** canvas-hbk: a few lines of free text describing what the diagram represents — distinct from
   *  Mermaid's inline `%%` comments, which live inside the DSL body. Null until an architect sets
   *  one; never backfilled with a guess. */
  description: string | null;
  diagramTypeId: string;
  /** The DSL family (e.g. "c4", "architecture") this diagram type serializes to — not the
   * diagram type id itself, which callers must not confuse with it (they only coincide for
   * "flowchart"). */
  dslFamily: string;
  projectId: string;
  ownerId: string;
  /** canvas-hbk: resolved from owner_id — the diagrams table only stores the UUID, and the
   *  client has no way to resolve it itself (same "can't identify who" gap canvas-23t.3 already
   *  fixed for Deleted Diagrams). */
  ownerName: string;
  dslContent: string;
  lastValidationResult: Violation[];
  /** canvas-tfr: version of the standard `lastValidationResult` was computed against (null = none),
   *  so the editor can tell when its loaded standard is out of date. */
  standardVersionAtLastCheck: number | null;
  createdAt: string;
  updatedAt: string;
}

export class DslValidationError extends Error {
  constructor(public readonly errors: ParseError[]) {
    super('DSL could not be parsed');
  }
}

export class DiagramNotFoundError extends Error {}
export class UnknownDiagramTypeError extends Error {}
export class DiagramRetentionExpiredError extends Error {}

/** Soft-deleted diagrams older than this are no longer restorable (FR-013/FR-015, feature 002). */
export const DIAGRAM_RETENTION_DAYS = 30;

/** App-computed retention boundary (canvas-jtm.4) — replaces `now() - make_interval(days => $n)`,
 *  a Postgres-specific function with no SQLite equivalent. Computed once per call rather than
 *  cached, matching the original SQL expression's own "evaluated fresh every query" behavior. */
function retentionBoundary(): Date {
  return new Date(Date.now() - DIAGRAM_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

export async function loadDiagramTypeDslFamily(diagramTypeId: string): Promise<string> {
  const db = getDb();
  const row = await db.selectFrom('diagram_types').select('dsl_family').where('id', '=', diagramTypeId).executeTakeFirst();
  if (!row) {
    throw new UnknownDiagramTypeError(`Unknown diagram type: ${diagramTypeId}`);
  }
  return row.dsl_family;
}

function parseOrThrow(dslFamilyId: string, dslContent: string): DiagramModel {
  const family = getDslFamily(dslFamilyId);
  if (!family) {
    throw new UnknownDiagramTypeError(`No DSL family registered for: ${dslFamilyId}`);
  }
  const result = family.parse(dslContent);
  if ('errors' in result) {
    throw new DslValidationError(result.errors);
  }
  return result.model;
}

/**
 * Validates a parsed diagram against its diagram type's active Standard, if one exists.
 * Soft-flag only (FR-024): the caller never blocks a save/export on the result, it's purely
 * informational for the UI.
 */
async function computeValidation(diagramTypeId: string, model: DiagramModel): Promise<{
  violations: Violation[];
  standardVersion: number | null;
}> {
  const standard = await getActiveStandard(diagramTypeId);
  if (!standard) return { violations: [], standardVersion: null };
  return { violations: validate(model, standard.rules), standardVersion: standard.version };
}

export interface CreateDiagramInput {
  name: string;
  diagramTypeId: string;
  projectId: string;
  ownerId: string;
  /** If omitted, a valid empty diagram for the type's DSL family is generated (never a hardcoded
   * "flowchart TD" — that would fail to parse for a C4/sequence/ERD/UML/architecture diagram). */
  initialDslContent?: string;
}

export async function createDiagram(input: CreateDiagramInput): Promise<DiagramRecord> {
  const dslFamilyId = await loadDiagramTypeDslFamily(input.diagramTypeId);
  const family = getDslFamily(dslFamilyId);
  if (!family) {
    throw new UnknownDiagramTypeError(`No DSL family registered for: ${dslFamilyId}`);
  }
  const initialDslContent =
    input.initialDslContent ?? family.serialize(createEmptyDiagramModel(input.diagramTypeId));
  const model = parseOrThrow(dslFamilyId, initialDslContent);
  const { violations, standardVersion } = await computeValidation(input.diagramTypeId, model);

  const db = getDb();
  const diagramId = await db.transaction().execute(async (trx) => {
    const diagram = await trx
      .insertInto('diagrams')
      .values({
        id: randomUUID(),
        name: input.name,
        diagram_type_id: input.diagramTypeId,
        project_id: input.projectId,
        owner_id: input.ownerId,
        last_validation_result: JSON.stringify(violations),
        standard_version_at_last_check: standardVersion,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const versionId = await recordDiagramVersion(trx, {
      diagramId: diagram.id,
      dslContent: initialDslContent,
      authorId: input.ownerId,
    });

    await trx.updateTable('diagrams').set({ current_version_id: versionId }).where('id', '=', diagram.id).execute();
    return diagram.id;
  });
  // canvas-hbk: re-fetches rather than hand-assembling the record, so createDiagram picks up
  // ownerName resolution (and description's null default) via the same single code path getDiagram
  // already has, instead of a second copy of that mapping logic.
  return getDiagram(diagramId);
}

export async function getDiagram(id: string): Promise<DiagramRecord> {
  const db = getDb();
  const row = await db
    .selectFrom('diagrams as d')
    .innerJoin('diagram_versions as v', 'v.id', 'd.current_version_id')
    .innerJoin('diagram_types as dt', 'dt.id', 'd.diagram_type_id')
    .leftJoin('users as u', 'u.id', 'd.owner_id')
    .select([
      'd.id',
      'd.name',
      'd.description',
      'd.diagram_type_id',
      'dt.dsl_family',
      'd.project_id',
      'd.owner_id',
      'u.name as owner_name',
      'd.last_validation_result',
      'd.standard_version_at_last_check',
      'd.created_at',
      'd.updated_at',
      'v.dsl_content',
    ])
    .where('d.id', '=', id)
    .where('d.deleted_at', 'is', null)
    .executeTakeFirst();
  if (!row) {
    throw new DiagramNotFoundError(`No diagram with id ${id}`);
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    diagramTypeId: row.diagram_type_id,
    dslFamily: row.dsl_family,
    projectId: row.project_id,
    ownerId: row.owner_id,
    ownerName: row.owner_name ?? '(unknown)',
    dslContent: row.dsl_content,
    // Kysely infers this JSONB column as `unknown` on select (db/schema.ts's `JsonColumn<unknown>`)
    // — this cast trusts DB content matches `Violation[]` exactly like the pre-Kysely raw-SQL
    // `pool.query<DiagramRow>(...)` generic type parameter always implicitly did.
    lastValidationResult: row.last_validation_result as unknown as Violation[],
    standardVersionAtLastCheck: row.standard_version_at_last_check ?? null,
    // See diagram-chat.service.ts's getChatMessages for why these casts are the pre-existing
    // convention, not a new behavior change — node-postgres always returned a Date here.
    createdAt: row.created_at as unknown as string,
    updatedAt: row.updated_at as unknown as string,
  };
}

export interface SaveDiagramInput {
  dslContent: string;
  authorId: string;
}

/** Saves a new version of a diagram. Never blocks on standards violations (FR-024). */
export async function saveDiagram(id: string, input: SaveDiagramInput): Promise<DiagramRecord> {
  const existing = await getDiagram(id);
  const dslFamilyId = await loadDiagramTypeDslFamily(existing.diagramTypeId);
  const model = parseOrThrow(dslFamilyId, input.dslContent);
  const { violations, standardVersion } = await computeValidation(existing.diagramTypeId, model);

  const db = getDb();
  await db.transaction().execute(async (trx) => {
    const versionId = await recordDiagramVersion(trx, {
      diagramId: id,
      dslContent: input.dslContent,
      authorId: input.authorId,
    });

    await trx
      .updateTable('diagrams')
      .set({
        current_version_id: versionId,
        updated_at: new Date(),
        last_validation_result: JSON.stringify(violations),
        standard_version_at_last_check: standardVersion,
      })
      .where('id', '=', id)
      .execute();
  });

  return getDiagram(id);
}

/**
 * Moves a diagram to a different project (canvas-228.3). Access (edit on the diagram, edit on
 * the destination project) is enforced by the route, not here — this function trusts its caller.
 * No versioning/soft-delete implications: the diagram's own history and identity are unchanged,
 * only which project's tree it appears in.
 */
export async function moveDiagram(id: string, destinationProjectId: string): Promise<DiagramRecord> {
  const db = getDb();
  const row = await db.selectFrom('diagrams').select('id').where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
  if (!row) {
    throw new DiagramNotFoundError(`No diagram with id ${id}`);
  }
  await db.updateTable('diagrams').set({ project_id: destinationProjectId }).where('id', '=', id).execute();
  return getDiagram(id);
}

/**
 * Renames a diagram (canvas-8x1). Access (edit on the diagram) is enforced by the route, not
 * here — this function trusts its caller, mirroring moveDiagram above. No versioning
 * implications: the name lives on the diagrams row itself, not in diagram_versions, so renaming
 * doesn't touch history or the current DSL content.
 */
export async function renameDiagram(id: string, name: string): Promise<DiagramRecord> {
  const db = getDb();
  const row = await db.selectFrom('diagrams').select('id').where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
  if (!row) {
    throw new DiagramNotFoundError(`No diagram with id ${id}`);
  }
  await db.updateTable('diagrams').set({ name }).where('id', '=', id).execute();
  return getDiagram(id);
}

/**
 * Sets a diagram's free-text description (canvas-hbk), mirroring renameDiagram exactly — same
 * access model (enforced by the route, not here), same no-versioning-implications shape. Unlike
 * name, an empty string is valid (clears the description back to "none set") rather than being
 * rejected — a diagram is never required to carry a description the way it's required to carry
 * a name.
 */
export async function updateDiagramDescription(id: string, description: string): Promise<DiagramRecord> {
  const db = getDb();
  const row = await db.selectFrom('diagrams').select('id').where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
  if (!row) {
    throw new DiagramNotFoundError(`No diagram with id ${id}`);
  }
  await db
    .updateTable('diagrams')
    .set({ description: description || null })
    .where('id', '=', id)
    .execute();
  return getDiagram(id);
}

/**
 * Soft-deletes a diagram (FR-011/FR-012). Idempotent: deleting an already-deleted diagram
 * succeeds silently rather than erroring, since the end state the caller wants ("this diagram
 * is deleted") already holds.
 */
export async function deleteDiagram(id: string, deletedByUserId: string): Promise<void> {
  const db = getDb();
  const row = await db.selectFrom('diagrams').select('id').where('id', '=', id).executeTakeFirst();
  if (!row) {
    throw new DiagramNotFoundError(`No diagram with id ${id}`);
  }
  await db
    .updateTable('diagrams')
    .set((eb) => ({
      deleted_at: eb.fn.coalesce('deleted_at', eb.val(new Date())),
      deleted_by_user_id: eb.fn.coalesce('deleted_by_user_id', eb.val(deletedByUserId)),
    }))
    .where('id', '=', id)
    .execute();
}

export interface DeletedDiagramSummary {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  projectId: string;
  projectName: string;
  deletedAt: string;
}

/** How many deleted diagrams a listing returns when the caller does not say (canvas-23t.3) — a
 *  display/transfer default only, mirroring version.service.ts's own DEFAULT_VERSION_LIMIT
 *  pattern; nothing is ever hidden permanently, just reachable by search beyond this. */
export const DEFAULT_DELETED_DIAGRAMS_LIMIT = 20;

export interface ListDeletedDiagramsOptions {
  limit?: number;
  /** Matches diagram, owner, or project name (canvas-23t.3). */
  search?: string;
}

export interface DeletedDiagramsPage {
  diagrams: DeletedDiagramSummary[];
  hasMore: boolean;
}

/**
 * Admin-only, metadata-only listing of soft-deleted diagrams still within their retention window
 * (FR-020). Resolves owner/project names via a join rather than leaving the caller to resolve
 * them client-side against an already-fetched *active* project/user list (canvas-23t.3) — a
 * diagram's project (or, less commonly, its owner) can itself be soft-deleted later, which would
 * silently drop it from any such active-only list, making exactly the diagrams most in need of
 * identification the ones a client-side lookup would fail to resolve. LEFT JOIN defensively:
 * both users and projects are soft-delete-only in this schema (the row always still exists), so
 * an unmatched join is not expected, but the fallback avoids a crash/blank row over an admin
 * screen if that invariant is ever violated.
 */
export async function listDeletedDiagrams(options: ListDeletedDiagramsOptions = {}): Promise<DeletedDiagramsPage> {
  const db = getDb();
  const limit = Math.max(1, options.limit ?? DEFAULT_DELETED_DIAGRAMS_LIMIT);
  const search = options.search?.trim();

  let query = db
    .selectFrom('diagrams as d')
    .leftJoin('users as u', 'u.id', 'd.owner_id')
    .leftJoin('projects as p', 'p.id', 'd.project_id')
    .where('d.deleted_at', 'is not', null)
    .where('d.deleted_at', '>', retentionBoundary());
  if (search) {
    const pattern = `%${search}%`;
    query = query.where((eb) =>
      eb.or([
        caseInsensitiveLike(eb.ref('d.name'), pattern),
        caseInsensitiveLike(eb.ref('u.name'), pattern),
        caseInsensitiveLike(eb.ref('p.name'), pattern),
      ]),
    );
  }

  // Fetch one extra row to learn whether more exist, without a second COUNT query.
  const rows = await query
    .select(['d.id', 'd.name', 'd.owner_id', 'u.name as owner_name', 'd.project_id', 'p.name as project_name', 'd.deleted_at'])
    .orderBy('d.deleted_at', 'desc')
    .limit(limit + 1)
    .execute();

  const hasMore = rows.length > limit;
  return {
    diagrams: rows.slice(0, limit).map((r) => ({
      id: r.id,
      name: r.name,
      ownerId: r.owner_id,
      ownerName: r.owner_name ?? '(unknown)',
      projectId: r.project_id,
      projectName: r.project_name ?? '(unknown)',
      deletedAt: r.deleted_at as unknown as string,
    })),
    hasMore,
  };
}

/** Restores a soft-deleted diagram within its retention window, recording who/when (FR-014/FR-021). */
export async function restoreDiagram(id: string, restoredByUserId: string): Promise<void> {
  const db = getDb();
  const row = await db.selectFrom('diagrams').select('deleted_at').where('id', '=', id).executeTakeFirst();
  if (!row || row.deleted_at === null) {
    throw new DiagramNotFoundError(`No soft-deleted diagram with id ${id}`);
  }
  if (!(toDate(row.deleted_at) > retentionBoundary())) {
    throw new DiagramRetentionExpiredError(
      "This diagram's recovery window has passed and it is no longer available.",
    );
  }

  await db
    .updateTable('diagrams')
    .set({ deleted_at: null, deleted_by_user_id: null, restored_at: new Date(), restored_by_user_id: restoredByUserId })
    .where('id', '=', id)
    .execute();
}

/**
 * jmuir-yvh: ids of soft-deleted diagrams whose retention window (DIAGRAM_RETENTION_DAYS) has
 * fully elapsed — the same threshold restoreDiagram() already uses to refuse restoration, so a
 * diagram this returns is one no caller can ever bring back through the app. Exported separately
 * from purgeExpiredDiagrams() so a caller (apps/api/src/purge/run.ts's --dry-run) can inspect the
 * candidate set without deleting anything.
 */
export async function findExpiredDiagramIds(): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .selectFrom('diagrams')
    .select('id')
    .where('deleted_at', 'is not', null)
    .where('deleted_at', '<=', retentionBoundary())
    .execute();
  return rows.map((r) => r.id);
}

export interface PurgeResult {
  purgedDiagramIds: string[];
}

/**
 * Physically deletes diagrams past their retention window (jmuir-yvh) — 002's research.md §1
 * deliberately deferred this: the retention window is enforced at read/restore time (above), and
 * "gone after 30 days" was fully achieved without ever running a background process, so building
 * a scheduler purely to reclaim rows nobody can reach anymore was judged disproportionate
 * (Constitution VI). This is that deferred physical purge, but still deliberately NOT wired to a
 * scheduler here — invoked manually via `npm run purge` (apps/api/src/purge/run.ts), an ops-run
 * housekeeping script, exactly the "manual admin action or an ops-run script" research.md itself
 * named as the eventual mechanism.
 *
 * diagram_versions cascades automatically (`ON DELETE CASCADE`, 0001_init.sql). diagram_chats/
 * chat_messages (0004_ai_chat.sql) and share_grants (a polymorphic subject_id with no FK at all)
 * do not, so they're deleted explicitly here, in dependency order, inside one transaction per
 * call — a diagram row and its own dependents either all go or none do.
 */
export async function purgeExpiredDiagrams(): Promise<PurgeResult> {
  const ids = await findExpiredDiagramIds();
  if (ids.length === 0) {
    return { purgedDiagramIds: [] };
  }

  const db = getDb();
  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom('chat_messages')
      .where('diagram_chat_id', 'in', trx.selectFrom('diagram_chats').select('id').where('diagram_id', 'in', ids))
      .execute();
    await trx.deleteFrom('diagram_chats').where('diagram_id', 'in', ids).execute();
    await trx.deleteFrom('share_grants').where('subject_type', '=', 'diagram').where('subject_id', 'in', ids).execute();
    await trx.deleteFrom('diagrams').where('id', 'in', ids).execute();
  });

  return { purgedDiagramIds: ids };
}
