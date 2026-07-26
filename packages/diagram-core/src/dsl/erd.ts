import { createEmptyDiagramModel, type DiagramModel, type DiagramNode, type EntityAttribute } from '../model/diagram-model.js';
import { splitFrontMatter, joinFrontMatter, type CanvasFrontMatter } from './front-matter.js';
import type { ParseError, ParseResult } from './types.js';

const ID = String.raw`[A-Za-z0-9_-]+`;
// CUSTOMER ||--o{ ORDER : places
const RELATIONSHIP_PATTERN = new RegExp(`^(${ID})\\s+([|o}{.-]+)\\s+(${ID})\\s*:\\s*(.+)$`);
const DEFAULT_CARDINALITY = '||--o{';
// CUSTOMER {
const ENTITY_BLOCK_START = new RegExp(`^(${ID})\\s*\\{$`);
const BLOCK_END = /^\}$/;
// string id PK, UK "comment"
const ATTRIBUTE_LINE = /^(\S+)\s+(\S+)(?:\s+([^"]*?))?\s*(?:"([^"]*)")?$/;
const RECOGNIZED_KEYS = new Set(['PK', 'FK', 'UK']);

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
  let openEntity: { id: string; line: number; content: string } | null = null;

  const ensureEntity = (id: string) => {
    if (!nodesById.has(id)) {
      nodesById.set(id, { id, label: id, shape: 'rectangle', role: 'entity', position: positions[id] ?? nextPosition() });
    }
  };

  const pushAttribute = (entityId: string, attribute: EntityAttribute) => {
    const node = nodesById.get(entityId)!;
    node.attributes = node.attributes ? [...node.attributes, attribute] : [attribute];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('%%')) continue;

    if (!headerSeen) {
      if (line === 'erDiagram') {
        headerSeen = true;
        continue;
      }
      errors.push({ line: i + 1, content: rawLine, message: 'Expected "erDiagram" header line' });
      continue;
    }

    if (openEntity) {
      if (BLOCK_END.test(line)) {
        openEntity = null;
        continue;
      }
      const attrMatch = line.match(ATTRIBUTE_LINE);
      if (attrMatch) {
        const [, type, name, constraintsRaw] = attrMatch;
        const keys = (constraintsRaw ?? '')
          .split(',')
          .map((k) => k.trim().toUpperCase())
          .filter((k) => RECOGNIZED_KEYS.has(k));
        pushAttribute(openEntity.id, { type, name, keys });
        continue;
      }
      errors.push({ line: i + 1, content: rawLine, message: `Could not interpret line as an entity attribute: "${line}"` });
      continue;
    }

    const blockStart = line.match(ENTITY_BLOCK_START);
    if (blockStart) {
      const [, id] = blockStart;
      ensureEntity(id);
      openEntity = { id, line: i + 1, content: rawLine };
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

  if (openEntity) {
    errors.push({
      line: openEntity.line,
      content: openEntity.content,
      message: `Unclosed attribute block for entity '${openEntity.id}' opened at line ${openEntity.line}`,
    });
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
  for (const node of model.nodes) {
    if (node.attributes && node.attributes.length > 0) {
      lines.push(`${node.id} {`);
      for (const attribute of node.attributes) {
        const keysPart = attribute.keys.length > 0 ? ` ${attribute.keys.join(', ')}` : '';
        lines.push(`  ${attribute.type} ${attribute.name}${keysPart}`);
      }
      lines.push('}');
    }
  }
  for (const edge of model.edges) {
    lines.push(`${edge.sourceId} ${DEFAULT_CARDINALITY} ${edge.targetId} : ${edge.label ?? ''}`);
  }

  return joinFrontMatter(frontMatter, `${lines.join('\n')}\n`);
}
