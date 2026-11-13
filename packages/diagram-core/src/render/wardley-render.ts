// canvas-4h1j: drawing a Wardley map, after Mermaid's wardleyRenderer.ts (12.3): the frame, axes and evolution
// stages; pipelines (a box under the parent, which is drawn as a small square on the box's top edge); links
// (straight, stopping at the circles, flow arrowheads, a rotated label); evolve arrows (red, dashed); components
// (circles, a strategy ring behind them, an inertia bar beside them, the name above right), anchors (the name
// alone, bold); annotations (numbered circles and the list box), notes (bold text) and (de)accelerators (block
// arrows). The Python renderer (diagram_core/svg_render.py) writes the same text, byte for byte.
import type { DiagramEdge, DiagramModel, DiagramNode, Position } from '../model/diagram-model.js';
import { wardleyFrame, wardleyPoint, type WardleyFrame } from '../model/wardley-geometry.js';
import { wardleyPipelineBox } from '../dsl/wardley.js';

const NODE_RADIUS = 6;
const SQUARE = NODE_RADIUS * 1.6;
const LABEL_OFFSET = 8;
const AXIS_FONT = 12;
const LABEL_FONT = 10;
const DEFAULT_STAGES = ['Genesis', 'Custom Built', 'Product', 'Commodity'];
// Math.cos(Math.PI / 6) and Math.sin(Math.PI / 6) as V8 gives them (written out so Python needn't call its libm).
const COS_30 = 0.8660254037844387;
const SIN_30 = 0.49999999999999994;
const SQRT_2 = 1.4142135623730951;
const TEXT = '#222';
const STROKE = '#000';
const EVOLVE = '#dc3545';
const FONT_FAMILY = 'system-ui, -apple-system, &quot;Segoe UI&quot;, Roboto, sans-serif';
/** The estimate svg-renderer.ts uses for text width (no font measuring in a string renderer). */
const AVG_CHAR_WIDTH_RATIO = 0.56;

const MAP_ROLES = new Set(['anchor', 'component', 'pipeline-component']);
export const isWardleyMapNode = (node: DiagramNode): boolean => node.role === undefined || MAP_ROLES.has(node.role);

export interface WardleyLayout {
  frame: WardleyFrame;
  /** Where each map node (anchor, component, pipeline component) is drawn: its position, except a pipeline's
   *  parent, which sits on its pipeline's box. */
  points: Map<string, Position>;
  pipelineParents: Set<string>;
  pipelines: { id: string; box: { x: number; y: number; width: number; height: number }; children: string[] }[];
  /** The stages along the evolution axis, with where each starts and ends (0-1). */
  stages: { label: string; start: number; end: number }[];
}

export function computeWardleyLayout(model: DiagramModel): WardleyLayout {
  const frame = wardleyFrame(model);
  const points = new Map<string, Position>();
  for (const node of model.nodes) if (isWardleyMapNode(node)) points.set(node.id, { x: node.position.x, y: node.position.y });
  const pipelineParents = new Set<string>();
  const pipelines: WardleyLayout['pipelines'] = [];
  for (const container of model.containers) {
    if (container.role !== 'pipeline') continue;
    const box = wardleyPipelineBox(model, container, frame);
    if (!box) continue;
    const children = model.nodes.filter((n) => n.containerId === container.id).map((n) => n.id);
    pipelines.push({ id: container.id, box: { x: box.x, y: box.y, width: box.width, height: box.height }, children });
    const parentId = container.attachedNodeIds?.[0];
    if (parentId !== undefined && points.has(parentId)) {
      pipelineParents.add(parentId);
      points.set(parentId, box.parent);
    }
  }
  const written = model.wardley?.stages;
  const labels = written && written.length >= 2 ? written.map((s) => (s.secondName ? `${s.name} / ${s.secondName}` : s.name)) : DEFAULT_STAGES;
  const boundaries = written && written.length >= 2 && written.every((s) => s.boundary !== undefined) ? written.map((s) => s.boundary!) : undefined;
  const stages = labels.map((label, index) => {
    if (boundaries) return { label, start: index === 0 ? 0 : boundaries[index - 1], end: boundaries[index] };
    const width = 1.0 / labels.length;
    return { label, start: index * width, end: (index + 1) * width };
  });
  return { frame, points, pipelineParents, pipelines, stages };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** An angle in degrees, to two decimals (so the text never depends on the last bit of atan2). */
function degrees(dy: number, dx: number): number {
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angle > 90 || angle < -90) angle += 180;
  return Math.round(angle * 100) / 100;
}

