import {
  createEmptyDiagramModel,
  type DiagramContainer,
  type DiagramModel,
  type DiagramNode,
} from '../model/diagram-model.js';
import { splitFrontMatter, joinFrontMatter, type CanvasFrontMatter } from './front-matter.js';
import type { ParseError, ParseResult } from './types.js';

const ID = String.raw`[A-Za-z0-9_]+`;
// jmuir-dtu.4: `actor` (shape 'person', role 'actor') alongside the pre-existing `participant`
// (shape 'rectangle', role 'participant'), plus the `as <alias>` display-label suffix — the id
// stays canonical everywhere else (messages, notes, activation), only `label` changes, same
// alias convention already established for C4/ERD.
const PARTICIPANT_PATTERN = new RegExp(`^(participant|actor)\\s+(${ID})(?:\\s+as\\s+(.+))?$`);
// jmuir-dtu.4: the full arrow-token set beyond the pre-existing ->>/-->> (each literal token is
// distinct, not a prefix of another, so alternation order doesn't affect correctness). The
// optional `[+-]` between the arrow and target is the activation shorthand -- '+' activates the
// TARGET, '-' deactivates the SOURCE (confirmed against Mermaid's own sequenceDiagram.jison
// grammar: the '+' rule's activeStart targets actor2/$4, the target; the '-' rule's activeEnd
// targets actor/$1, the SOURCE -- an asymmetry easy to get backwards by eye alone).
const ARROW_TOKEN = String.raw`<<-->>|<<->>|-->>|->>|--x|-x|--\)|-\)|-->|->`;
const MESSAGE_PATTERN = new RegExp(`^(${ID})\\s*(${ARROW_TOKEN})\\s*([+-])?\\s*(${ID})\\s*:\\s*(.+)$`);
const ARROW_TOKEN_TO_STYLE: Record<string, { lineStyle: 'solid' | 'dotted'; arrow: 'none' | 'target' | 'both' | 'cross' | 'open' }> = {
  '<<-->>': { lineStyle: 'dotted', arrow: 'both' },
  '<<->>': { lineStyle: 'solid', arrow: 'both' },
  '-->>': { lineStyle: 'dotted', arrow: 'target' },
  '->>': { lineStyle: 'solid', arrow: 'target' },
  '--x': { lineStyle: 'dotted', arrow: 'cross' },
  '-x': { lineStyle: 'solid', arrow: 'cross' },
  '--)': { lineStyle: 'dotted', arrow: 'open' },
  '-)': { lineStyle: 'solid', arrow: 'open' },
  '-->': { lineStyle: 'dotted', arrow: 'none' },
  '->': { lineStyle: 'solid', arrow: 'none' },
};
// Note left of X: text   or   Note right of X: text   or   Note over A, B, C: text
const NOTE_PATTERN = /^Note\s+(left of|right of|over)\s+([^:]+?)\s*:\s*(.*)$/;
// jmuir-dtu.4: `rect <color> ... end` (background highlight) joins the same block-with-`end`
// family as loop/alt/opt/par/critical/break -- its "label" position is actually a color, handled
// specially where matched, not stored as a literal label.
const BLOCK_START = new RegExp(`^(loop|alt|opt|par|critical|break|rect)(?:\\s+(.+))?$`);
const BRANCH_PATTERN = new RegExp(`^(else|and|option)(?:\\s+(.+))?$`);
const BLOCK_END = /^end$/;
const TOP_LEVEL_BLOCK_KEYWORDS = new Set(['loop', 'alt', 'opt', 'par', 'critical', 'break', 'rect']);
const NOTE_POSITION_TO_ROLE: Record<string, string> = {
  'left of': 'note-left',
  'right of': 'note-right',
  over: 'note-over',
};
// jmuir-dtu.4: explicit activate/deactivate statements (the +/- shorthand above produces the
// same model shape, see MESSAGE_PATTERN's own comment).
const ACTIVATE_PATTERN = new RegExp(`^activate\\s+(${ID})$`);
const DEACTIVATE_PATTERN = new RegExp(`^deactivate\\s+(${ID})$`);
// jmuir-dtu.4.1: `create participant X (as Alias)?` / `create actor X (as Alias)?` marks a
// participant as first appearing mid-timeline rather than pre-declared at the top; `destroy X`
// marks it as removed at that point. Modeled exactly like activate/deactivate above (their own
// role:'create'/'destroy' DiagramContainer, attachedNodeIds:[participantId], point-in-time, no
// linked pairing) rather than a new DiagramNode ordering field -- reuses 100% of the existing
// container/emitScope machinery, including correct nesting inside loop/alt/rect via
// currentContainerId(), which a separate node-level field would not have gotten for free.
const CREATE_PATTERN = new RegExp(`^create\\s+(participant|actor)\\s+(${ID})(?:\\s+as\\s+(.+))?$`);
const DESTROY_PATTERN = new RegExp(`^destroy\\s+(${ID})$`);
// jmuir-dtu.4: `box <color>? <title>? ... end` groups participants — NOT part of the ordered
// message timeline (no `end`-matching against BLOCK_END's own loop/alt/rect stack; tracked
// separately below). Color is optional and, if present, is always the FIRST token — only the
// unambiguous rgb()/rgba()/transparent forms are recognized as color (a bare named color like
// "Aqua" can't be distinguished from a title word without a full CSS color-name table, so it's
// treated as part of the title instead, a disclosed simplification: the grouping itself is never
// lost, only that one color form).
const BOX_START = /^box(?:\s+(rgba?\([^)]*\)|transparent))?(?:\s+(.+))?$/;
// jmuir-dtu.4: `autonumber`, `autonumber off`, or `autonumber <start> <step>` (decimals allowed).
const AUTONUMBER_PATTERN = /^autonumber(?:\s+(off)|\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?))?$/;
const TITLE_PATTERN = /^title\s+(.+)$/;

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
 * Parses Mermaid `sequenceDiagram` (participants + messages). See ARROW_TOKEN_TO_STYLE for how
 * every arrow variant (solid/dotted, arrowhead/none/both/cross/open) maps onto
 * DiagramEdge.arrow/lineStyle — this closes what used to be a disclosed scope limitation (only
 * ->>/-->> parsed, and even those collapsed to one shape on serialize).
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
    arrow?: 'none' | 'target' | 'both' | 'cross' | 'open';
    lineStyle?: 'solid' | 'dotted';
  }[] = [];
  let headerSeen = false;
  let edgeCounter = 0;
  let containerCounter = 0;
  let orderCounter = 0;
  let autonumber: { start?: number; step?: number } | undefined;
  let title: string | undefined;

  // Stack of currently-open top-level blocks (loop/alt/opt/par/critical/break/rect).
  // `currentChildId` tracks the most recent else/and/option branch, if any — messages attach to
  // it instead of the block itself once one has been opened (research.md §1).
  const blockStack: { id: string; keyword: string; line: number; content: string; currentChildId?: string }[] = [];
  // jmuir-dtu.4: box grouping is not part of the message timeline (see BOX_START's own comment)
  // so it gets its own single-slot open-tracking, separate from blockStack entirely.
  let openBox: { id: string; line: number; content: string } | null = null;

  const currentContainerId = (): string | undefined => {
    if (blockStack.length === 0) return undefined;
    const top = blockStack[blockStack.length - 1];
    return top.currentChildId ?? top.id;
  };

  const ensureParticipant = (id: string, kind: 'participant' | 'actor' = 'participant', alias?: string, boxId?: string) => {
    const existing = nodesById.get(id);
    if (!existing) {
      nodesById.set(id, {
        id,
        label: alias ?? id,
        shape: kind === 'actor' ? 'person' : 'rectangle',
        role: kind,
        position: positions[id] ?? nextPosition(),
        containerId: boxId,
      });
      return;
    }
    if (alias !== undefined) existing.label = alias;
    if (kind === 'actor') {
      existing.role = 'actor';
      existing.shape = 'person';
    }
  };

  // jmuir-dtu.4/.4.1: shared shape for every point-in-time, single-participant timeline item
  // (activate/deactivate/create/destroy) -- none of them link to a matching counterpart in the
  // model itself; pairing is purely whatever the diagram's own sequential structure implies.
  const pushPointItem = (role: 'activate' | 'deactivate' | 'create' | 'destroy', participantId: string) => {
    containerCounter += 1;
    const id = `pt${containerCounter}`;
    containersById.set(id, {
      id,
      label: '',
      role,
      attachedNodeIds: [participantId],
      position: nextPosition(),
      parentContainerId: currentContainerId(),
      sequenceOrder: orderCounter++,
    });
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

    // canvas-vtg: mirrors c4.ts's own TITLE_PATTERN/handling exactly (canvas-79b introduced it
    // there first) -- a real, cross-family Mermaid top-level statement.
    const titleMatch = line.match(TITLE_PATTERN);
    if (titleMatch) {
      title = titleMatch[1];
      continue;
    }

    if (openBox) {
      if (BLOCK_END.test(line)) {
        openBox = null;
        continue;
      }
      const boxedParticipant = line.match(PARTICIPANT_PATTERN);
      if (boxedParticipant) {
        const [, kind, id, alias] = boxedParticipant;
        ensureParticipant(id, kind as 'participant' | 'actor', alias, openBox.id);
        continue;
      }
      errors.push({ line: i + 1, content: rawLine, message: `Could not interpret line as a participant/actor inside a "box" block: "${line}"` });
      continue;
    }

    const autonumberMatch = line.match(AUTONUMBER_PATTERN);
    if (autonumberMatch) {
      const [, off, start, step] = autonumberMatch;
      autonumber = off ? undefined : { start: start ? Number.parseFloat(start) : undefined, step: step ? Number.parseFloat(step) : undefined };
      continue;
    }

    const boxStart = line.match(BOX_START);
    if (boxStart) {
      const [, color, title] = boxStart;
      containerCounter += 1;
      const id = `box${containerCounter}`;
      containersById.set(id, {
        id,
        label: title ?? '',
        role: 'box',
        position: nextPosition(),
        style: color ? { fillColor: color } : undefined,
      });
      openBox = { id, line: i + 1, content: rawLine };
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

    const activateMatch = line.match(ACTIVATE_PATTERN);
    if (activateMatch) {
      ensureParticipant(activateMatch[1]);
      pushPointItem('activate', activateMatch[1]);
      continue;
    }

    const deactivateMatch = line.match(DEACTIVATE_PATTERN);
    if (deactivateMatch) {
      ensureParticipant(deactivateMatch[1]);
      pushPointItem('deactivate', deactivateMatch[1]);
      continue;
    }

    const createMatch = line.match(CREATE_PATTERN);
    if (createMatch) {
      const [, kind, id, alias] = createMatch;
      ensureParticipant(id, kind as 'participant' | 'actor', alias);
      pushPointItem('create', id);
      continue;
    }

    const destroyMatch = line.match(DESTROY_PATTERN);
    if (destroyMatch) {
      ensureParticipant(destroyMatch[1]);
      pushPointItem('destroy', destroyMatch[1]);
      continue;
    }

    const blockStart = line.match(BLOCK_START);
    if (blockStart) {
      const [, keyword, arg] = blockStart;
      containerCounter += 1;
      const id = `block${containerCounter}`;
      const isRect = keyword === 'rect';
      containersById.set(id, {
        id,
        label: isRect ? '' : (arg ?? ''),
        role: keyword,
        position: nextPosition(),
        parentContainerId: currentContainerId(),
        sequenceOrder: orderCounter++,
        style: isRect && arg ? { fillColor: arg } : undefined,
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
        errors.push({ line: i + 1, content: rawLine, message: '"end" with no matching loop/alt/opt/par/critical/break/rect/box block' });
      } else {
        blockStack.pop();
      }
      continue;
    }

    const participantMatch = line.match(PARTICIPANT_PATTERN);
    if (participantMatch) {
      const [, kind, id, alias] = participantMatch;
      ensureParticipant(id, kind as 'participant' | 'actor', alias);
      continue;
    }

    const messageMatch = line.match(MESSAGE_PATTERN);
    if (messageMatch) {
      const [, source, arrowToken, activationSign, target, label] = messageMatch;
      ensureParticipant(source);
      ensureParticipant(target);
      edgeCounter += 1;
      const style = ARROW_TOKEN_TO_STYLE[arrowToken];
      const order = orderCounter++;
      edges.push({
        id: `e${edgeCounter}`,
        sourceId: source,
        targetId: target,
        label,
        sequenceOrder: order,
        containerId: currentContainerId(),
        arrow: style.arrow,
        lineStyle: style.lineStyle,
      });
      // '+' activates the arrow's TARGET; '-' deactivates the arrow's SOURCE (see
      // MESSAGE_PATTERN's own comment for why these aren't symmetric) — re-serializes as the
      // equivalent dedicated activate/deactivate statement rather than reconstructing the
      // shorthand, same "canonical form on serialize" convention already used for C4's Rel_Back.
      if (activationSign === '+') pushPointItem('activate', target);
      else if (activationSign === '-') pushPointItem('deactivate', source);
      continue;
    }

    errors.push({ line: i + 1, content: rawLine, message: `Could not interpret line as a participant, message, or directive: "${line}"` });
  }

  for (const open of blockStack) {
    errors.push({
      line: open.line,
      content: open.content,
      message: `Unclosed '${open.keyword}' block opened at line ${open.line}`,
    });
  }
  if (openBox) {
    errors.push({ line: openBox.line, content: openBox.content, message: `Unclosed 'box' block opened at line ${openBox.line}` });
  }

  if (errors.length > 0) return { errors };

  const model = createEmptyDiagramModel('sequence');
  model.nodes = Array.from(nodesById.values());
  model.edges = edges;
  model.containers = Array.from(containersById.values());
  if (autonumber) model.sequenceAutonumber = autonumber;
  model.title = title;
  return { model };
}

const NOTE_ROLE_TO_KEYWORD: Record<string, string> = {
  'note-left': 'Note left of',
  'note-right': 'Note right of',
  'note-over': 'Note over',
};
const ARROW_STYLE_TO_TOKEN: Record<string, string> = {
  'both|dotted': '<<-->>',
  'both|solid': '<<->>',
  'target|dotted': '-->>',
  'target|solid': '->>',
  'cross|dotted': '--x',
  'cross|solid': '-x',
  'open|dotted': '--)',
  'open|solid': '-)',
  'none|dotted': '-->',
  'none|solid': '->',
};

function serializeContainer(container: DiagramContainer, model: DiagramModel, indent: string): string[] {
  if (container.role === 'activate' || container.role === 'deactivate') {
    return [`${indent}${container.role} ${container.attachedNodeIds?.[0] ?? ''}`];
  }
  if (container.role === 'create') {
    const participantId = container.attachedNodeIds?.[0] ?? '';
    const node = model.nodes.find((n) => n.id === participantId);
    const kind = node?.role === 'actor' ? 'actor' : 'participant';
    const alias = node && node.label !== node.id ? ` as ${node.label}` : '';
    return [`${indent}create ${kind} ${participantId}${alias}`];
  }
  if (container.role === 'destroy') {
    return [`${indent}destroy ${container.attachedNodeIds?.[0] ?? ''}`];
  }
  const noteKeyword = container.role ? NOTE_ROLE_TO_KEYWORD[container.role] : undefined;
  if (noteKeyword) {
    const participants = (container.attachedNodeIds ?? []).join(', ');
    return [`${indent}${noteKeyword} ${participants}: ${container.label}`];
  }
  if (container.role === 'rect') {
    const color = container.style?.fillColor ?? 'rgb(0, 0, 0)';
    const lines = [`${indent}rect ${color}`];
    lines.push(...emitScope(container.id, model, `${indent}  `));
    lines.push(`${indent}end`);
    return lines;
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
      const token = ARROW_STYLE_TO_TOKEN[`${edge.arrow ?? 'target'}|${edge.lineStyle ?? 'solid'}`] ?? '->>';
      items.push({ order: edge.sequenceOrder ?? 0, lines: [`${indent}${edge.sourceId}${token}${edge.targetId}: ${edge.label ?? ''}`] });
    }
  }
  for (const container of model.containers) {
    // 'box' containers aren't part of the ordered timeline (see BOX_START's own comment) — they
    // never appear here, only in serializeSequence's own dedicated top-level pass.
    if (container.parentContainerId === containerId && container.role !== 'box') {
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
  if (model.title) lines.push(`title ${model.title}`);
  if (model.sequenceAutonumber) {
    const { start, step } = model.sequenceAutonumber;
    lines.push(start !== undefined && step !== undefined ? `autonumber ${start} ${step}` : 'autonumber');
  }

  const boxes = model.containers.filter((c) => c.role === 'box');
  const boxedNodeIds = new Set(boxes.flatMap((box) => model.nodes.filter((n) => n.containerId === box.id).map((n) => n.id)));
  // jmuir-dtu.4.1: a node introduced via a "create" statement gets that inline declaration
  // instead of the plain top-of-file one, wherever emitScope places its "create" container item.
  const createdNodeIds = new Set(model.containers.filter((c) => c.role === 'create').flatMap((c) => c.attachedNodeIds ?? []));
  for (const box of boxes) {
    const colorPart = box.style?.fillColor ? ` ${box.style.fillColor}` : '';
    const titlePart = box.label ? ` ${box.label}` : '';
    lines.push(`box${colorPart}${titlePart}`);
    for (const node of model.nodes) {
      if (node.containerId === box.id) lines.push(`  ${node.role === 'actor' ? 'actor' : 'participant'} ${node.id}${node.label !== node.id ? ` as ${node.label}` : ''}`);
    }
    lines.push('end');
  }
  for (const node of model.nodes) {
    if (boxedNodeIds.has(node.id) || createdNodeIds.has(node.id)) continue;
    const alias = node.label !== node.id ? ` as ${node.label}` : '';
    lines.push(`${node.role === 'actor' ? 'actor' : 'participant'} ${node.id}${alias}`);
  }
  lines.push(...emitScope(undefined, model, ''));

  return joinFrontMatter(frontMatter, `${lines.join('\n')}\n`);
}
