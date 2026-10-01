import { randomUUID } from 'node:crypto';
import { getDb } from '../db/client.js';
import type { DbExecutor } from '../db/client.js';
import { caseInsensitiveLike, dateToYMD } from '../db/sql-helpers.js';

export class DiagramVersionNotFoundError extends Error {}

/**
 * Appends a new, immutable DiagramVersion row (data-model.md: DiagramVersion is append-only —
 * "restoring" a prior version is done by calling this again with the restored content, never by
 * rewriting history). Must be called within the same transaction as any `diagrams` row update.
 *
 * Takes a `DbExecutor` (`Kysely<DB> | Transaction<DB>`), not a raw `pg.PoolClient` — the fix for
 * exactly the "Postgres driver types leak into service signatures" problem the canvas-jtm audit
 * flagged here specifically. A standalone `getDb()` call works too, for a caller that doesn't need
 * to compose this into its own transaction.
 */
export async function recordDiagramVersion(
  db: DbExecutor,
  input: { diagramId: string; dslContent: string; authorId: string },
): Promise<string> {
  const { next_seq: nextSeq } = await db
    .selectFrom('diagram_versions')
    .select((eb) => eb.fn.coalesce(eb.fn.max('sequence_number'), eb.lit(0)).as('next_seq'))
    .where('diagram_id', '=', input.diagramId)
    .executeTakeFirstOrThrow();

  const row = await db
    .insertInto('diagram_versions')
    .values({
      id: randomUUID(),
      diagram_id: input.diagramId,
      sequence_number: Number(nextSeq) + 1,
      dsl_content: input.dslContent,
      author_id: input.authorId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export interface DiagramVersionSummary {
  id: string;
  sequenceNumber: number;
  authorId: string;
  createdAt: string;
}

/** How many versions a listing returns when the caller does not say (FR-028). A display and
 *  transfer default only — nothing is ever deleted, and anything outside the window remains
 *  reachable by search and restorable. */
export const DEFAULT_VERSION_LIMIT = 5;

export interface ListDiagramVersionsOptions {
  limit?: number;
  /** Matches version number or creation date (FR-030). Author is deliberately excluded — author
   *  names are not surfaced in history today. */
  search?: string;
}

export interface DiagramVersionPage {
  versions: DiagramVersionSummary[];
  /** Whether versions exist beyond those returned, so the caller can say so without fetching
   *  them (FR-029). */
  hasMore: boolean;
}

export async function listDiagramVersions(
  diagramId: string,
  options: ListDiagramVersionsOptions = {},
): Promise<DiagramVersionPage> {
  const db = getDb();
  const limit = Math.max(1, options.limit ?? DEFAULT_VERSION_LIMIT);
  const search = options.search?.trim();

  let query = db.selectFrom('diagram_versions').where('diagram_id', '=', diagramId);
  if (search) {
    if (/^\d+$/.test(search)) {
      // A bare number means that version. Matching it against the date as well would be actively
      // unhelpful: today's date contains most single digits, so "2" would match every version
      // and the newest few would crowd out the one actually being looked for.
      query = query.where('sequence_number', '=', Number(search));
    } else {
      query = query.where((eb) => caseInsensitiveLike(dateToYMD(eb.ref('created_at')), `%${search}%`));
    }
  }

  // Fetch one extra row to learn whether more exist, without a second COUNT query.
  const rows = await query
    .select(['id', 'sequence_number', 'author_id', 'created_at'])
    .orderBy('sequence_number', 'desc')
    .limit(limit + 1)
    .execute();

  const hasMore = rows.length > limit;
  return {
    versions: rows.slice(0, limit).map((r) => ({
      id: r.id,
      sequenceNumber: r.sequence_number,
      authorId: r.author_id,
      // See diagram-chat.service.ts's getChatMessages for why this cast is the pre-existing
      // convention, not a new behavior change — node-postgres always returned a Date here.
      createdAt: r.created_at as unknown as string,
    })),
    hasMore,
  };
}

/** Fetches a specific version's DSL content, e.g. to restore it as a new version (FR-017). */
export async function getDiagramVersionContent(diagramId: string, versionId: string): Promise<string> {
  const db = getDb();
  const row = await db
    .selectFrom('diagram_versions')
    .select('dsl_content')
    .where('id', '=', versionId)
    .where('diagram_id', '=', diagramId)
    .executeTakeFirst();
  if (!row) {
    throw new DiagramVersionNotFoundError(`No version ${versionId} for diagram ${diagramId}`);
  }
  return row.dsl_content;
}
