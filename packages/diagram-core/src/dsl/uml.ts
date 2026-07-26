import { createEmptyDiagramModel, type DiagramModel, type DiagramNode } from '../model/diagram-model.js';
import { splitFrontMatter, joinFrontMatter, type CanvasFrontMatter } from './front-matter.js';
import type { ParseError, ParseResult } from './types.js';

const ID = String.raw`[A-Za-z0-9_]+`;
const CLASS_DECL = new RegExp(`^class\\s+(${ID})$`);
const CLASS_BLOCK_START = new RegExp(`^class\\s+(${ID})\\s*\\{$`);
const BLOCK_END = /^\}$/;
// Animal <|-- Dog   (relationship arrows: <|--, *--, o--, -->, --, ..>
const RELATIONSHIP = new RegExp(`^(${ID})\\s*(<\\|--|\\*--|o--|-->|--|\\.\\.>)\\s*(${ID})(?:\\s*:\\s*(.+))?$`);

let autoPositionCounter = 0;
function nextPosition(): { x: number; y: number } {
  const position = { x: (autoPositionCounter % 4) * 180 + 40, y: Math.floor(autoPositionCounter / 4) * 140 + 40 };
  autoPositionCounter += 1;
  return position;
}

/**
 * Parses Mermaid `classDiagram` — scoped to class declarations and relationships between them.
 * Member/attribute bodies (`class Foo { +method() }`) are a disclosed scope limitation: a class
 * with a body is recognized as a class (its members are not modeled or round-tripped) rather
 * than silently misparsed as an error.
 */
export function parseUml(dsl: string): ParseResult {
  autoPositionCounter = 0;
  const { frontMatter, body } = splitFrontMatter(dsl);
  const positions = frontMatter.canvas?.positions ?? {};

  const lines = body.split(/\r?\n/);
  const errors: ParseError[] = [];
  const nodesById = new Map<string, DiagramNode>();
  const edges: { id: string; sourceId: string; targetId: string; label?: string }[] = [];
  let headerSeen = false;
  let insideClassBody = false;
  let edgeCounter = 0;

  const ensureClass = (id: string) => {
    if (!nodesById.has(id)) {
      nodesById.set(id, { id, label: id, shape: 'rectangle', role: 'class', position: positions[id] ?? nextPosition() });
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;

    if (!headerSeen) {
      if (line === 'classDiagram') {
        headerSeen = true;
        continue;
      }
      errors.push({ line: i + 1, content: rawLine, message: 'Expected "classDiagram" header line' });
      continue;
    }

    if (insideClassBody) {
      if (BLOCK_END.test(line)) insideClassBody = false;
      continue; // member lines are intentionally not modeled (see doc comment above)
    }

    const blockStart = line.match(CLASS_BLOCK_START);
    if (blockStart) {
      ensureClass(blockStart[1]);
      insideClassBody = true;
      continue;
    }

    const decl = line.match(CLASS_DECL);
    if (decl) {
      ensureClass(decl[1]);
      continue;
    }

    const rel = line.match(RELATIONSHIP);
    if (rel) {
      const [, source, , target, label] = rel;
      ensureClass(source);
      ensureClass(target);
      edgeCounter += 1;
      edges.push({ id: `e${edgeCounter}`, sourceId: source, targetId: target, label });
      continue;
    }

    errors.push({ line: i + 1, content: rawLine, message: `Could not interpret line as a class declaration or relationship: "${line}"` });
  }

  if (errors.length > 0) return { errors };

  const model = createEmptyDiagramModel('uml');
  model.nodes = Array.from(nodesById.values());
  model.edges = edges;
  return { model };
}

/** Always serializes relationships as inheritance (`<|--`) — see parseUml's doc comment on
 * relationship-kind not being modeled on DiagramEdge; only class names/labels round-trip exactly. */
export function serializeUml(model: DiagramModel): string {
  const frontMatter: CanvasFrontMatter = {
    canvas: { positions: Object.fromEntries(model.nodes.map((n) => [n.id, n.position])) },
  };

  const lines: string[] = ['classDiagram'];
  for (const node of model.nodes) {
    lines.push(`class ${node.id}`);
  }
  for (const edge of model.edges) {
    lines.push(edge.label ? `${edge.sourceId} <|-- ${edge.targetId} : ${edge.label}` : `${edge.sourceId} <|-- ${edge.targetId}`);
  }

  return joinFrontMatter(frontMatter, `${lines.join('\n')}\n`);
}
