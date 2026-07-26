import { getPool } from '../db/pool.js';

export interface DiagramSummary {
  id: string;
  name: string;
  diagramTypeId: string;
  projectId: string;
  updatedAt: string;
}

export interface SearchDiagramsInput {
  projectId: string;
  query?: string;
  diagramTypeId?: string;
}

/** Search/browse diagrams by name, type, and folder (FR-016). */
export async function searchDiagrams(input: SearchDiagramsInput): Promise<DiagramSummary[]> {
  const pool = getPool();
  const conditions = ['project_id = $1', 'deleted_at IS NULL'];
  const params: unknown[] = [input.projectId];

  if (input.query) {
    params.push(`%${input.query}%`);
    conditions.push(`name ILIKE $${params.length}`);
  }
  if (input.diagramTypeId) {
    params.push(input.diagramTypeId);
    conditions.push(`diagram_type_id = $${params.length}`);
  }

  const { rows } = await pool.query<{ id: string; name: string; diagram_type_id: string; project_id: string; updated_at: string }>(
    `SELECT id, name, diagram_type_id, project_id, updated_at FROM diagrams
     WHERE ${conditions.join(' AND ')}
     ORDER BY updated_at DESC`,
    params,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, diagramTypeId: r.diagram_type_id, projectId: r.project_id, updatedAt: r.updated_at }));
}
