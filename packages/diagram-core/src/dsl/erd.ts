import { createEmptyDiagramModel, type DiagramModel, type DiagramNode } from '../model/diagram-model.js';
import { splitFrontMatter, joinFrontMatter, type CanvasFrontMatter } from './front-matter.js';
import type { ParseError, ParseResult } from './types.js';

const ID = String.raw`[A-Za-z0-9_-]+`;
// CUSTOMER ||--o{ ORDER : places
const RELATIONSHIP_PATTERN = new RegExp(`^(${ID})\\s+([|o}{.-]+)\\s+(${ID})\\s*:\\s*(.+)$`);
const DEFAULT_CARDINALITY = '||--o{';

let autoPositionCounter = 0;
function nextPosition(): { x: number; y: number } {
  const position = { x: (autoPositionCounter % 4) * 200 + 40, y: Math.floor(autoPositionCounter / 4) * 140 + 40 };
  autoPositionCounter += 1;
  return position;
}

/**
 * Parses Mermaid `erDiagram` (entity-relationship). Any cardinality notation (`||--o{`, `||--||`,
 * etc.) parses correctly, but — like sequence.ts's arrow style — DiagramEdge has no cardinality
 * field, so serialization always emits the common one-to-many token (`||--o{`). A disclosed
 * scope limitation: import preserves the *entities and relationship labels* exactly; the exact
 * cardinality symbol is not modeled and is normalized on export.
 */
export function parseErd(dsl: string): ParseResult {
  autoPositionCounter = 0;
  const { frontMatter, body } = splitFrontMatter(dsl);
  const positions = frontMatter.canvas?.positions ?? {};

  const lines = body.split(/\r?\n/);
  const errors: ParseError[] = [];
  const nodesById = new Map<string, DiagramNode>();
  const edges: { id: string; sourceId: string; targetId: string; label?: string }[] = [];
  let headerSeen = false;
  let edgeCounter = 0;

  const ensureEntity = (id: string) => {
    if (!nodesById.has(id)) {
      nodesById.set(id, { id, label: id, shape: 'rectangle', role: 'entity', position: positions[id] ?? nextPosition() });
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;

    if (!headerSeen) {
      if (line === 'erDiagram') {
        headerSeen = true;
        continue;
      }
      errors.push({ line: i + 1, content: rawLine, message: 'Expected "erDiagram" header line' });
      continue;
    }

    const relMatch = line.match(RELATIONSHIP_PATTERN);
    if (relMatch) {
      const [, source, , target, label] = relMatch;
      ensureEntity(source);
      ensureEntity(target);
      edgeCounter += 1;
      edges.push({ id: `e${edgeCounter}`, sourceId: source, targetId: target, label });
      continue;
    }

    errors.push({ line: i + 1, content: rawLine, message: `Could not interpret line as an entity relationship: "${line}"` });
  }

  if (errors.length > 0) return { errors };

  const model = createEmptyDiagramModel('erd');
  model.nodes = Array.from(nodesById.values());
  model.edges = edges;
  return { model };
}

export function serializeErd(model: DiagramModel): string {
  const frontMatter: CanvasFrontMatter = {
    canvas: { positions: Object.fromEntries(model.nodes.map((n) => [n.id, n.position])) },
  };

  const lines: string[] = ['erDiagram'];
  for (const edge of model.edges) {
    lines.push(`${edge.sourceId} ${DEFAULT_CARDINALITY} ${edge.targetId} : ${edge.label ?? ''}`);
  }

  return joinFrontMatter(frontMatter, `${lines.join('\n')}\n`);
}
