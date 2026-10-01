import { getDb } from '../db/client.js';
import { caseInsensitiveLike } from '../db/sql-helpers.js';

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
  const db = getDb();
  let query = db
    .selectFrom('diagrams')
    .where('project_id', '=', input.projectId)
    .where('deleted_at', 'is', null);

  if (input.query) {
    const pattern = `%${input.query}%`;
    query = query.where((eb) => caseInsensitiveLike(eb.ref('name'), pattern));
  }
  if (input.diagramTypeId) {
    query = query.where('diagram_type_id', '=', input.diagramTypeId);
  }

  const rows = await query
    .select(['id', 'name', 'diagram_type_id', 'project_id', 'updated_at'])
    .orderBy('updated_at', 'desc')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    diagramTypeId: r.diagram_type_id,
    projectId: r.project_id,
    // See diagram-chat.service.ts's getChatMessages for why this cast is the pre-existing
    // convention, not a new behavior change — node-postgres always returned a Date here.
    updatedAt: r.updated_at as unknown as string,
  }));
}
