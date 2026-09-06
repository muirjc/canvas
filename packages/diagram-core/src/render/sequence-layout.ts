import type { DiagramContainer, DiagramEdge, DiagramModel, DiagramNode, Size } from '../model/diagram-model.js';

// canvas-7vs.1: the one shared geometry calculation for sequence-diagram lifeline/timeline
// rendering, called by BOTH svg-renderer.ts (export) and apps/web/src/canvas/Canvas.tsx
// (interactive canvas) — see contracts/sequence-layout-contract.md. Pure function: never mutates
// `model` or anything reachable from it, and never reads `node.position`/`container.position` for
// anything but participant-header fallback size (below) — every real x/y here is derived fresh
// from the model's own declaration/message order (research.md §1/§2, specs/
// 011-sequence-lifeline-rendering).

const LEFT_MARGIN = 40;
const HEADER_Y = 20;
const COLUMN_GAP = 40;
const ROW_HEIGHT = 50;
const MESSAGE_TOP_GAP = 40;
const BOTTOM_MARGIN = 40;
const RIGHT_MARGIN = 40;
const ACTIVATION_BAR_WIDTH = 10;
const ACTIVATION_LANE_STEP = 8;
const BLOCK_TOP_PAD = 24;
const BLOCK_BOTTOM_PAD = 16;
const BLOCK_SIDE_PAD = 20;
const SELF_MESSAGE_LOOP_WIDTH = 50;
const NOTE_SIDE_GAP = 10;

// Mirrors svg-renderer.ts's own module-private DEFAULT_NODE_SIZE exactly (same values, same
// convention as that file's own DEFAULT_CONTAINER_SIZE comment about the two files not otherwise
// sharing constants). Not imported directly: svg-renderer.ts imports THIS module, so importing the
// other direction back would be circular. Safe to keep local — a sequence-diagram participant is
// always a plain rectangle/person node (`ensureParticipant` in dsl/sequence.ts never sets an icon,
// attribute list, or member list), so it can never hit `nodeSize()`'s icon/table branches; the
// fallback this replicates (`node.size ?? DEFAULT_NODE_SIZE`) is the only case that ever applies.
const DEFAULT_HEADER_SIZE: Size = { width: 140, height: 60 };

function headerSize(node: DiagramNode): Size {
  return node.size ?? DEFAULT_HEADER_SIZE;
}

export interface LifelineLayout {
  /** Header box's own top-left x. */
  headerX: number;
  headerY: number;
  headerWidth: number;
  headerHeight: number;
  /** The lifeline itself: vertical center of the header box, spanning header bottom to the
   *  diagram's bottom margin. */
  x: number;
  top: number;
  bottom: number;
}

export interface MessageLayout {
  y: number;
  isSelfMessage: boolean;
}

export interface ActivationLayout {
  participantId: string;
  x: number;
  yStart: number;
  yEnd: number;
  laneOffset: number;
  width: number;
}

export interface BlockLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  /** true for an else/and/option branch divider — rendered as a horizontal line + label at `y`
   *  spanning [x, x+width], not a full bounding box (data-model.md "Control-flow blocks"). */
  isDivider: boolean;
}

export interface NoteLayout {
  x: number;
  y: number;
}

export interface BoxLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SequenceLayout {
  lifelines: Map<string, LifelineLayout>;
  messages: Map<string, MessageLayout>;
  activations: Map<string, ActivationLayout>;
  blocks: Map<string, BlockLayout>;
  notes: Map<string, NoteLayout>;
  boxes: Map<string, BoxLayout>;
  diagramWidth: number;
  diagramHeight: number;
}

function emptyLayout(): SequenceLayout {
  return {
    lifelines: new Map(),
    messages: new Map(),
    activations: new Map(),
    blocks: new Map(),
    notes: new Map(),
    boxes: new Map(),
    diagramWidth: 400,
    diagramHeight: 300,
  };
}

const TOP_LEVEL_BLOCK_ROLES = new Set(['loop', 'alt', 'opt', 'par', 'critical', 'break', 'rect']);
const DIVIDER_ROLES = new Set(['else', 'and', 'option']);
const NOTE_ROLES = new Set(['note-left', 'note-right', 'note-over']);