function renderLink(edge: DiagramEdge, layout: WardleyLayout): string {
  const from = layout.points.get(edge.sourceId);
  const to = layout.points.get(edge.targetId);
  if (!from || !to) return '';
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance === 0) return '';
  const sourceRadius = layout.pipelineParents.has(edge.sourceId) ? SQUARE / SQRT_2 : NODE_RADIUS;
  const targetRadius = layout.pipelineParents.has(edge.targetId) ? SQUARE / SQRT_2 : NODE_RADIUS;
  const data = edge.wardley;
  const flow = data?.fromPort ?? data?.toPort ?? data?.flowArrow?.flow;
  const end = flow === '+>' || flow === '+<>' ? ' marker-end="url(#wardley-flow-end)"' : '';
  const start = flow === '+<' || flow === '+<>' ? ' marker-start="url(#wardley-flow-start)"' : '';
  const dash = edge.lineStyle === 'dotted' ? ' stroke-dasharray="6 6"' : '';
  const parts = [
    `<line class="wardley-link" data-id="${escapeXml(edge.id)}" x1="${from.x + (dx / distance) * sourceRadius}" y1="${from.y + (dy / distance) * sourceRadius}" x2="${to.x + (-dx / distance) * targetRadius}" y2="${to.y + (-dy / distance) * targetRadius}" stroke="${STROKE}" stroke-width="1"${dash}${end}${start} />`,
  ];
  const label = data?.flowArrow?.label || edge.label;
  if (label) {
    const x = (from.x + to.x) / 2 + (dy / distance) * 8;
    const y = (from.y + to.y) / 2 + (-dx / distance) * 8;
    parts.push(
      `<text x="${x}" y="${y}" fill="${TEXT}" font-size="${LABEL_FONT}" text-anchor="middle" dominant-baseline="middle" transform="rotate(${degrees(dy, dx)} ${x} ${y})">${escapeXml(label)}</text>`,
    );
  }
  return parts.join('');
}

function renderEvolve(node: DiagramNode, layout: WardleyLayout): string {
  const origin = layout.points.get(node.id);
  if (!origin || node.wardley?.evolve === undefined) return '';
  const targetX = wardleyPoint(layout.frame, { visibility: 0, evolution: node.wardley.evolve }).x;
  const dx = targetX - origin.x;
  const distance = Math.sqrt(dx * dx);
  const shorten = NODE_RADIUS + 2;
  const x2 = distance > shorten ? targetX - (dx / distance) * shorten : targetX;
  return `<line class="wardley-evolve" x1="${origin.x}" y1="${origin.y}" x2="${x2}" y2="${origin.y}" stroke="${EVOLVE}" stroke-width="1" stroke-dasharray="4 4" marker-end="url(#wardley-evolve-arrow)" />`;
}

