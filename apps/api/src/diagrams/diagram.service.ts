import { createEmptyDiagramModel, getDslFamily, validate, type DiagramModel, type ParseError } from '@canvas/diagram-core';
import { getPool } from '../db/pool.js';
import { recordDiagramVersion } from './version.service.js';
import { getActiveStandard } from '../standards/standard.service.js';
import type { Violation } from '@canvas/diagram-core';

export interface DiagramRecord {
  id: string;
  name: string;
  diagramTypeId: string;
  /** The DSL family (e.g. "c4", "architecture") this diagram type serializes to — not the
   * diagram type id itself, which callers must not confuse with it (they only coincide for
   * "flowchart"). */
  dslFamily: string;
  projectId: string;
  ownerId: string;
  dslContent: string;
  lastValidationResult: Violation[];
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

export async function loadDiagramTypeDslFamily(diagramTypeId: string): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query<{ dsl_family: string }>(
    'SELECT dsl_family FROM diagram_types WHERE id = $1',
    [diagramTypeId],
  );
  if (!rows[0]) {
    throw new UnknownDiagramTypeError(`Unknown diagram type: ${diagramTypeId}`);
  }
  return rows[0].dsl_family;
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

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const diagramResult = await client.query<{ id: string; created_at: string; updated_at: string }>(
      `INSERT INTO diagrams (name, diagram_type_id, project_id, owner_id, last_validation_result, standard_version_at_last_check)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at, updated_at`,
      [input.name, input.diagramTypeId, input.projectId, input.ownerId, JSON.stringify(violations), standardVersion],
    );
    const diagram = diagramResult.rows[0];

    const versionId = await recordDiagramVersion(client, {
      diagramId: diagram.id,
      dslContent: initialDslContent,
      authorId: input.ownerId,
    });

    await client.query('UPDATE diagrams SET current_version_id = $1 WHERE id = $2', [
      versionId,
      diagram.id,
    ]);
    await client.query('COMMIT');

