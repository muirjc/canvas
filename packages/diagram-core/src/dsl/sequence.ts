import {
  createEmptyDiagramModel,
  type DiagramContainer,
  type DiagramModel,
  type DiagramNode,
} from '../model/diagram-model.js';
import { splitFrontMatter, joinFrontMatter, type CanvasFrontMatter } from './front-matter.js';
import type { ParseError, ParseResult } from './types.js';

const ID = String.raw`[A-Za-z0-9_]+`;
const PARTICIPANT_PATTERN = new RegExp(`^participant\\s+(${ID})$`);
// A->>B: message   or   A-->>B: message (dashed/async)
const MESSAGE_PATTERN = new RegExp(`^(${ID})\\s*(-->>|->>)\\s*(${ID})\\s*:\\s*(.+)$`);
// Note left of X: text   or   Note right of X: text   or   Note over A, B, C: text
const NOTE_PATTERN = /^Note\s+(left of|right of|over)\s+([^:]+?)\s*:\s*(.*)$/;
const BLOCK_START = new RegExp(`^(loop|alt|opt|par|critical|break)(?:\\s+(.+))?$`);
const BRANCH_PATTERN = new RegExp(`^(else|and|option)(?:\\s+(.+))?$`);
const BLOCK_END = /^end$/;
const TOP_LEVEL_BLOCK_KEYWORDS = new Set(['loop', 'alt', 'opt', 'par', 'critical', 'break']);
const NOTE_POSITION_TO_ROLE: Record<string, string> = {
  'left of': 'note-left',
  'right of': 'note-right',
  over: 'note-over',
};

let autoPositionCounter = 0;
function nextPosition(): { x: number; y: number } {
  const position = { x: autoPositionCounter * 180 + 40, y: 40 };
  autoPositionCounter += 1;
  return position;
}

function noteSize(text: string): { width: number; height: number } {
  return { width: Math.max(100, Math.min(260, text.length * 7 + 20)), height: 50 };
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
  const containersById = new Map<string, DiagramContainer>();
  const edges: {
    id: string;
    sourceId: string;
    targetId: string;
    label?: string;
    sequenceOrder: number;
    containerId?: string;
  }[] = [];
  let headerSeen = false;
  let edgeCounter = 0;
  let containerCounter = 0;
  let orderCounter = 0;

  // Stack of currently-open top-level blocks (loop/alt/opt/par/critical/break). `currentChildId`
  // tracks the most recent else/and/option branch, if any — messages attach to it instead of the
  // block itself once one has been opened (research.md §1).
  const blockStack: { id: string; keyword: string; line: number; content: string; currentChildId?: string }[] = [];

  const currentContainerId = (): string | undefined => {
    if (blockStack.length === 0) return undefined;
    const top = blockStack[blockStack.length - 1];
    return top.currentChildId ?? top.id;
  };

  const ensureParticipant = (id: string) => {
    if (!nodesById.has(id)) {
      nodesById.set(id, { id, label: id, shape: 'rectangle', role: 'participant', position: positions[id] ?? nextPosition() });
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('%%')) continue;

    if (!headerSeen) {
      if (line === 'sequenceDiagram') {
        headerSeen = true;
        continue;
      }
      errors.push({ line: i + 1, content: rawLine, message: 'Expected "sequenceDiagram" header line' });
      continue;
    }

    const noteMatch = line.match(NOTE_PATTERN);
    if (noteMatch) {
      const [, position, participantList, text] = noteMatch;
      const participantIds = participantList.split(',').map((p) => p.trim());
      for (const id of participantIds) ensureParticipant(id);
      containerCounter += 1;
      const id = `note${containerCounter}`;
      containersById.set(id, {
        id,
        label: text,
        role: NOTE_POSITION_TO_ROLE[position],
        attachedNodeIds: participantIds,
        position: nextPosition(),
        size: noteSize(text),
        parentContainerId: currentContainerId(),
        sequenceOrder: orderCounter++,
      });
      continue;
    }

    const blockStart = line.match(BLOCK_START);
    if (blockStart) {
      const [, keyword, label] = blockStart;
      containerCounter += 1;
      const id = `block${containerCounter}`;
      containersById.set(id, {
        id,
        label: label ?? '',
        role: keyword,
        position: nextPosition(),
        parentContainerId: currentContainerId(),
        sequenceOrder: orderCounter++,
      });
      blockStack.push({ id, keyword, line: i + 1, content: rawLine });
      continue;
    }

    const branchMatch = line.match(BRANCH_PATTERN);
    if (branchMatch && blockStack.length > 0) {
      const [, keyword, label] = branchMatch;
      const parent = blockStack[blockStack.length - 1];
      containerCounter += 1;
      const id = `block${containerCounter}`;
      containersById.set(id, {
        id,
        label: label ?? '',
        role: keyword,
        position: nextPosition(),
        parentContainerId: parent.id,
        sequenceOrder: orderCounter++,
      });
      parent.currentChildId = id;
      continue;
    }

    if (BLOCK_END.test(line)) {
      if (blockStack.length === 0) {
        errors.push({ line: i + 1, content: rawLine, message: '"end" with no matching loop/alt/opt/par/critical/break block' });
      } else {
        blockStack.pop();
      }
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
      edges.push({
        id: `e${edgeCounter}`,
        sourceId: source,
        targetId: target,
        label,
        sequenceOrder: orderCounter++,
        containerId: currentContainerId(),
      });
      continue;
    }

    errors.push({ line: i + 1, content: rawLine, message: `Could not interpret line as a participant or message: "${line}"` });
  }

  for (const open of blockStack) {
    errors.push({
      line: open.line,
      content: open.content,
      message: `Unclosed '${open.keyword}' block opened at line ${open.line}`,
    });
  }

  if (errors.length > 0) return { errors };

  const model = createEmptyDiagramModel('sequence');
  model.nodes = Array.from(nodesById.values());
  model.edges = edges;
  model.containers = Array.from(containersById.values());
  return { model };
}