function renderMapNode(node: DiagramNode, layout: WardleyLayout): string {
  const point = layout.points.get(node.id);
  if (!point) return '';
  const { x, y } = point;
  const data = node.wardley;
  const parts: string[] = [`<g class="wardley-node" data-id="${escapeXml(node.id)}">`];
  if (node.role === 'anchor') {
    const lx = data?.labelOffset ? x + data.labelOffset.x : x;
    const ly = data?.labelOffset ? y + data.labelOffset.y : y - 3;
    parts.push(`<text x="${lx}" y="${ly}" fill="#000" font-size="${LABEL_FONT}" font-weight="bold" text-anchor="middle" dominant-baseline="middle">${escapeXml(node.label)}</text>`, '</g>');
    return parts.join('');
  }
  const strategy = data?.strategy;
  const isParent = layout.pipelineParents.has(node.id);
  const ring: Record<string, string> = { outsource: '#666', buy: '#ccc', build: '#eee', market: 'white' };
  if (strategy) parts.push(`<circle cx="${x}" cy="${y}" r="${NODE_RADIUS * 2}" fill="${ring[strategy]}" stroke="${STROKE}" stroke-width="1" />`);
  if (!isParent && strategy !== 'market') parts.push(`<circle cx="${x}" cy="${y}" r="${NODE_RADIUS}" fill="#fff" stroke="${STROKE}" stroke-width="1" />`);
  if (strategy === 'market') {
    const r = NODE_RADIUS * 1.2;
    const corners: [number, number][] = [
      [x, y - r],
      [x - r * COS_30, y + r * SIN_30],
      [x + r * COS_30, y + r * SIN_30],
    ];
    for (let i = 0; i < 3; i += 1) {
      const [x1, y1] = corners[i];
      const [x2, y2] = corners[(i + 1) % 3];
      parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${STROKE}" stroke-width="1" />`);
    }
    for (const [cx, cy] of corners) parts.push(`<circle cx="${cx}" cy="${cy}" r="${NODE_RADIUS * 0.7}" fill="white" stroke="${STROKE}" stroke-width="2" />`);
  }
  if (isParent) parts.push(`<rect x="${x - SQUARE / 2}" y="${y - SQUARE / 2}" width="${SQUARE}" height="${SQUARE}" fill="#fff" stroke="${STROKE}" stroke-width="1" />`);
  if (data?.inertia) {
    let off = isParent ? SQUARE / 2 + 15 : NODE_RADIUS + 15;
    if (strategy) off += NODE_RADIUS + 10;
    const half = (isParent ? SQUARE : NODE_RADIUS * 2) / 2;
    parts.push(`<line x1="${x + off}" y1="${y - half}" x2="${x + off}" y2="${y + half}" stroke="${STROKE}" stroke-width="6" />`);
  }
  const lx = x + (data?.labelOffset?.x ?? (strategy ? LABEL_OFFSET + 10 : LABEL_OFFSET));
  const ly = y + (data?.labelOffset?.y ?? (strategy ? -LABEL_OFFSET - 10 : -LABEL_OFFSET));
  parts.push(`<text x="${lx}" y="${ly}" fill="${TEXT}" font-size="${LABEL_FONT}" text-anchor="start">${escapeXml(node.label)}</text>`, '</g>');
  return parts.join('');
}

