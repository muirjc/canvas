// canvas-bnnh: Mermaid state diagrams (`stateDiagram-v2`, and the older `stateDiagram` header), checked
// against Mermaid 12.3's docs and its stateDiagram.jison grammar.
//
// How the syntax maps onto the model:
// - A state is a node (role 'state', a rounded rectangle). Its label is the `state "Label" as id` text
//   (the id when there's none); `id : text` lines are its description (several lines join with '\n').
// - `[*]` is a start or end pseudo-state, one of each per scope (the diagram, a composite state, or a
//   concurrent region), as Mermaid draws them: nodes `<scope>_start` / `<scope>_end` (`root_` at the top),
//   role 'start'/'end', shapes 'state-start'/'state-end'. Which one a `[*]` is follows the arrow.
// - `<<choice>>` is a diamond (role 'choice'); `<<fork>>`/`<<join>>` are bars (role 'fork'/'join').
// - A composite state `state X { ... }` is a container (role 'composite'); connectors may point at it.
//   Concurrent regions (`--` lines inside it) are child containers (role 'region', `<X>__region<n>`).
// - A note is a container (role 'note-left'/'note-right') attached to its state (`attachedNodeIds`).
// - A connector's `containerId` is the scope it was written in, so it's written back there (`[*]` is
//   scoped).
// - `classDef` / `class` / `:::` / `style` fold into each state's style, like flowchart: front matter is
//   the canonical record, the class lines aren't written back. `click` links use the shared link check.
// - `title` comes from the front matter (Mermaid's only title form for state diagrams); `hide empty
//   description` and `scale` are accepted and not kept (no rendering equivalent here).
import {
  createEmptyDiagramModel,
  isAllowedLinkHref,
  type DiagramContainer,
  type DiagramEdge,
  type DiagramModel,
  type DiagramNode,
  type FlowchartDirection,
  type NodeStyle,
} from '../model/diagram-model.js';
import { computeContainmentLayout } from '../model/containment-layout.js';
import {
  joinFrontMatter,
  NO_ENTRIES,
  readLegend,
  readPinned,
  splitFrontMatter,
  stripTrailingComment,
  withLegend,
  withPinned,
  type CanvasFrontMatter,
} from './front-matter.js';
import type { ParseError, ParseResult } from './types.js';

// Mermaid's state ids can't hold whitespace, `:`, `-`, `{`; quotes, `%`, `;`, `,`, brackets and `<>` are
// left out too so every other construct stays unambiguous.
const ID = String.raw`[^\s:{}"%;,\[\]<>\-]+`;
const ENDPOINT = String.raw`(\[\*\]|${ID})(?::::(\w+))?`;