const NOTE_ROLE_TO_KEYWORD: Record<string, string> = {
  'note-left': 'Note left of',
  'note-right': 'Note right of',
  'note-over': 'Note over',
};

function serializeContainer(container: DiagramContainer, model: DiagramModel, indent: string): string[] {
  const noteKeyword = container.role ? NOTE_ROLE_TO_KEYWORD[container.role] : undefined;
  if (noteKeyword) {
    const participants = (container.attachedNodeIds ?? []).join(', ');
    return [`${indent}${noteKeyword} ${participants}: ${container.label}`];
  }
  const label = container.label ? ` ${container.label}` : '';
  const lines = [`${indent}${container.role}${label}`];
  lines.push(...emitScope(container.id, model, `${indent}  `));
  if (container.role && TOP_LEVEL_BLOCK_KEYWORDS.has(container.role)) {
    lines.push(`${indent}end`);
  }
  return lines;
}

function emitScope(containerId: string | undefined, model: DiagramModel, indent: string): string[] {
  const items: { order: number; lines: string[] }[] = [];
  for (const edge of model.edges) {
    if (edge.containerId === containerId) {
      items.push({ order: edge.sequenceOrder ?? 0, lines: [`${indent}${edge.sourceId}->>${edge.targetId}: ${edge.label ?? ''}`] });
    }
  }
  for (const container of model.containers) {
    if (container.parentContainerId === containerId) {
      items.push({ order: container.sequenceOrder ?? 0, lines: serializeContainer(container, model, indent) });
    }
  }
  items.sort((a, b) => a.order - b.order);
  return items.flatMap((item) => item.lines);
}

export function serializeSequence(model: DiagramModel): string {
  const frontMatter: CanvasFrontMatter = {
    canvas: { positions: Object.fromEntries(model.nodes.map((n) => [n.id, n.position])) },
  };

  const lines: string[] = ['sequenceDiagram'];
  for (const node of model.nodes) {
    lines.push(`participant ${node.id}`);
  }
  lines.push(...emitScope(undefined, model, ''));

  return joinFrontMatter(frontMatter, `${lines.join('\n')}\n`);
}
