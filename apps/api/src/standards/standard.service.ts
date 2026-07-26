import type { StandardRules, IconLibraryRef, ColorPaletteEntry, FontConstraints } from '@canvas/diagram-core';
import type { NodeShape } from '@canvas/diagram-core';
import { getPool } from '../db/pool.js';

export type StandardStatus = 'draft' | 'published' | 'retired';

export interface StandardRecord {
  id: string;
  diagramTypeId: string;
  version: number;
  status: StandardStatus;
  rules: StandardRules;
  publishedAt: string | null;
  createdAt: string;
}

export class StandardNotFoundError extends Error {}
export class StandardStateError extends Error {}

interface StandardRow {
  id: string;
  diagram_type_id: string;
  version: number;
  status: StandardStatus;
  allowed_shape_ids: NodeShape[];
  mandatory_shape_ids: NodeShape[];
  allowed_icon_library_refs: IconLibraryRef[];
  color_palette: ColorPaletteEntry[];
  font_constraints: FontConstraints | null;
  published_at: string | null;
  created_at: string;
}

function toRecord(row: StandardRow): StandardRecord {
  return {
    id: row.id,
    diagramTypeId: row.diagram_type_id,
    version: row.version,
    status: row.status,
    rules: {
      allowedShapeIds: row.allowed_shape_ids ?? [],
      mandatoryShapeIds: row.mandatory_shape_ids ?? [],
      allowedIconLibraryRefs: row.allowed_icon_library_refs ?? [],
      colorPalette: row.color_palette ?? [],
      fontConstraints: row.font_constraints ?? undefined,
    },
    publishedAt: row.published_at,
    createdAt: row.created_at,
  };
}

export interface CreateDraftStandardInput {
  diagramTypeId: string;
  rules: StandardRules;
}

export async function createDraftStandard(input: CreateDraftStandardInput): Promise<StandardRecord> {
  const pool = getPool();
  const { rows: versionRows } = await pool.query<{ next_version: number }>(
    'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM standards WHERE diagram_type_id = $1',
    [input.diagramTypeId],
  );
  const nextVersion = versionRows[0].next_version;

  const { rows } = await pool.query<StandardRow>(
    `INSERT INTO standards
       (diagram_type_id, version, status, allowed_shape_ids, mandatory_shape_ids,
        allowed_icon_library_refs, color_palette, font_constraints)
     VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.diagramTypeId,
      nextVersion,
      input.rules.allowedShapeIds,
      input.rules.mandatoryShapeIds,
      JSON.stringify(input.rules.allowedIconLibraryRefs),
      JSON.stringify(input.rules.colorPalette),
      input.rules.fontConstraints ? JSON.stringify(input.rules.fontConstraints) : null,
    ],
  );
  return toRecord(rows[0]);
}

async function getStandardById(id: string): Promise<StandardRow> {
  const pool = getPool();
  const { rows } = await pool.query<StandardRow>('SELECT * FROM standards WHERE id = $1', [id]);
  if (!rows[0]) {
    throw new StandardNotFoundError(`No standard with id ${id}`);
  }
  return rows[0];
}

/** Publishes a draft Standard, retiring whatever was previously published for its diagram type. */
export async function publishStandard(id: string): Promise<StandardRecord> {
  const row = await getStandardById(id);
  if (row.status !== 'draft') {
    throw new StandardStateError(`Standard ${id} is "${row.status}", only "draft" standards can be published`);
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE standards SET status = 'retired' WHERE diagram_type_id = $1 AND status = 'published'`,
      [row.diagram_type_id],
    );
    const { rows } = await client.query<StandardRow>(
      `UPDATE standards SET status = 'published', published_at = now() WHERE id = $1 RETURNING *`,
      [id],
    );
    await client.query('COMMIT');
    return toRecord(rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function retireStandard(id: string): Promise<StandardRecord> {
  const pool = getPool();
  const { rows } = await pool.query<StandardRow>(
    `UPDATE standards SET status = 'retired' WHERE id = $1 RETURNING *`,
    [id],
  );
  if (!rows[0]) {
    throw new StandardNotFoundError(`No standard with id ${id}`);
  }
  return toRecord(rows[0]);
}

export async function getActiveStandard(diagramTypeId: string): Promise<StandardRecord | null> {
  const pool = getPool();
  const { rows } = await pool.query<StandardRow>(
    `SELECT * FROM standards WHERE diagram_type_id = $1 AND status = 'published'`,
    [diagramTypeId],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function listStandards(diagramTypeId: string): Promise<StandardRecord[]> {
  const pool = getPool();
  const { rows } = await pool.query<StandardRow>(
    'SELECT * FROM standards WHERE diagram_type_id = $1 ORDER BY version DESC',
    [diagramTypeId],
  );
  return rows.map(toRecord);
}