const HEADER = /^stateDiagram(?:-v2)?$/i;
const MERMAID_CONFIG_DIRECTIVE = /^%%\{.*\}%%$/;
const DIRECTION = /^direction\s+(TB|BT|LR|RL)$/i;
const TITLE = /^title\s+(.+)$/;
const ACC_TITLE = /^accTitle\s*:\s*(.+)$/;
const ACC_DESCR = /^accDescr\s*:\s*(.+)$/;
const ACC_DESCR_BLOCK = /^accDescr\s*\{\s*$/;
const IGNORED = [/^hide\s+empty\s+description$/i, /^scale\s+\d+\s+width$/i];
const CLASS_DEF = /^classDef\s+(\w+)\s+(.+)$/;
const CLASS_ASSIGN = /^class\s+(\w+(?:\s*,\s*\w+)*)\s+(\w+)$/;
const STYLE = /^style\s+([\w,]+)\s+(.+)$/;
const CLICK_HREF = new RegExp(`^click\\s+(${ID})\\s+href\\s+"([^"]*)"(?:\\s+"([^"]*)")?$`);
const CLICK_URL = new RegExp(`^click\\s+(${ID})\\s+"([^"]*)"(?:\\s+"([^"]*)")?$`);
const CLICK_CALL = new RegExp(`^click\\s+(${ID})\\s+call\\b`);
const NOTE_LINE = new RegExp(`^note\\s+(left|right)\\s+of\\s+(${ID})\\s*:\\s*(.+)$`, 'i');
const NOTE_START = new RegExp(`^note\\s+(left|right)\\s+of\\s+(${ID})$`, 'i');
const NOTE_END = /^end\s+note$/i;
const COMPOSITE_ALIAS_START = new RegExp(`^state\\s+"([^"]*)"\\s+as\\s+(${ID})\\s*\\{$`);
const COMPOSITE_START = new RegExp(`^state\\s+(${ID})\\s*\\{$`);
const BLOCK_END = /^\}$/;
const STEREOTYPE = new RegExp(`^state\\s+(${ID})\\s*(?:<<(choice|fork|join)>>|\\[\\[(choice|fork|join)\\]\\])$`, 'i');
const STATE_ALIAS = new RegExp(`^state\\s+"([^"]*)"\\s+as\\s+(${ID})(?:\\s*:\\s*(.+))?$`);
const STATE_BARE = new RegExp(`^state\\s+(${ID})$`);
const CONCURRENCY = /^--$/;
const TRANSITION = new RegExp(`^${ENDPOINT}\\s*-->\\s*${ENDPOINT}(?:\\s*:\\s*(.*))?$`);
const DESCRIPTION = new RegExp(`^(${ID})\\s*:\\s*(.+)$`);
const STATE_REF = new RegExp(`^${ENDPOINT}$`);

const PSEUDO_ROLES: Record<string, NonNullable<DiagramNode['role']>> = { choice: 'choice', fork: 'fork', join: 'join' };
const ROLE_SHAPE: Record<string, DiagramNode['shape']> = {
  state: 'rounded-rectangle',
  start: 'state-start',
  end: 'state-end',
  choice: 'diamond',
  fork: 'fork-bar',
  join: 'fork-bar',
};

function parseStyleProps(propsRaw: string): NodeStyle {
  const style: NodeStyle = {};
  for (const prop of propsRaw.replace(/;\s*$/, '').split(',')) {
    const [key, value] = prop.split(':').map((part) => part.trim());
    if (key === 'fill') style.fillColor = value;
    else if (key === 'stroke') style.strokeColor = value;
    else if (key === 'stroke-width') style.strokeWidth = Number.parseFloat(value);
    else if (key === 'stroke-dasharray') style.strokeDasharray = value;
  }
  return style;
}

/** Where a statement sits while parsing: the diagram (''), or region `region` of a composite. Regions
 *  only become containers once the whole composite is read (a `--` can come after its first states). */
interface Scope {
  composite: string;
  region: number;
}
const scopeKey = (scope: Scope | undefined): string => (scope ? `${scope.composite}\u0000${scope.region}` : '');

const PLACEHOLDER_POSITION = { x: 0, y: 0 };

/** A group's saved size, when the front matter gives both (a null counts as none). */
const savedSize = (meta: { width?: number | null; height?: number | null } | undefined) =>
  meta && meta.width != null && meta.height != null ? { size: { width: meta.width, height: meta.height } } : {};