function renderAnnotations(model: DiagramModel, frame: WardleyFrame): string {
  const annotations = model.nodes.filter((n) => n.role === 'annotation');
  if (annotations.length === 0) return '';
  const parts = ['<g class="wardley-annotations">'];
  for (const node of annotations) {
    const { x, y } = node.position;
    parts.push(
      `<g class="wardley-annotation" data-id="${escapeXml(node.id)}"><circle cx="${x}" cy="${y}" r="10" fill="white" stroke="${STROKE}" stroke-width="1.5" /><text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-size="10" fill="${TEXT}" font-weight="bold">${node.wardley?.number ?? ''}</text></g>`,
    );
  }
  const box = model.wardley?.annotationsBox;
  const listed = annotations
    .filter((n) => n.label)
    .map((n, index) => ({ n, index }))
    .sort((a, b) => (a.n.wardley?.number ?? 0) - (b.n.wardley?.number ?? 0) || a.index - b.index)
    .map(({ n }) => `${n.wardley?.number ?? ''}. ${n.label}`);
  if (box && listed.length > 0) {
    const padding = 10;
    const lineHeight = 16;
    const fontSize = 11;
    const start = wardleyPoint(frame, box);
    const textWidth = Math.max(...listed.map((t) => t.length * fontSize * AVG_CHAR_WIDTH_RATIO));
    const width = textWidth + padding * 2 + 105;
    const height = listed.length * lineHeight + padding * 2 + fontSize / 2;
    const bx = Math.max(frame.padding, Math.min(start.x, frame.width - frame.padding - width));
    const by = Math.max(frame.padding, Math.min(start.y, frame.height - frame.padding - height));
    parts.push(`<g class="wardley-annotations-box"><rect x="${bx}" y="${by}" width="${width}" height="${height}" fill="white" stroke="${STROKE}" stroke-width="1.5" rx="4" ry="4" />`);
    listed.forEach((text, index) => {
      parts.push(`<text x="${bx + padding}" y="${by + padding + (index + 1) * lineHeight}" font-size="${fontSize}" fill="${TEXT}" text-anchor="start" dominant-baseline="middle">${escapeXml(text)}</text>`);
    });
    parts.push('</g>');
  }
  parts.push('</g>');
  return parts.join('');
}

function renderAccelerator(node: DiagramNode): string {
  const { x, y } = node.position;
  const w = 60;
  const h = 30;
  const head = 20;
  const d =
    node.role === 'accelerator'
      ? `M ${x} ${y - h / 2} L ${x + w - head} ${y - h / 2} L ${x + w - head} ${y - h / 2 - 8} L ${x + w} ${y} L ${x + w - head} ${y + h / 2 + 8} L ${x + w - head} ${y + h / 2} L ${x} ${y + h / 2} Z`
      : `M ${x + w} ${y - h / 2} L ${x + head} ${y - h / 2} L ${x + head} ${y - h / 2 - 8} L ${x} ${y} L ${x + head} ${y + h / 2 + 8} L ${x + head} ${y + h / 2} L ${x + w} ${y + h / 2} Z`;
  return `<g class="wardley-${node.role}" data-id="${escapeXml(node.id)}"><path d="${d}" fill="white" stroke="${STROKE}" stroke-width="1" /><text x="${x + w / 2}" y="${y + h / 2 + 15}" text-anchor="middle" font-size="10" fill="${TEXT}" font-weight="bold">${escapeXml(node.label)}</text></g>`;
}

