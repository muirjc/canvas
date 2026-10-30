import { randomUUID } from 'node:crypto';
import { getDb } from '../db/client.js';
import type { DbExecutor } from '../db/client.js';
import { caseInsensitiveLike, compareTimestamp } from '../db/sql-helpers.js';

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
  input: { diagramId: string; dslContent: string; authorId: string; restoredFromVersionId?: string },
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
      restored_from_version_id: input.restoredFromVersionId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export interface DiagramVersionSummary {
  id: string;
  sequenceNumber: number;
  authorId: string;
  /** canvas-zfe: shown on each History row and searchable ("Deleted user" for a deleted account). */
  authorName: string;
  createdAt: string;
  /** canvas-3fha: the version this one restored, e.g. v7 "Restored from v1". */
  restoredFromSequence: number | null;
}

/** canvas-3fha: one version with its content, for the read-only preview. */
export interface DiagramVersionDetail extends DiagramVersionSummary {
  dslContent: string;
}

/** How many versions a listing returns when the caller does not say (FR-028). A display and
 *  transfer default only — nothing is ever deleted, and anything outside the window remains
 *  reachable by search and restorable. */
export const DEFAULT_VERSION_LIMIT = 5;

export interface ListDiagramVersionsOptions {
  limit?: number;
  /**
   * canvas-zfe: a version number ("3", "v3", "V3", "#3") finds exactly that version; any other
   * text matches the author's name or email. Dates are NOT text-matched here: the browser turns
   * what the user typed ("Oct 26", "10/26", "today") into `from`/`to` in their own time zone.
   */
  search?: string;
  /** canvas-zfe: created at or after this instant. */
  from?: Date;
  /** canvas-zfe: created before this instant. */
  to?: Date;
}

export interface DiagramVersionPage {
  versions: DiagramVersionSummary[];
  /** Whether versions exist beyond those returned, so the caller can say so without fetching
   *  them (FR-029). */
  hasMore: boolean;
}

const VERSION_NUMBER = /^(?:v|#)?\s*(\d+)$/i;

function versionsQuery(db: DbExecutor, diagramId: string) {
  return db
    .selectFrom('diagram_versions as v')
    .innerJoin('users as u', 'u.id', 'v.author_id')
    .leftJoin('diagram_versions as src', 'src.id', 'v.restored_from_version_id')
    .where('v.diagram_id', '=', diagramId)
    .select([
      'v.id',
      'v.sequence_number',
      'v.author_id',
      'v.created_at',
      'u.name as author_name',
      'u.email as author_email',
      'src.sequence_number as restored_from_sequence',
    ]);
}

type VersionRow = {
  id: string;
  sequence_number: number;
  author_id: string;
  created_at: unknown;
  author_name: string;
  author_email: string;
  restored_from_sequence: number | null;
};

function toSummary(r: VersionRow): DiagramVersionSummary {
  return {
    id: r.id,
    sequenceNumber: r.sequence_number,
    authorId: r.author_id,
    authorName: r.author_name || r.author_email,
    // See diagram-chat.service.ts's getChatMessages for why this cast is the pre-existing
    // convention, not a new behavior change — node-postgres always returned a Date here.
    createdAt: r.created_at as unknown as string,
    restoredFromSequence: r.restored_from_sequence ?? null,
  };
}

export async function listDiagramVersions(
  diagramId: string,
  options: ListDiagramVersionsOptions = {},
): Promise<DiagramVersionPage> {
  const limit = Math.max(1, options.limit ?? DEFAULT_VERSION_LIMIT);
  const search = options.search?.trim();

  let query = versionsQuery(getDb(), diagramId);
  if (search) {
    const number = search.match(VERSION_NUMBER);
    if (number) {
      // A version number means that version. Matching it against anything else would be actively
      // unhelpful: "2" would also match names and dates and crowd out the one being looked for.
      query = query.where('v.sequence_number', '=', Number(number[1]));
    } else {
      const pattern = `%${search}%`;
      query = query.where((eb) => eb.or([caseInsensitiveLike(eb.ref('u.name'), pattern), caseInsensitiveLike(eb.ref('u.email'), pattern)]));
    }
  }
  const { from, to } = options;
  if (from) query = query.where((eb) => compareTimestamp(eb.ref('v.created_at'), '>=', from));
  if (to) query = query.where((eb) => compareTimestamp(eb.ref('v.created_at'), '<', to));

  // Fetch one extra row to learn whether more exist, without a second COUNT query.
  const rows = await query.orderBy('v.sequence_number', 'desc').limit(limit + 1).execute();

  const hasMore = rows.length > limit;
  return { versions: rows.slice(0, limit).map((r) => toSummary(r as VersionRow)), hasMore };
}

/** canvas-3fha: one version with its content (the read-only preview). */
export async function getDiagramVersion(diagramId: string, versionId: string): Promise<DiagramVersionDetail> {
  const row = await versionsQuery(getDb(), diagramId)
    .select('v.dsl_content')
    .where('v.id', '=', versionId)
    .executeTakeFirst();
  if (!row) {
    throw new DiagramVersionNotFoundError(`No version ${versionId} for diagram ${diagramId}`);
  }
  return { ...toSummary(row as VersionRow), dslContent: row.dsl_content };
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
