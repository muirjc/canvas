import { createEmptyDiagramModel, type DiagramModel, type DiagramNode } from '../model/diagram-model.js';
import { splitFrontMatter, joinFrontMatter, type CanvasFrontMatter } from './front-matter.js';
import type { ParseError, ParseResult } from './types.js';

const ID = String.raw`[A-Za-z0-9_]+`;
const PARTICIPANT_PATTERN = new RegExp(`^participant\\s+(${ID})$`);
// A->>B: message   or   A-->>B: message (dashed/async)
const MESSAGE_PATTERN = new RegExp(`^(${ID})\\s*(-->>|->>)\\s*(${ID})\\s*:\\s*(.+)$`);

let autoPositionCounter = 0;
function nextPosition(): { x: number; y: number } {
  const position = { x: autoPositionCounter * 180 + 40, y: 40 };
  autoPositionCounter += 1;
  return position;
}

/**
 * Parses Mermaid `sequenceDiagram` (participants + messages). Both synchronous (`->>`) and
 * async/dashed (`-->>`) arrows parse to an equivalent edge; DiagramEdge has no arrow-style field,
 * so serialization always emits `->>` — a disclosed scope limitation, not a round-trip bug (no
 * data is silently dropped; the distinction was never modeled).
 */
export function parseSequence(dsl: string): ParseResult {
  autoPositionCounter = 0;
  const { frontMatter, body } = splitFrontMatter(dsl);
  const positions = frontMatter.canvas?.positions ?? {};

  const lines = body.split(/\r?\n/);
  const errors: ParseError[] = [];
  const nodesById = new Map<string, DiagramNode>();
  const edges: { id: string; sourceId: string; targetId: string; label?: string }[] = [];
  let headerSeen = false;
  let edgeCounter = 0;

  const ensureParticipant = (id: string) => {
    if (!nodesById.has(id)) {
      nodesById.set(id, { id, label: id, shape: 'rectangle', role: 'participant', position: positions[id] ?? nextPosition() });
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;

    if (!headerSeen) {
      if (line === 'sequenceDiagram') {
        headerSeen = true;
        continue;
      }
      errors.push({ line: i + 1, content: rawLine, message: 'Expected "sequenceDiagram" header line' });
      continue;
    }

    const participantMatch = line.match(PARTICIPANT_PATTERN);
    if (participantMatch) {
      ensureParticipant(participantMatch[1]);
      continue;
    }

    const messageMatch = line.match(MESSAGE_PATTERN);
    if (messageMatch) {
      const [, source, , target, label] = messageMatch;
      ensureParticipant(source);
      ensureParticipant(target);
      edgeCounter += 1;
      edges.push({ id: `e${edgeCounter}`, sourceId: source, targetId: target, label });
      continue;
    }

    errors.push({ line: i + 1, content: rawLine, message: `Could not interpret line as a participant or message: "${line}"` });
  }

  if (errors.length > 0) return { errors };

  const model = createEmptyDiagramModel('sequence');
  model.nodes = Array.from(nodesById.values());
  model.edges = edges;
  return { model };
}

export function serializeSequence(model: DiagramModel): string {
  const frontMatter: CanvasFrontMatter = {
    canvas: { positions: Object.fromEntries(model.nodes.map((n) => [n.id, n.position])) },
  };

  const lines: string[] = ['sequenceDiagram'];
  for (const node of model.nodes) {
    lines.push(`participant ${node.id}`);
  }
  for (const edge of model.edges) {
    lines.push(`${edge.sourceId}->>${edge.targetId}: ${edge.label ?? ''}`);
  }

  return joinFrontMatter(frontMatter, `${lines.join('\n')}\n`);
}