export function renderWardleySvg(model: DiagramModel): string {
  const layout = computeWardleyLayout(model);
  const { frame } = layout;
  const { width, height, padding, chartWidth, chartHeight } = frame;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<defs>',
    `<marker id="wardley-evolve-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${EVOLVE}" stroke="none" /></marker>`,
    `<marker id="wardley-flow-end" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${STROKE}" stroke="none" /></marker>`,
    `<marker id="wardley-flow-start" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 10 0 L 0 5 L 10 10 z" fill="${STROKE}" stroke="none" /></marker>`,
    '</defs>',
    `<g class="wardley-map" font-family="${FONT_FAMILY}">`,
  ];
  if (model.title) {
    parts.push(`<text class="wardley-title" x="${width / 2}" y="${padding / 2}" fill="${TEXT}" font-size="${AXIS_FONT * 1.05}" font-weight="bold" text-anchor="middle" dominant-baseline="middle">${escapeXml(model.title)}</text>`);
  }
  parts.push(
    '<g class="wardley-axes">',
    `<line x1="${padding}" x2="${width - padding}" y1="${height - padding}" y2="${height - padding}" stroke="${STROKE}" stroke-width="1" />`,
    `<line x1="${padding}" x2="${padding}" y1="${padding}" y2="${height - padding}" stroke="${STROKE}" stroke-width="1" />`,
    `<text x="${padding + chartWidth / 2}" y="${height - padding / 4}" fill="${TEXT}" font-size="${AXIS_FONT}" font-weight="bold" text-anchor="middle">Evolution</text>`,
    `<text x="${padding / 3}" y="${padding + chartHeight / 2}" fill="${TEXT}" font-size="${AXIS_FONT}" font-weight="bold" text-anchor="middle" transform="rotate(-90 ${padding / 3} ${padding + chartHeight / 2})">Visibility</text>`,
    '</g>',
    '<g class="wardley-stages">',
  );
  layout.stages.forEach((stage, index) => {
    const startX = padding + stage.start * chartWidth;
    const endX = padding + stage.end * chartWidth;
    if (index > 0) parts.push(`<line x1="${startX}" x2="${startX}" y1="${padding}" y2="${height - padding}" stroke="#000" stroke-width="1" stroke-dasharray="5 5" opacity="0.8" />`);
    parts.push(`<text x="${(startX + endX) / 2}" y="${height - padding / 1.5}" fill="${TEXT}" font-size="${AXIS_FONT - 2}" text-anchor="middle">${escapeXml(stage.label)}</text>`);
  });
  parts.push('</g>');

  if (layout.pipelines.length > 0) {
    parts.push('<g class="wardley-pipelines">');
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    for (const pipeline of layout.pipelines) {
      const children = pipeline.children
        .map((id) => byId.get(id)!)
        .map((n, index) => ({ n, index }))
        .sort((a, b) => a.n.position.x - b.n.position.x || a.index - b.index)
        .map(({ n }) => n.position);
      for (let i = 0; i < children.length - 1; i += 1) {
        parts.push(`<line x1="${children[i].x}" y1="${children[i].y}" x2="${children[i + 1].x}" y2="${children[i + 1].y}" stroke="${STROKE}" stroke-width="1" stroke-dasharray="4 4" />`);
      }
      const { box } = pipeline;
      parts.push(`<rect class="wardley-pipeline" data-id="${escapeXml(pipeline.id)}" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="none" stroke="${STROKE}" stroke-width="1.5" rx="4" ry="4" />`);
    }
    parts.push('</g>');
  }

  const childrenOf = new Map<string, Set<string>>();
  for (const container of model.containers) {
    const parent = container.attachedNodeIds?.[0];
    if (container.role === 'pipeline' && parent !== undefined) childrenOf.set(parent, new Set(model.nodes.filter((n) => n.containerId === container.id).map((n) => n.id)));
  }
  parts.push('<g class="wardley-links">');
  for (const edge of model.edges) {
    // Mermaid leaves out a link from a pipeline component to its own parent.
    if (childrenOf.get(edge.targetId)?.has(edge.sourceId)) continue;
    parts.push(renderLink(edge, layout));
  }
  parts.push('</g>', '<g class="wardley-trends">');
  for (const node of model.nodes) if (isWardleyMapNode(node)) parts.push(renderEvolve(node, layout));
  parts.push('</g>', '<g class="wardley-nodes">');
  for (const node of model.nodes) if (isWardleyMapNode(node)) parts.push(renderMapNode(node, layout));
  parts.push('</g>');
  parts.push(renderAnnotations(model, frame));
  const notes = model.nodes.filter((n) => n.role === 'note');
  if (notes.length > 0) {
    parts.push('<g class="wardley-notes">');
    for (const note of notes) {
      parts.push(`<text data-id="${escapeXml(note.id)}" x="${note.position.x}" y="${note.position.y}" text-anchor="start" font-size="11" fill="${TEXT}" font-weight="bold">${escapeXml(note.label)}</text>`);
    }
    parts.push('</g>');
  }
  const accelerators = model.nodes.filter((n) => n.role === 'accelerator' || n.role === 'deaccelerator');
  if (accelerators.length > 0) parts.push('<g class="wardley-accelerators">', ...accelerators.map(renderAccelerator), '</g>');
  parts.push('</g>', '</svg>');
  return parts.join('');
}
