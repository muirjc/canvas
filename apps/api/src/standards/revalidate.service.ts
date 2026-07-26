import { getDslFamily, validate } from '@canvas/diagram-core';
import { getPool } from '../db/pool.js';
import { getActiveStandard } from './standard.service.js';
import { loadDiagramTypeDslFamily } from '../diagrams/diagram.service.js';

/**
 * Re-evaluates every existing diagram of a diagram type against its (newly published or
 * updated) Standard. Never rewrites `dsl_content` — only refreshes the cached validation result
 * (FR-014: "existing diagrams re-evaluated... without being silently auto-modified").
 */
export async function revalidateDiagramsForType(diagramTypeId: string): Promise<number> {
  const pool = getPool();
  const standard = await getActiveStandard(diagramTypeId);
  const dslFamilyId = await loadDiagramTypeDslFamily(diagramTypeId);
  const family = getDslFamily(dslFamilyId);
  if (!family) return 0;

  const { rows } = await pool.query<{ id: string; dsl_content: string }>(
    `SELECT d.id, v.dsl_content FROM diagrams d
     JOIN diagram_versions v ON v.id = d.current_version_id
     WHERE d.diagram_type_id = $1`,
    [diagramTypeId],
  );

  let updated = 0;
  for (const row of rows) {
    const result = family.parse(row.dsl_content);
    const violations = 'model' in result && standard ? validate(result.model, standard.rules) : [];
    await pool.query(
      'UPDATE diagrams SET last_validation_result = $1, standard_version_at_last_check = $2 WHERE id = $3',
      [JSON.stringify(violations), standard?.version ?? null, row.id],
    );
    updated += 1;
  }
  return updated;
}