export function computeSequenceLayout(model: DiagramModel): SequenceLayout {
  if (model.nodes.length === 0 && model.edges.length === 0 && model.containers.length === 0) {
    return emptyLayout();
  }

  // --- Lifelines: one column per participant, in declaration order (model.nodes' own order —
  // ensureParticipant in dsl/sequence.ts already builds this in first-declaration order). ---
  const lifelines = new Map<string, LifelineLayout>();
  let cursorX = LEFT_MARGIN;
  let maxHeaderHeight = 0;
  for (const node of model.nodes) {
    const size = headerSize(node);
    maxHeaderHeight = Math.max(maxHeaderHeight, size.height);
    lifelines.set(node.id, {
      headerX: cursorX,
      headerY: HEADER_Y,
      headerWidth: size.width,
      headerHeight: size.height,
      x: cursorX + size.width / 2,
      // `top`/`bottom` filled in once diagramHeight is known, below.
      top: 0,
      bottom: 0,
    });
    cursorX += size.width + COLUMN_GAP;
  }
  const diagramWidth = model.nodes.length > 0 ? cursorX - COLUMN_GAP + RIGHT_MARGIN : 400;
  const lifelineTop = HEADER_Y + maxHeaderHeight;
  const messageTop = lifelineTop + MESSAGE_TOP_GAP;

  const rowY = (order: number): number => messageTop + order * ROW_HEIGHT;

  // --- Messages (including self-messages) — position purely from sequenceOrder. ---
  const messages = new Map<string, MessageLayout>();
  let maxOrder = -1;
  for (const edge of model.edges) {
    const order = edge.sequenceOrder ?? 0;
    maxOrder = Math.max(maxOrder, order);
    messages.set(edge.id, { y: rowY(order), isSelfMessage: edge.sourceId === edge.targetId });
  }

  // --- Containers: split by role into activations / (blocks + dividers) / notes / boxes. ---
  const containersById = new Map(model.containers.map((c) => [c.id, c]));
  const childrenByParent = new Map<string, DiagramContainer[]>();
  for (const container of model.containers) {
    if (container.parentContainerId === undefined) continue;
    const list = childrenByParent.get(container.parentContainerId) ?? [];
    list.push(container);
    childrenByParent.set(container.parentContainerId, list);
  }
  const edgesByContainer = new Map<string | undefined, DiagramEdge[]>();
  for (const edge of model.edges) {
    const list = edgesByContainer.get(edge.containerId) ?? [];
    list.push(edge);
    edgesByContainer.set(edge.containerId, list);
  }

  for (const container of model.containers) {
    if (container.sequenceOrder !== undefined) maxOrder = Math.max(maxOrder, container.sequenceOrder);
  }
  const diagramHeight = messageTop + (maxOrder + 1) * ROW_HEIGHT + BOTTOM_MARGIN;

  for (const lifeline of lifelines.values()) {
    lifeline.top = lifelineTop;
    lifeline.bottom = diagramHeight - BOTTOM_MARGIN / 2;
  }

  // Activation bars: pair the Nth `activate` for a participant with the Nth following
  // `deactivate` for that same participant (a per-participant open-count stack — no linked
  // pairing is stored on the model itself, matching diagram-model.ts's own doc comment).
  const activations = new Map<string, ActivationLayout>();
  const openActivationsByParticipant = new Map<string, { id: string; order: number }[]>();
  const activationLikeContainers = model.containers
    .filter((c) => c.role === 'activate' || c.role === 'deactivate')
    .sort((a, b) => (a.sequenceOrder ?? 0) - (b.sequenceOrder ?? 0));
  for (const container of activationLikeContainers) {
    const participantId = container.attachedNodeIds?.[0];
    if (!participantId) continue;
    const order = container.sequenceOrder ?? 0;
    if (container.role === 'activate') {
      const stack = openActivationsByParticipant.get(participantId) ?? [];
      stack.push({ id: container.id, order });
      openActivationsByParticipant.set(participantId, stack);
    } else {
      const stack = openActivationsByParticipant.get(participantId) ?? [];
      const opening = stack.pop();
      const lifeline = lifelines.get(participantId);
      if (opening && lifeline) {
        const laneOffset = stack.length;
        activations.set(opening.id, {
          participantId,
          x: lifeline.x + laneOffset * ACTIVATION_LANE_STEP,
          yStart: rowY(opening.order),
          yEnd: rowY(order),
          laneOffset,
          width: ACTIVATION_BAR_WIDTH,
        });
      }
    }
  }
  // Any `activate` left open with no matching `deactivate` (malformed, not a parse error) still
  // gets finite, well-formed geometry: extend to the diagram's own bottom margin (data-model.md's
  // defensive default) rather than propagating undefined/NaN.
  for (const [participantId, stack] of openActivationsByParticipant) {
    const lifeline = lifelines.get(participantId);
    if (!lifeline) continue;
    stack.forEach((opening, index) => {
      activations.set(opening.id, {
        participantId,
        x: lifeline.x + index * ACTIVATION_LANE_STEP,
        yStart: rowY(opening.order),
        yEnd: lifeline.bottom,
        laneOffset: index,
        width: ACTIVATION_BAR_WIDTH,
      });
    });
  }

  // Blocks (loop/alt/opt/par/critical/break/rect) and their else/and/option dividers.
  const descendantContainerIds = (rootId: string): Set<string> => {
    const result = new Set<string>([rootId]);
    const stack = [rootId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const child of childrenByParent.get(current) ?? []) {
        if (!result.has(child.id)) {
          result.add(child.id);
          stack.push(child.id);
        }
      }
    }
    return result;
  };

  const blocks = new Map<string, BlockLayout>();
  const topLevelBlocks = model.containers.filter((c) => c.role && TOP_LEVEL_BLOCK_ROLES.has(c.role));
  for (const block of topLevelBlocks) {
    const descendantIds = descendantContainerIds(block.id);
    const minOrder = block.sequenceOrder ?? 0;
    let maxChildOrder = block.sequenceOrder ?? 0;
    const participantIds = new Set<string>();
    for (const id of descendantIds) {
      const descendant = containersById.get(id)!;
      if (descendant.sequenceOrder !== undefined) maxChildOrder = Math.max(maxChildOrder, descendant.sequenceOrder);
      for (const participantId of descendant.attachedNodeIds ?? []) participantIds.add(participantId);
      for (const edge of edgesByContainer.get(id) ?? []) {
        maxChildOrder = Math.max(maxChildOrder, edge.sequenceOrder ?? 0);
        participantIds.add(edge.sourceId);
        participantIds.add(edge.targetId);
      }
    }
    const xs = [...participantIds].map((id) => lifelines.get(id)?.x).filter((x): x is number => x !== undefined);
    const left = xs.length > 0 ? Math.min(...xs) - BLOCK_SIDE_PAD : LEFT_MARGIN;
    const right = xs.length > 0 ? Math.max(...xs) + BLOCK_SIDE_PAD : diagramWidth - RIGHT_MARGIN;
    const top = rowY(minOrder) - BLOCK_TOP_PAD;
    const bottom = rowY(maxChildOrder) + BLOCK_BOTTOM_PAD;
    blocks.set(block.id, { x: left, y: top, width: right - left, height: bottom - top, isDivider: false });

    // else/and/option children of this block: a horizontal divider at their own row, spanning the
    // parent block's own x/width (data-model.md — not a nested box).
    for (const child of childrenByParent.get(block.id) ?? []) {
      if (child.role && DIVIDER_ROLES.has(child.role)) {
        blocks.set(child.id, { x: left, y: rowY(child.sequenceOrder ?? 0) - BLOCK_TOP_PAD / 2, width: right - left, height: 0, isDivider: true });
      }
    }
  }

  // Notes: position only — size stays whatever dsl/sequence.ts's noteSize() already computed
  // (data-model.md "Notes").
  const notes = new Map<string, NoteLayout>();
  for (const container of model.containers) {
    if (!container.role || !NOTE_ROLES.has(container.role)) continue;
    const attachedIds = container.attachedNodeIds ?? [];
    const xs = attachedIds.map((id) => lifelines.get(id)?.x).filter((x): x is number => x !== undefined);
    const y = rowY(container.sequenceOrder ?? 0) - ROW_HEIGHT / 4;
    if (container.role === 'note-over') {
      const left = xs.length > 0 ? Math.min(...xs) : LEFT_MARGIN;
      const right = xs.length > 0 ? Math.max(...xs) : LEFT_MARGIN;
      notes.set(container.id, { x: (left + right) / 2 - (container.size?.width ?? 0) / 2, y });
      continue;
    }
    const anchorX = xs[0] ?? LEFT_MARGIN;
    const width = container.size?.width ?? 0;
    notes.set(
      container.id,
      container.role === 'note-left' ? { x: anchorX - width - NOTE_SIDE_GAP, y } : { x: anchorX + NOTE_SIDE_GAP, y },
    );
  }

  // Box groupings: full diagram height, horizontal span from member participants' lifelines.
  const boxes = new Map<string, BoxLayout>();
  for (const container of model.containers) {
    if (container.role !== 'box') continue;
    const memberXs = model.nodes
      .filter((n) => n.containerId === container.id)
      .map((n) => lifelines.get(n.id)?.x)
      .filter((x): x is number => x !== undefined);
    const left = memberXs.length > 0 ? Math.min(...memberXs) - BLOCK_SIDE_PAD : LEFT_MARGIN;
    const right = memberXs.length > 0 ? Math.max(...memberXs) + BLOCK_SIDE_PAD : diagramWidth - RIGHT_MARGIN;
    boxes.set(container.id, { x: left, y: HEADER_Y - 10, width: right - left, height: diagramHeight - HEADER_Y + 10 });
  }

  return { lifelines, messages, activations, blocks, notes, boxes, diagramWidth, diagramHeight };
}

export { SELF_MESSAGE_LOOP_WIDTH };
