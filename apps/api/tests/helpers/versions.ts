import { getDb } from '../../src/db/client.js';

/** canvas-obp0: a save must name the version it starts from; tests that just want to save use this. */
export async function currentVersionId(diagramId: string): Promise<string> {
  const row = await getDb().selectFrom('diagrams').select('current_version_id').where('id', '=', diagramId).executeTakeFirstOrThrow();
  return row.current_version_id!;
}