export function parseState(dsl: string): ParseResult {
  const { frontMatter, body } = splitFrontMatter(dsl);
  const positions = frontMatter.canvas?.positions ?? NO_ENTRIES;
  const styles = frontMatter.canvas?.styles ?? NO_ENTRIES;
  const containerMeta = frontMatter.canvas?.containers ?? NO_ENTRIES;
  const isFreshImport = Object.keys(positions).length === 0 && Object.keys(containerMeta).length === 0;
  let autoCounter = 0;
  const nextPosition = () => {
    const position = { x: (autoCounter % 5) * 200 + 40, y: Math.floor(autoCounter / 5) * 140 + 40 };
    autoCounter += 1;
    return position;
  };
  const place = (id: string) => positions[id] ?? (isFreshImport ? PLACEHOLDER_POSITION : nextPosition());

  const errors: ParseError[] = [];
  const nodes = new Map<string, DiagramNode>();
  /** The scope each node was first mentioned in (resolved into containerId at the end). */
  const nodeScope = new Map<string, string>();
  const composites = new Map<string, DiagramContainer>();
  /** Composite id -> the scope it sits in, and how many regions it has. */
  const compositeScope = new Map<string, string>();
  const regionCount = new Map<string, number>();
  const notes: { container: DiagramContainer; scope: string }[] = [];
  const edges: { edge: DiagramEdge; scope: string }[] = [];
  const classDefs = new Map<string, NodeStyle>();
  const classUses: { ids: string[]; className: string }[] = [];
  const styleUses: { ids: string[]; propsRaw: string }[] = [];
  const stack: (Scope & { line: number; content: string })[] = [];
  let headerSeen = false;
  let direction: FlowchartDirection | undefined;
  let title = typeof (frontMatter as Record<string, unknown>).title === 'string' ? ((frontMatter as Record<string, unknown>).title as string) : undefined;
  let accTitle: string | undefined;
  let accDescr: string | undefined;
  let mermaidConfigDirective: string | undefined;
  let openNote: { side: string; target: string; text: string[]; line: number; content: string } | null = null;
  let openAccDescr: string[] | null = null;
  let edgeCounter = 0;

  const currentScope = (): Scope | undefined => stack[stack.length - 1];

  /** A pseudo-state's temporary id, per scope; renamed once regions are known. */
  const pseudoId = (kind: 'start' | 'end', scope: Scope | undefined) => `\u0000${kind}\u0000${scopeKey(scope)}`;

  const ensureNode = (id: string, scope: Scope | undefined, role = 'state'): DiagramNode | undefined => {
    if (composites.has(id)) return undefined;
    let node = nodes.get(id);
    if (!node) {
      // Choice, fork and join show no text (Mermaid draws none); a state shows its id until it's named.
      node = { id, label: role === 'state' ? id : '', shape: ROLE_SHAPE[role], role, position: place(id), style: styles[id] };
      nodes.set(id, node);
      nodeScope.set(id, scopeKey(scope));
    }
    return node;
  };
  const endpoint = (raw: string, kind: 'start' | 'end', scope: Scope | undefined): string => {
    if (raw !== '[*]') {
      ensureNode(raw, scope);
      return raw;
    }
    const id = pseudoId(kind, scope);
    if (!nodes.has(id)) {
      nodes.set(id, { id, label: '', shape: ROLE_SHAPE[kind], role: kind, position: PLACEHOLDER_POSITION });
      nodeScope.set(id, scopeKey(scope));
    }
    return id;
  };

  const lines = body.split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    if (openNote) {
      if (NOTE_END.test(rawLine.trim())) {
        const scope = currentScope();
        ensureNode(openNote.target, scope);
        notes.push({
          container: {
            id: `note${notes.length + 1}`,
            label: openNote.text.join('\n').trim(),
            role: `note-${openNote.side}`,
            attachedNodeIds: [openNote.target],
            position: PLACEHOLDER_POSITION,
          },
          scope: scopeKey(scope),
        });
        openNote = null;
      } else {
        openNote.text.push(rawLine.trim());
      }
      return;
    }
    if (openAccDescr) {
      if (rawLine.trim() === '}') {
        accDescr = openAccDescr.join('\n').trim();
        openAccDescr = null;
      } else {
        openAccDescr.push(rawLine.trim());
      }
      return;
    }
    const trimmed = rawLine.trim();
    if (MERMAID_CONFIG_DIRECTIVE.test(trimmed)) {
      mermaidConfigDirective = trimmed;
      return;
    }
    const line = stripTrailingComment(trimmed).trim();
    if (!line || line.startsWith('#')) return;

    if (!headerSeen) {
      if (HEADER.test(line)) {
        headerSeen = true;
        return;
      }
      errors.push({ line: lineNumber, content: rawLine, message: 'Expected a "stateDiagram-v2" header.' });
      headerSeen = true;
      return;
    }
    const scope = currentScope();
    const fail = (message: string) => errors.push({ line: lineNumber, content: rawLine, message });

    let m: RegExpMatchArray | null;
    if ((m = line.match(DIRECTION))) {
      const value = m[1].toUpperCase() as FlowchartDirection;
      if (scope) composites.get(scope.composite)!.direction = value;
      else direction = value;
      return;
    }
    if (!scope && (m = line.match(TITLE))) {
      title = m[1];
      return;
    }
    if (!scope && (m = line.match(ACC_TITLE))) {
      accTitle = m[1];
      return;
    }
    if (!scope && ACC_DESCR_BLOCK.test(line)) {
      openAccDescr = [];
      return;
    }
    if (!scope && (m = line.match(ACC_DESCR))) {
      accDescr = m[1];
      return;
    }
    if (IGNORED.some((pattern) => pattern.test(line))) return;
    if ((m = line.match(CLASS_DEF))) {
      classDefs.set(m[1], { ...classDefs.get(m[1]), ...parseStyleProps(m[2]) });
      return;
    }
    if ((m = line.match(CLASS_ASSIGN))) {
      classUses.push({ ids: m[1].split(',').map((id) => id.trim()), className: m[2] });
      return;
    }
    if ((m = line.match(STYLE))) {
      styleUses.push({ ids: m[1].split(',').filter(Boolean), propsRaw: m[2] });
      return;
    }
    if (CLICK_CALL.test(line)) {
      fail('"click <id> call ..." is not supported (it runs script); use "click <id> href \\"<url>\\"".');
      return;
    }
    if ((m = line.match(CLICK_HREF) ?? line.match(CLICK_URL))) {
      const [, id, href, tooltip] = m;
      if (!isAllowedLinkHref(href)) {
        fail(`Link "${href}" is not allowed: only http(s) URLs or relative paths.`);
        return;
      }
      const node = ensureNode(id, scope);
      if (node) node.link = { href, ...(tooltip ? { tooltip } : {}) };
      return;
    }
    if ((m = line.match(NOTE_LINE))) {
      ensureNode(m[2], scope);
      notes.push({
        container: {
          id: `note${notes.length + 1}`,
          label: m[3].trim(),
          role: `note-${m[1].toLowerCase()}`,
          attachedNodeIds: [m[2]],
          position: PLACEHOLDER_POSITION,
        },
        scope: scopeKey(scope),
      });
      return;
    }
    if ((m = line.match(NOTE_START))) {
      openNote = { side: m[1].toLowerCase(), target: m[2], text: [], line: lineNumber, content: rawLine };
      return;
    }
    if ((m = line.match(COMPOSITE_ALIAS_START) ?? line.match(COMPOSITE_START))) {
      const [label, id] = m.length === 3 ? [m[1], m[2]] : [undefined, m[1]];
      if (composites.has(id) || stack.some((s) => s.composite === id)) {
        fail(`Composite state "${id}" is already defined.`);
        return;
      }
      // A state mentioned before its block (`A --> B` then `state B { ... }`) becomes the composite.
      const earlier = nodes.get(id);
      if (earlier && earlier.role !== 'state') {
        fail(`"${id}" is already a ${earlier.role} state.`);
        return;
      }
      nodes.delete(id);
      const priorScope = earlier ? nodeScope.get(id)! : scopeKey(scope);
      nodeScope.delete(id);
      const meta = containerMeta[id];
      composites.set(id, {
        id,
        label: label ?? earlier?.description ?? id,
        role: 'composite',
        position: meta ? { x: meta.x, y: meta.y } : PLACEHOLDER_POSITION,
        ...savedSize(meta),
        ...(earlier?.style ? { style: earlier.style } : styles[id] ? { style: styles[id] } : {}),
      });
      compositeScope.set(id, priorScope);
      regionCount.set(id, 1);
      stack.push({ composite: id, region: 0, line: lineNumber, content: rawLine });
      return;
    }
    if (BLOCK_END.test(line)) {
      if (!stack.pop()) fail('"}" with no open composite state.');
      return;
    }
    if (CONCURRENCY.test(line)) {
      if (!scope) {
        fail('"--" (concurrent regions) only belongs inside a composite state.');
        return;
      }
      scope.region += 1;
      regionCount.set(scope.composite, scope.region + 1);
      return;
    }
    if ((m = line.match(STEREOTYPE))) {
      const role = PSEUDO_ROLES[(m[2] ?? m[3]).toLowerCase()];
      const node = ensureNode(m[1], scope, role);
      if (node) {
        node.role = role;
        node.shape = ROLE_SHAPE[role];
        if (node.label === node.id) node.label = '';
      }
      return;
    }
    if ((m = line.match(STATE_ALIAS))) {
      const node = ensureNode(m[2], scope);
      if (node) {
        node.label = m[1];
        if (m[3]) node.description = node.description ? `${node.description}\n${m[3].trim()}` : m[3].trim();
      }
      return;
    }
    if ((m = line.match(STATE_BARE))) {
      ensureNode(m[1], scope);
      return;
    }
    if ((m = line.match(TRANSITION))) {
      const [, from, fromClass, to, toClass, label] = m;
      const sourceId = endpoint(from, 'start', scope);
      const targetId = endpoint(to, 'end', scope);
      if (fromClass) classUses.push({ ids: [sourceId], className: fromClass });
      if (toClass) classUses.push({ ids: [targetId], className: toClass });
      edgeCounter += 1;
      const edge: DiagramEdge = { id: `e${edgeCounter}`, sourceId, targetId, arrow: 'target' };
      if (label !== undefined && label.trim()) edge.label = label.trim();
      edges.push({ edge, scope: scopeKey(scope) });
      return;
    }
    if ((m = line.match(STATE_REF))) {
      const id = m[1] === '[*]' ? undefined : m[1];
      if (!id) {
        fail('"[*]" on its own is not a statement.');
        return;
      }
      ensureNode(id, scope);
      if (m[2]) classUses.push({ ids: [id], className: m[2] });
      return;
    }
    if ((m = line.match(DESCRIPTION))) {
      const composite = composites.get(m[1]);
      if (composite) {
        composite.label = m[2].trim();
        return;
      }
      const node = ensureNode(m[1], scope);
      if (node) node.description = node.description ? `${node.description}\n${m[2].trim()}` : m[2].trim();
      return;
    }
    fail('Could not interpret line as a state, transition, note or composite state.');
  });

  const unclosedNote = openNote as { line: number; content: string } | null; // set inside the loop's callback
  if (unclosedNote) errors.push({ line: unclosedNote.line, content: unclosedNote.content, message: 'Note has no "end note".' });
  for (const open of stack) errors.push({ line: open.line, content: open.content, message: `Composite state "${open.composite}" has no closing "}".` });
  if (!headerSeen) errors.push({ line: 1, content: '', message: 'Expected a "stateDiagram-v2" header.' });
  if (errors.length > 0) return { errors };

  // Regions: a composite with more than one becomes a container per region; every scope key then
  // resolves to the container it means (the composite itself, a region, or the top level).
  const regions: DiagramContainer[] = [];
  const containerOfScope = new Map<string, string | undefined>([['', undefined]]);
  for (const [id, count] of regionCount) {
    if (count === 1) {
      containerOfScope.set(`${id}\u00000`, id);
      continue;
    }
    for (let k = 0; k < count; k++) {
      const regionId = `${id}__region${k + 1}`;
      const meta = containerMeta[regionId];
      regions.push({
        id: regionId,
        label: '',
        role: 'region',
        parentContainerId: id,
        position: meta ? { x: meta.x, y: meta.y } : PLACEHOLDER_POSITION,
        ...savedSize(meta),
      });
      containerOfScope.set(`${id}\u0000${k}`, regionId);
    }
  }
  const resolve = (key: string) => containerOfScope.get(key);

  // Pseudo-states get their final ids: `<scope container>_start` (`root_start` at the top).
  const renamed = new Map<string, string>();
  for (const node of nodes.values()) {
    if (!node.id.startsWith('\u0000')) continue;
    const kind = node.id.slice(1, node.id.indexOf('\u0000', 1));
    const key = node.id.slice(node.id.indexOf('\u0000', 1) + 1);
    const finalId = `${resolve(key) ?? 'root'}_${kind}`;
    renamed.set(node.id, finalId);
  }
  const finalNodes: DiagramNode[] = [];
  for (const node of nodes.values()) {
    const id = renamed.get(node.id) ?? node.id;
    const containerId = resolve(nodeScope.get(node.id) ?? '');
    finalNodes.push({
      ...node,
      id,
      position: renamed.has(node.id) ? place(id) : node.position,
      ...(renamed.has(node.id) && styles[id] ? { style: styles[id] } : {}),
      ...(containerId ? { containerId } : {}),
    });
  }
  const byId = new Map(finalNodes.map((n) => [n.id, n]));

  // Styles, as flowchart applies them: classes in order, then `style` lines; front-matter styles win.
  const apply = (id: string, style: NodeStyle) => {
    const target = byId.get(renamed.get(id) ?? id) ?? composites.get(id);
    // A class with nothing Canvas keeps (font-style, ...) adds no style at all, as on reload.
    if (target && !styles[target.id] && Object.keys(style).length > 0) target.style = { ...target.style, ...style };
  };
  for (const { ids, className } of classUses) {
    const style = classDefs.get(className);
    if (style) for (const id of ids) apply(id, style);
  }
  for (const { ids, propsRaw } of styleUses) for (const id of ids) apply(id, parseStyleProps(propsRaw));

  const containers: DiagramContainer[] = [];
  for (const composite of composites.values()) {
    const parentContainerId = resolve(compositeScope.get(composite.id) ?? '');
    containers.push({ ...composite, ...(parentContainerId ? { parentContainerId } : {}) });
  }
  containers.push(...regions);
  for (const { container, scope } of notes) {
    const meta = containerMeta[container.id];
    const parentContainerId = resolve(scope);
    containers.push({
      ...container,
      attachedNodeIds: container.attachedNodeIds!.map((id) => (composites.has(id) ? id : (renamed.get(id) ?? id))),
      position: meta ? { x: meta.x, y: meta.y } : PLACEHOLDER_POSITION,
      ...savedSize(meta),
      ...(parentContainerId ? { parentContainerId } : {}),
    });
  }

  const finalEdges = edges.map(({ edge, scope }) => {
    const containerId = resolve(scope);
    return {
      ...edge,
      sourceId: renamed.get(edge.sourceId) ?? edge.sourceId,
      targetId: renamed.get(edge.targetId) ?? edge.targetId,
      ...(containerId ? { containerId } : {}),
      ...(frontMatter.canvas?.edgeStyles?.[edge.id] ? { style: frontMatter.canvas.edgeStyles[edge.id] } : {}),
    };
  });

  if (isFreshImport) {
    const layout = computeContainmentLayout(finalNodes, containers);
    for (const node of finalNodes) node.position = layout.nodePositions.get(node.id) ?? node.position;
    for (const container of containers) {
      container.position = layout.containerPositions.get(container.id) ?? container.position;
      const size = layout.containerSizes.get(container.id);
      if (size) container.size = size;
    }
  }

  const model = createEmptyDiagramModel('state');
  model.nodes = finalNodes;
  model.containers = containers;
  model.edges = finalEdges;
  model.direction = direction;
  model.title = title;
  model.accTitle = accTitle;
  model.accDescr = accDescr;
  model.mermaidConfigDirective = mermaidConfigDirective;
  model.legend = readLegend(frontMatter);
  const pinned = readPinned(frontMatter, model);
  if (pinned) model.pinned = pinned;
  return { model };
}