    return {
      id: diagram.id,
      name: input.name,
      diagramTypeId: input.diagramTypeId,
      dslFamily: dslFamilyId,
      projectId: input.projectId,
      ownerId: input.ownerId,
      dslContent: initialDslContent,
      lastValidationResult: violations,
      createdAt: diagram.created_at,
      updatedAt: diagram.updated_at,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

interface DiagramRow {
  id: string;
  name: string;
  diagram_type_id: string;
  dsl_family: string;
  project_id: string;
  owner_id: string;
  last_validation_result: Violation[];
  created_at: string;
  updated_at: string;
  dsl_content: string;
}

export async function getDiagram(id: string): Promise<DiagramRecord> {
  const pool = getPool();
  const { rows } = await pool.query<DiagramRow>(
    `SELECT d.id, d.name, d.diagram_type_id, dt.dsl_family, d.project_id, d.owner_id,
            d.last_validation_result, d.created_at, d.updated_at, v.dsl_content
     FROM diagrams d
     JOIN diagram_versions v ON v.id = d.current_version_id
     JOIN diagram_types dt ON dt.id = d.diagram_type_id
     WHERE d.id = $1 AND d.deleted_at IS NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    throw new DiagramNotFoundError(`No diagram with id ${id}`);
  }
  return {
    id: row.id,
    name: row.name,
    diagramTypeId: row.diagram_type_id,
    dslFamily: row.dsl_family,
    projectId: row.project_id,
    ownerId: row.owner_id,
    dslContent: row.dsl_content,
    lastValidationResult: row.last_validation_result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const versionId = await recordDiagramVersion(client, {
      diagramId: id,
      dslContent: input.dslContent,
      authorId: input.authorId,
    });

    await client.query(
      `UPDATE diagrams
       SET current_version_id = $1, updated_at = now(), last_validation_result = $2, standard_version_at_last_check = $3
       WHERE id = $4`,
      [versionId, JSON.stringify(violations), standardVersion, id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return getDiagram(id);
}

/**
 * Moves a diagram to a different project (canvas-228.3). Access (edit on the diagram, edit on
 * the destination project) is enforced by the route, not here — this function trusts its caller.
 * No versioning/soft-delete implications: the diagram's own history and identity are unchanged,
 * only which project's tree it appears in.
 */
export async function moveDiagram(id: string, destinationProjectId: string): Promise<DiagramRecord> {
  const pool = getPool();
  const { rows } = await pool.query('SELECT 1 FROM diagrams WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!rows[0]) {
    throw new DiagramNotFoundError(`No diagram with id ${id}`);
  }
  await pool.query('UPDATE diagrams SET project_id = $2 WHERE id = $1', [id, destinationProjectId]);
  return getDiagram(id);
}

/**
 * Renames a diagram (canvas-8x1). Access (edit on the diagram) is enforced by the route, not
 * here — this function trusts its caller, mirroring moveDiagram above. No versioning
 * implications: the name lives on the diagrams row itself, not in diagram_versions, so renaming
 * doesn't touch history or the current DSL content.
 */
export async function renameDiagram(id: string, name: string): Promise<DiagramRecord> {
  const pool = getPool();
  const { rows } = await pool.query('SELECT 1 FROM diagrams WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!rows[0]) {
    throw new DiagramNotFoundError(`No diagram with id ${id}`);
  }
  await pool.query('UPDATE diagrams SET name = $2 WHERE id = $1', [id, name]);
  return getDiagram(id);
}

/**
 * Soft-deletes a diagram (FR-011/FR-012). Idempotent: deleting an already-deleted diagram
 * succeeds silently rather than erroring, since the end state the caller wants ("this diagram
 * is deleted") already holds.
 */
export async function deleteDiagram(id: string, deletedByUserId: string): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query('SELECT 1 FROM diagrams WHERE id = $1', [id]);
  if (!rows[0]) {
    throw new DiagramNotFoundError(`No diagram with id ${id}`);
  }
  await pool.query(
    `UPDATE diagrams SET deleted_at = COALESCE(deleted_at, now()), deleted_by_user_id = COALESCE(deleted_by_user_id, $2)
     WHERE id = $1`,
    [id, deletedByUserId],
  );
}

export interface DeletedDiagramSummary {
  id: string;
  name: string;
  ownerId: string;
  projectId: string;
  deletedAt: string;
}

/** Admin-only, metadata-only listing of soft-deleted diagrams still within their retention window (FR-020). */
export async function listDeletedDiagrams(): Promise<DeletedDiagramSummary[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; name: string; owner_id: string; project_id: string; deleted_at: string }>(
    `SELECT id, name, owner_id, project_id, deleted_at FROM diagrams
     WHERE deleted_at IS NOT NULL AND deleted_at > now() - make_interval(days => $1)
     ORDER BY deleted_at DESC`,
    [DIAGRAM_RETENTION_DAYS],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, ownerId: r.owner_id, projectId: r.project_id, deletedAt: r.deleted_at }));
}

/** Restores a soft-deleted diagram within its retention window, recording who/when (FR-014/FR-021). */
export async function restoreDiagram(id: string, restoredByUserId: string): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ deleted_at: string | null }>('SELECT deleted_at FROM diagrams WHERE id = $1', [id]);
  if (!rows[0] || rows[0].deleted_at === null) {
    throw new DiagramNotFoundError(`No soft-deleted diagram with id ${id}`);
  }

  const { rows: windowCheck } = await pool.query<{ within_window: boolean }>(
    `SELECT deleted_at > now() - make_interval(days => $2) AS within_window FROM diagrams WHERE id = $1`,
    [id, DIAGRAM_RETENTION_DAYS],
  );
  if (!windowCheck[0].within_window) {
    throw new DiagramRetentionExpiredError(
      "This diagram's recovery window has passed and it is no longer available.",
    );
  }

  await pool.query(
    'UPDATE diagrams SET deleted_at = NULL, deleted_by_user_id = NULL, restored_at = now(), restored_by_user_id = $2 WHERE id = $1',
    [id, restoredByUserId],
  );
}
