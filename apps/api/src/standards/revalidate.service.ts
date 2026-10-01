import { getDslFamily, validate } from '@canvas/diagram-core';
import { getDb } from '../db/client.js';
import { getActiveStandard } from './standard.service.js';
import { loadDiagramTypeDslFamily } from '../diagrams/diagram.service.js';

/**
 * Re-evaluates every existing diagram of a diagram type against its (newly published or
 * updated) Standard. Never rewrites `dsl_content` — only refreshes the cached validation result
 * (FR-014: "existing diagrams re-evaluated... without being silently auto-modified").
 */
export async function revalidateDiagramsForType(diagramTypeId: string): Promise<number> {
  const db = getDb();
  const standard = await getActiveStandard(diagramTypeId);
  const dslFamilyId = await loadDiagramTypeDslFamily(diagramTypeId);
  const family = getDslFamily(dslFamilyId);
  if (!family) return 0;

  const rows = await db
    .selectFrom('diagrams')
    .innerJoin('diagram_versions', 'diagram_versions.id', 'diagrams.current_version_id')
    .select(['diagrams.id', 'diagram_versions.dsl_content'])
    .where('diagrams.diagram_type_id', '=', diagramTypeId)
    .execute();

  let updated = 0;
  for (const row of rows) {
    const result = family.parse(row.dsl_content);
    const violations = 'model' in result && standard ? validate(result.model, standard.rules) : [];
    await db
      .updateTable('diagrams')
      .set({
        // JSON.stringify is required, not optional — see db/schema.ts's JsonColumn doc.
        last_validation_result: JSON.stringify(violations),
        standard_version_at_last_check: standard?.version ?? null,
      })
      .where('id', '=', row.id)
      .execute();
    updated += 1;
  }
  return updated;
}
