import type pg from 'pg';
import { getPool } from '../db/pool.js';

export class DiagramVersionNotFoundError extends Error {}

/**
 * Appends a new, immutable DiagramVersion row (data-model.md: DiagramVersion is append-only —
 * "restoring" a prior version is done by calling this again with the restored content, never by
 * rewriting history). Must be called within the same transaction as any `diagrams` row update.
 */
export async function recordDiagramVersion(
  client: pg.PoolClient,
  input: { diagramId: string; dslContent: string; authorId: string },
): Promise<string> {
  const { rows: seqRows } = await client.query<{ next_seq: number }>(
    'SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_seq FROM diagram_versions WHERE diagram_id = $1',
    [input.diagramId],
  );
  const nextSeq = seqRows[0].next_seq;

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO diagram_versions (diagram_id, sequence_number, dsl_content, author_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.diagramId, nextSeq, input.dslContent, input.authorId],
  );
  return rows[0].id;
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
  const pool = getPool();
  const limit = Math.max(1, options.limit ?? DEFAULT_VERSION_LIMIT);
  const search = options.search?.trim();

  const filters = ['diagram_id = $1'];
  const params: unknown[] = [diagramId];
  if (search) {
    if (/^\d+$/.test(search)) {
      // A bare number means that version. Matching it against the date as well would be actively
      // unhelpful: today's date contains most single digits, so "2" would match every version
      // and the newest few would crowd out the one actually being looked for.
      params.push(Number(search));
      filters.push(`sequence_number = $${params.length}`);
    } else {
      params.push(`%${search}%`);
      filters.push(`to_char(created_at, 'YYYY-MM-DD') ILIKE $${params.length}`);
    }
  }

  // Fetch one extra row to learn whether more exist, without a second COUNT query.
  params.push(limit + 1);
  const { rows } = await pool.query<{
    id: string;
    sequence_number: number;
    author_id: string;
    created_at: string;
  }>(
    `SELECT id, sequence_number, author_id, created_at FROM diagram_versions
     WHERE ${filters.join(' AND ')} ORDER BY sequence_number DESC LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  return {
    versions: rows.slice(0, limit).map((r) => ({
      id: r.id,
      sequenceNumber: r.sequence_number,
      authorId: r.author_id,
      createdAt: r.created_at,
    })),
    hasMore,
  };
}

/** Fetches a specific version's DSL content, e.g. to restore it as a new version (FR-017). */
export async function getDiagramVersionContent(diagramId: string, versionId: string): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query<{ dsl_content: string }>(
    'SELECT dsl_content FROM diagram_versions WHERE id = $1 AND diagram_id = $2',
    [versionId, diagramId],
  );
  if (!rows[0]) {
    throw new DiagramVersionNotFoundError(`No version ${versionId} for diagram ${diagramId}`);
  }
  return rows[0].dsl_content;
}