// --- serializing -----------------------------------------------------------------------------------

const PSEUDO_ROLE_KEYWORD: Record<string, string> = { choice: 'choice', fork: 'fork', join: 'join' };

/** Text that fits `state "…" as id` (no quote) and stays on one line. */
const quotable = (text: string) => !text.includes('"') && !/[\r\n]/.test(text);

export function serializeState(model: DiagramModel): string {
  const isPseudo = (node: DiagramNode) => node.role === 'start' || node.role === 'end';
  const lines: string[] = [];
  if (model.mermaidConfigDirective) lines.push(model.mermaidConfigDirective);
  lines.push('stateDiagram-v2');
  if (model.accTitle) lines.push(`  accTitle: ${model.accTitle}`);
  if (model.accDescr && /[\r\n]/.test(model.accDescr)) {
    lines.push('  accDescr {', ...model.accDescr.split(/\r?\n/).map((line) => `    ${line.trim()}`), '  }');
  } else if (model.accDescr) {
    lines.push(`  accDescr: ${model.accDescr}`);
  }
  if (model.direction) lines.push(`  direction ${model.direction === 'TD' ? 'TB' : model.direction}`);

  const nodeById = new Map(model.nodes.map((n) => [n.id, n]));
  const containerIds = new Set(model.containers.map((c) => c.id));
  const ref = (id: string) => {
    const node = nodeById.get(id);
    return node && isPseudo(node) ? '[*]' : id;
  };
  const inScope = <T extends { containerId?: string }>(items: T[], scope: string | undefined) =>
    items.filter((item) => (item.containerId && containerIds.has(item.containerId) ? item.containerId : undefined) === scope);
  const childContainers = (scope: string | undefined) =>
    model.containers.filter((c) => (c.parentContainerId && containerIds.has(c.parentContainerId) ? c.parentContainerId : undefined) === scope);
  const emittedEdges: DiagramEdge[] = [];
  const emittedNotes: DiagramContainer[] = [];
  const mentioned = new Set(model.edges.flatMap((e) => [e.sourceId, e.targetId]));

  const edgeIndex = new Map(model.edges.map((edge, i) => [edge.id, i]));
  /** The earliest connector inside a composite (at any depth): where its block goes. */
  const firstEdgeWithin = (containerId: string): number => {
    const inside = new Set<string>();
    const walk = (id: string) => {
      inside.add(id);
      for (const child of model.containers) if (child.parentContainerId === id && !inside.has(child.id)) walk(child.id);
    };
    walk(containerId);
    let first = Number.MAX_SAFE_INTEGER;
    for (const edge of model.edges) if (edge.containerId && inside.has(edge.containerId)) first = Math.min(first, edgeIndex.get(edge.id)!);
    return first;
  };
  const emitComposite = (container: DiagramContainer, indent: string) => {
    const head = container.label && container.label !== container.id && quotable(container.label) ? `state "${container.label}" as ${container.id} {` : `state ${container.id} {`;
    lines.push(`${indent}${head}`);
    if (container.direction) lines.push(`${indent}  direction ${container.direction === 'TD' ? 'TB' : container.direction}`);
    const regions = childContainers(container.id).filter((c) => c.role === 'region');
    emitScope(container.id, `${indent}  `);
    regions.forEach((region, i) => {
      if (i > 0) lines.push(`${indent}  --`);
      emitScope(region.id, `${indent}  `);
    });
    lines.push(`${indent}}`);
  };

  const emitScope = (scope: string | undefined, indent: string): void => {
    for (const node of inScope(model.nodes, scope)) {
      if (isPseudo(node)) continue;
      const keyword = node.role ? PSEUDO_ROLE_KEYWORD[node.role] : undefined;
      if (keyword) {
        lines.push(`${indent}state ${node.id} <<${keyword}>>`);
        continue;
      }
      if (node.label && node.label !== node.id && quotable(node.label)) {
        lines.push(`${indent}state "${node.label}" as ${node.id}`);
      } else if (!node.description && !mentioned.has(node.id)) {
        lines.push(`${indent}${node.id}`);
      }
      for (const text of (node.description ?? '').split('\n').filter((t) => t.trim())) {
        lines.push(`${indent}${node.id} : ${text.trim()}`);
      }
    }
    // Connectors and composite blocks in the order the connectors were read (a block goes where its
    // first connector was), so reading this text back gives every connector the same id (`e<n>`).
    const items: { key: number; emit: () => void }[] = [];
    for (const edge of inScope(model.edges, scope)) {
      items.push({
        key: edgeIndex.get(edge.id) ?? Number.MAX_SAFE_INTEGER,
        emit: () => {
          emittedEdges.push(edge);
          const label = edge.label ? ` : ${edge.label.replace(/[\r\n]+/g, ' ')}` : '';
          lines.push(`${indent}${ref(edge.sourceId)} --> ${ref(edge.targetId)}${label}`);
        },
      });
    }
    for (const container of childContainers(scope)) {
      if (container.role === 'composite') items.push({ key: firstEdgeWithin(container.id), emit: () => emitComposite(container, indent) });
    }
    // A stable sort: equal keys (composites with no connectors) keep their order.
    items.sort((a, b) => a.key - b.key).forEach((item) => item.emit());
    for (const note of childContainers(scope)) {
      if (note.role !== 'note-left' && note.role !== 'note-right') continue;
      const target = note.attachedNodeIds?.[0];
      if (!target) continue;
      const side = note.role === 'note-left' ? 'left' : 'right';
      emittedNotes.push(note);
      const text = note.label ?? '';
      if (/[\r\n:;]/.test(text)) {
        lines.push(`${indent}note ${side} of ${target}`);
        for (const textLine of text.split(/\r?\n/)) lines.push(`${indent}  ${textLine}`);
        lines.push(`${indent}end note`);
      } else {
        lines.push(`${indent}note ${side} of ${target} : ${text}`);
      }
    }
    for (const node of inScope(model.nodes, scope)) {
      if (!node.link || !isAllowedLinkHref(node.link.href)) continue;
      lines.push(
        node.link.tooltip
          ? `${indent}click ${node.id} "${node.link.href}" "${node.link.tooltip}"`
          : `${indent}click ${node.id} href "${node.link.href}"`,
      );
    }
  };
  emitScope(undefined, '  ');

  // A note's id is likewise its place in the text (`note<n>`) when read back.
  const noteIds = new Map(emittedNotes.map((note, i) => [note.id, `note${i + 1}`]));
  const savedId = (id: string) => noteIds.get(id) ?? id;
  const frontMatter: CanvasFrontMatter & { title?: string } = {
    ...(model.title ? { title: model.title } : {}),
    canvas: {
      positions: Object.fromEntries(model.nodes.map((n) => [n.id, { x: n.position.x, y: n.position.y }])),
      containers: Object.fromEntries(
        model.containers.map((c) => [
          savedId(c.id),
          c.size ? { x: c.position.x, y: c.position.y, width: c.size.width, height: c.size.height } : { x: c.position.x, y: c.position.y },
        ]),
      ),
      styles: Object.fromEntries(
        [...model.nodes, ...model.containers].filter((e) => e.style && Object.keys(e.style).length > 0).map((e) => [savedId(e.id), e.style!]),
      ),
      // Keyed by the id each connector gets when this text is read back: its place in the text.
      edgeStyles: Object.fromEntries(
        emittedEdges.flatMap((e, i) => (e.style && Object.keys(e.style).length > 0 ? [[`e${i + 1}`, e.style]] : [])),
      ),
    },
  };

  const saved = {
    ...model,
    containers: model.containers.map((c) => ({ ...c, id: savedId(c.id) })),
    ...(model.pinned ? { pinned: model.pinned.map(savedId) } : {}),
  };
  return joinFrontMatter(withPinned(withLegend(frontMatter, model), saved), `${lines.join('\n')}\n`);
}
