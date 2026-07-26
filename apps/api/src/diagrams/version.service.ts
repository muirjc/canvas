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

export async function listDiagramVersions(diagramId: string): Promise<DiagramVersionSummary[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    sequence_number: number;
    author_id: string;
    created_at: string;
  }>(
    `SELECT id, sequence_number, author_id, created_at FROM diagram_versions
     WHERE diagram_id = $1 ORDER BY sequence_number DESC`,
    [diagramId],
  );
  return rows.map((r) => ({
    id: r.id,
    sequenceNumber: r.sequence_number,
    authorId: r.author_id,
    createdAt: r.created_at,
  }));
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
