import type { DiagramContainer, DiagramModel, DiagramNode, Size } from '../model/diagram-model.js';

const DEFAULT_NODE_SIZE: Size = { width: 140, height: 60 };
// Matches diagram-ops.ts's own (module-private) DEFAULT_CONTAINER_SIZE — kept as a separate literal
// rather than a shared import since the two packages/modules don't otherwise share constants, but
// both must agree with computeBounds' own inline fallback below.
const DEFAULT_CONTAINER_SIZE: Size = { width: 300, height: 200 };
const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const DEFAULT_DOTTED_DASHARRAY = '4 2';
const DEFAULT_THICK_STROKE_WIDTH = 3;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Grouping F (docs/flowchart-completeness-brief.md): a literal `<br/>` (any case, self-closing or
// not) or a raw newline splits a label into multiple rendered lines. Exported so the interactive
// canvas (apps/web/src/canvas/Canvas.tsx) can split identically — both renderers must agree on
// label rendering for exports to match the canvas (per shapes.tsx's own SC-004 note).
const LINE_BREAK = /<br\s*\/?>|\r?\n/gi;

// canvas-3zb: average character width as a fraction of font-size, for this app's sans-serif font
// stack — a heuristic estimate, not real glyph metrics. svg-renderer.ts's export path is pure
// string generation with no DOM and no font measurement available, and the interactive canvas
// must wrap identically for SC-004, so both use this same heuristic rather than one measuring
// real rendered glyphs and the other guessing independently.
const AVG_CHAR_WIDTH_RATIO = 0.56;

/** Greedy word-wrap of a single line to fit within maxWidth, using the character-count heuristic
 *  above. Never splits a single word, even if that word alone exceeds maxWidth (matches ordinary
 *  browser text-wrapping behavior — an unbreakable long token overflows rather than being cut
 *  mid-word, which would make it unreadable). */
function wrapLine(line: string, maxWidth: number, fontSize: number): string[] {
  const maxChars = Math.max(1, Math.floor(maxWidth / (fontSize * AVG_CHAR_WIDTH_RATIO)));
  if (line.length <= maxChars) return [line];
  const words = line.split(' ');
  const wrapped: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      wrapped.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) wrapped.push(current);
  return wrapped.length > 0 ? wrapped : [line];
}

/**
 * Splits a label into its rendered lines: first on any explicit break (grouping F — a literal
 * `<br/>` or raw newline), then — when `maxWidth`/`fontSize` are supplied — further word-wraps
 * any line still too wide to fit its node's box (canvas-3zb: an icon's displayName is routinely
 * longer than the default 140px node width, e.g. "Azure Storage Accounts", and previously
 * overflowed both edges uncontained). Omitting `maxWidth`/`fontSize` preserves the original
 * explicit-breaks-only behavior exactly, for callers with no fixed width to wrap against (e.g.
 * edge labels, which float at a connector's midpoint rather than living inside a sized box).
 */
export function splitLabelLines(label: string, maxWidth?: number, fontSize?: number): string[] {
  const explicitLines = label.split(LINE_BREAK);
  if (maxWidth === undefined || fontSize === undefined) return explicitLines;
  return explicitLines.flatMap((line) => wrapLine(line, maxWidth, fontSize));
}

/** Renders a horizontally-centered `<text>` label, stacking `<tspan>`s when the label contains a
 *  line break. `centered` mirrors `dominant-baseline="middle"`'s effect for the single-line case,
 *  vertically centering the whole stacked block around `y` instead of just the first line.
 *  `maxWidth`, when supplied, word-wraps a too-long label to fit (canvas-3zb) instead of letting
 *  it overflow the node's box. */
function renderLabelText(x: number, y: number, label: string, fontSize: number, centered: boolean, maxWidth?: number): string {
  const lines = splitLabelLines(label, maxWidth, fontSize);
  if (lines.length === 1) {
    const baseline = centered ? ' dominant-baseline="middle"' : '';
    return `<text x="${x}" y="${y}"${baseline} text-anchor="middle" font-size="${fontSize}" font-family='${FONT_FAMILY}'>${escapeXml(label)}</text>`;
  }
  const lineHeightEm = 1.2;
  const firstDy = centered ? (-(lines.length - 1) * lineHeightEm) / 2 : 0;
  const tspans = lines
    .map((line, i) => `<tspan x="${x}" dy="${i === 0 ? firstDy : lineHeightEm}em">${escapeXml(line)}</tspan>`)
    .join('');
  return `<text x="${x}" y="${y}" text-anchor="middle" font-size="${fontSize}" font-family='${FONT_FAMILY}'>${tspans}</text>`;
}

// canvas-23t.5: an icon node with no explicit size used to fall back to DEFAULT_NODE_SIZE — a box
// built for a short text label, not an icon glyph plus a caption that (for real library icon
// names like "Azure Data Lake Storage Gen1") routinely wraps to two or three lines. The glyph sat
// far too small inside a mostly-empty box, and the caption overflowed past the bottom edge. Icon
// nodes now get a dedicated content-fit box instead: a fixed width sized for the glyph plus a
// comfortably wrapping caption, and a height that grows with however many caption lines that
// wrapping actually produces — computed with the exact same `splitLabelLines` heuristic used to
// render it, so the box can never under-size what it was measured against. An explicit `node.size`
// (the user dragged a resize handle) always wins — this default only applies when one is absent.
const ICON_GLYPH_SIZE = 48;
const ICON_PADDING = 10;
const ICON_LABEL_GAP = 4;
const ICON_LABEL_MAX_WIDTH = ICON_GLYPH_SIZE + 40;

// The caption renders 2px smaller than the node's configured font size (10px floor) — mirrors the
// original hand-tuned "Math.max(fontSize - 2, 10)" this replaces, just centralized so both the
// box-sizing math and the actual render use the identical value rather than two separate literals
// that could drift (Canvas.tsx used to hardcode a bare `12` here, ignoring node.style.fontSize
// entirely — folded into this one shared helper instead of carrying that inconsistency forward).
function iconCaptionFontSize(node: DiagramNode): number {
  return Math.max((node.style?.fontSize ?? 14) - 2, 10);
}

/** Content-fit size for an icon node with no explicit `node.size` (canvas-23t.5). Exported so
 *  `nodeSize` below and `iconNodeLayout` share one calculation, and so the interactive canvas
 *  (apps/web/src/canvas/shapes.tsx) can reuse it rather than re-deriving the same numbers. */
export function iconNodeSize(node: DiagramNode): Size {
  const fontSize = iconCaptionFontSize(node);
  const lines = splitLabelLines(node.label, ICON_LABEL_MAX_WIDTH, fontSize);
  const lineHeight = fontSize * 1.2;
  return {
    width: ICON_LABEL_MAX_WIDTH + ICON_PADDING * 2,
    height: ICON_PADDING * 2 + ICON_GLYPH_SIZE + ICON_LABEL_GAP + lines.length * lineHeight,
  };
}

// Exported (same pattern as computeBounds/clipEdgeEndpoint/splitLabelLines below) so auto-layout.ts
// can size dagre's input nodes identically to how this renderer and the canvas already do, rather
// than adding a third hand-copied {140, 60} default (shapes.tsx has its own copy with a "must
// match" comment — this avoids a fourth).
export function nodeSize(node: DiagramNode): Size {
  if (node.shape === 'icon' && !node.size) return iconNodeSize(node);
  return node.size ?? DEFAULT_NODE_SIZE;
}

/** Full render geometry for an icon node's glyph + caption (canvas-23t.5) — one shared calculation
 *  so the export renderer (`renderNode` below) and the interactive canvas (Canvas.tsx) can't
 *  disagree about where the icon sits or where the caption starts (SC-004). The glyph is drawn at
 *  its native `ICON_GLYPH_SIZE`, clamped down only if an explicit `node.size` is smaller than that
 *  (a user-shrunk icon node) — never enlarged just because the box is bigger. */
export function iconNodeLayout(node: DiagramNode): {
  width: number;
  height: number;
  iconSize: number;
  iconX: number;
  iconY: number;
  labelX: number;
  labelY: number;
  labelFontSize: number;
  labelMaxWidth: number;
} {
  const { x, y } = node.position;
  const { width, height } = nodeSize(node);
  const labelFontSize = iconCaptionFontSize(node);
  const iconSize = Math.min(ICON_GLYPH_SIZE, width - ICON_PADDING * 2, height - ICON_PADDING * 2);
  const iconX = x + (width - iconSize) / 2;
  const iconY = y + ICON_PADDING;
  return {
    width,
    height,
    iconSize,
    iconX,
    iconY,
    labelX: x + width / 2,
    labelY: iconY + iconSize + ICON_LABEL_GAP + labelFontSize,
    labelFontSize,
    labelMaxWidth: ICON_LABEL_MAX_WIDTH,
  };
}

export function containerSize(container: DiagramContainer): Size {
  return container.size ?? DEFAULT_CONTAINER_SIZE;
}

function nodeCenter(node: DiagramNode): { x: number; y: number } {
  const size = nodeSize(node);
  return { x: node.position.x + size.width / 2, y: node.position.y + size.height / 2 };
}

/**
 * canvas-1rq: an edge endpoint left at the node's raw center is hidden underneath the node's own
 * opaque fill (nodes render on top of edges) — the arrowhead never becomes visible. Clips the
 * endpoint to the node's shape boundary instead, along the line toward `towardX`/`towardY` (the
 * other endpoint, before clipping). Exported so the interactive canvas (Canvas.tsx) clips
 * identically — both renderers must agree on where an edge visibly starts/ends (SC-004).
 *
 * `circle`/`double-circle` use the true ellipse boundary and `diamond` its own rhombus boundary;
 * every other shape (including the 009 shapes and icon/person/cylinder) falls back to a rectangle
 * bounding-box intersection — a reasonable approximation per canvas-1rq's own acceptance
 * criteria, not a claim that e.g. a hexagon's real silhouette is being traced exactly.
 */
export function clipEdgeEndpoint(
  center: { x: number; y: number },
  size: Size,
  shape: DiagramNode['shape'],
  towardX: number,
  towardY: number,
): { x: number; y: number } {
  const dx = towardX - center.x;
  const dy = towardY - center.y;
  if (dx === 0 && dy === 0) return { ...center };

  const hw = size.width / 2;
  const hh = size.height / 2;
  let t: number;
  if (shape === 'circle' || shape === 'double-circle') {
    t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  } else if (shape === 'diamond') {
    t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  } else {
    const tx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
    const ty = dy !== 0 ? hh / Math.abs(dy) : Infinity;
    t = Math.min(tx, ty);
  }
  // Never past the other endpoint (near-overlapping nodes), and never back past this node's own
  // center (a malformed/zero-size node).
  t = Math.min(Math.max(t, 0), 1);
  return { x: center.x + t * dx, y: center.y + t * dy };
}

function renderNodeShape(node: DiagramNode): string {
  const { x, y } = node.position;
  const { width, height } = nodeSize(node);
  const fill = node.style?.fillColor ?? '#ffffff';
  const stroke = node.style?.strokeColor ?? '#333333';

  switch (node.shape) {
    case 'circle':
      return `<ellipse cx="${x + width / 2}" cy="${y + height / 2}" rx="${width / 2}" ry="${height / 2}" fill="${fill}" stroke="${stroke}" />`;
    case 'diamond': {
      const points = [
        [x + width / 2, y],
        [x + width, y + height / 2],
        [x + width / 2, y + height],
        [x, y + height / 2],
      ]
        .map((p) => p.join(','))
        .join(' ');
      return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" />`;
    }
    case 'cylinder': {
      const capHeight = Math.min(16, height / 4);
      return [
        `<path d="M ${x} ${y + capHeight} L ${x} ${y + height - capHeight} A ${width / 2} ${capHeight} 0 0 0 ${x + width} ${y + height - capHeight} L ${x + width} ${y + capHeight} A ${width / 2} ${capHeight} 0 0 0 ${x} ${y + capHeight} Z" fill="${fill}" stroke="${stroke}" />`,
        `<ellipse cx="${x + width / 2}" cy="${y + capHeight}" rx="${width / 2}" ry="${capHeight}" fill="${fill}" stroke="${stroke}" />`,
      ].join('');
    }
    case 'rounded-rectangle':
      return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" ry="12" fill="${fill}" stroke="${stroke}" />`;
    case 'stadium':
      return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" ry="${height / 2}" fill="${fill}" stroke="${stroke}" />`;
    case 'subroutine': {
      const inset = Math.min(10, width / 6);
      return [
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}" stroke="${stroke}" />`,
        `<line x1="${x + inset}" y1="${y}" x2="${x + inset}" y2="${y + height}" stroke="${stroke}" />`,
        `<line x1="${x + width - inset}" y1="${y}" x2="${x + width - inset}" y2="${y + height}" stroke="${stroke}" />`,
      ].join('');
    }
    case 'double-circle': {
      const gap = 5;
      return [
        `<ellipse cx="${x + width / 2}" cy="${y + height / 2}" rx="${width / 2}" ry="${height / 2}" fill="${fill}" stroke="${stroke}" />`,
        `<ellipse cx="${x + width / 2}" cy="${y + height / 2}" rx="${width / 2 - gap}" ry="${height / 2 - gap}" fill="none" stroke="${stroke}" />`,
      ].join('');
    }
    case 'hexagon': {
      const notch = Math.min(20, width / 4);
      const points = [
        [x + notch, y],
        [x + width - notch, y],
        [x + width, y + height / 2],
        [x + width - notch, y + height],
        [x + notch, y + height],
        [x, y + height / 2],
      ]
        .map((p) => p.join(','))
        .join(' ');
      return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" />`;
    }
    case 'parallelogram': {
      const skew = Math.min(20, width / 5);
      const points = [
        [x + skew, y],
        [x + width, y],
        [x + width - skew, y + height],
        [x, y + height],
      ]
        .map((p) => p.join(','))
        .join(' ');
      return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" />`;
    }
    case 'parallelogram-alt': {
      const skew = Math.min(20, width / 5);
      const points = [
        [x, y],
        [x + width - skew, y],
        [x + width, y + height],
        [x + skew, y + height],
      ]
        .map((p) => p.join(','))
        .join(' ');
      return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" />`;
    }
    case 'trapezoid': {
      const skew = Math.min(20, width / 5);
      const points = [
        [x + skew, y],
        [x + width - skew, y],
        [x + width, y + height],
        [x, y + height],
      ]
        .map((p) => p.join(','))
        .join(' ');
      return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" />`;
    }
    case 'trapezoid-alt': {
      const skew = Math.min(20, width / 5);
      const points = [
        [x, y],
        [x + width, y],
        [x + width - skew, y + height],
        [x + skew, y + height],
      ]
        .map((p) => p.join(','))
        .join(' ');
      return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" />`;
    }
    case 'asymmetric': {
      const notch = Math.min(20, width / 5);
      const points = [
        [x, y],
        [x + width - notch, y],
        [x + width, y + height / 2],
        [x + width - notch, y + height],
        [x, y + height],
      ]
        .map((p) => p.join(','))
        .join(' ');
      return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" />`;
    }
    case 'person':
      return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="24" ry="24" fill="${fill}" stroke="${stroke}" />`;
    case 'icon':
    case 'rectangle':
    default:
      return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}" stroke="${stroke}" />`;
  }
}

export type IconResolver = (icon: NonNullable<DiagramNode['icon']>) => string | undefined;

function renderNode(node: DiagramNode, resolveIcon?: IconResolver): string {
  const { x, y } = node.position;
  const { width, height } = nodeSize(node);
  const fontSize = node.style?.fontSize ?? 14;

  // canvas-3zb: 16px total horizontal padding (8px each side) before wrapping — an icon's
  // displayName (e.g. "Azure Storage Accounts") is routinely wider than the default 140px node,
  // previously overflowing both edges uncontained.
  const labelMaxWidth = Math.max(width - 16, 40);

  const iconMarkup = node.icon ? resolveIcon?.(node.icon) : undefined;
  if (iconMarkup) {
    // canvas-23t.5: glyph top-aligned, caption stacked below it — both positions and the box
    // itself come from iconNodeLayout, the same calculation the canvas uses (SC-004).
    const layout = iconNodeLayout(node);
    return [
      `<g data-node-id="${escapeXml(node.id)}">`,
      renderNodeShape(node),
      `<g transform="translate(${layout.iconX}, ${layout.iconY}) scale(${layout.iconSize / 48})">${iconMarkup}</g>`,
      renderLabelText(layout.labelX, layout.labelY, node.label, layout.labelFontSize, false, layout.labelMaxWidth),
      '</g>',
    ].join('');
  }

  const rawLabel = node.icon ? `${node.label} [${node.icon.iconId}]` : node.label;
  return [
    `<g data-node-id="${escapeXml(node.id)}">`,
    renderNodeShape(node),
    renderLabelText(x + width / 2, y + height / 2, rawLabel, fontSize, true, labelMaxWidth),
    '</g>',
  ].join('');
}

function renderContainer(container: DiagramContainer): string {
  const { x, y } = container.position;
  const { width, height } = container.size ?? { width: 300, height: 200 };
  return [
    `<g data-container-id="${escapeXml(container.id)}">`,
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="#888888" stroke-dasharray="6,4" />`,
    `<text x="${x + 8}" y="${y + 16}" font-size="12" font-family='${FONT_FAMILY}'>${escapeXml(container.label)}</text>`,
    '</g>',
  ].join('');
}

function renderEdge(edge: DiagramModel['edges'][number], nodesById: Map<string, DiagramNode>): string {
  const source = nodesById.get(edge.sourceId);
  const target = nodesById.get(edge.targetId);
  if (!source || !target) return '';
  const from = nodeCenter(source);
  const to = nodeCenter(target);
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  // canvas-1rq: clip each endpoint to its own node's boundary so the arrowhead lands in open
  // space instead of underneath the target's opaque fill. Label position stays center-based —
  // unaffected by this fix and barely different in practice.
  const clippedFrom = clipEdgeEndpoint(from, nodeSize(source), source.shape, to.x, to.y);
  const clippedTo = clipEdgeEndpoint(to, nodeSize(target), target.shape, from.x, from.y);
  const label = edge.label ? renderLabelText(midX, midY - 4, edge.label, 12, false) : '';
  // Grouping B: lineStyle supplies a default treatment (dotted dasharray, thick width) that an
  // explicit edge.style (linkStyle) override still wins over, since linkStyle is layered on top.
  const isInvisible = edge.lineStyle === 'invisible';
  const stroke = isInvisible ? 'none' : (edge.style?.strokeColor ?? '#333333');
  const strokeWidthValue = edge.style?.strokeWidth ?? (edge.lineStyle === 'thick' ? DEFAULT_THICK_STROKE_WIDTH : undefined);
  const strokeWidth = strokeWidthValue ? ` stroke-width="${strokeWidthValue}"` : '';
  const dasharrayValue = edge.style?.strokeDasharray ?? (edge.lineStyle === 'dotted' ? DEFAULT_DOTTED_DASHARRAY : undefined);
  const strokeDasharray = dasharrayValue ? ` stroke-dasharray="${dasharrayValue}"` : '';
  const markerEnd = isInvisible || edge.arrow === 'none' ? '' : ' marker-end="url(#arrowhead)"';
  const markerStart = !isInvisible && edge.arrow === 'both' ? ' marker-start="url(#arrowhead)"' : '';
  return `<g data-edge-id="${escapeXml(edge.id)}"><line x1="${clippedFrom.x}" y1="${clippedFrom.y}" x2="${clippedTo.x}" y2="${clippedTo.y}" stroke="${stroke}"${strokeWidth}${strokeDasharray}${markerStart}${markerEnd} />${label}</g>`;
}

/** Exported so the interactive canvas can size itself to match actual content exactly the way
 *  export does (canvas-0s3) — a single source of truth rather than a second, hand-duplicated
 *  bounds calculation the two could silently disagree on. */
export function computeBounds(model: DiagramModel): { width: number; height: number } {
  let maxX = 400;
  let maxY = 300;
  for (const node of model.nodes) {
    const size = nodeSize(node);
    maxX = Math.max(maxX, node.position.x + size.width + 40);
    maxY = Math.max(maxY, node.position.y + size.height + 40);
  }
  for (const container of model.containers) {
    const size = containerSize(container);
    maxX = Math.max(maxX, container.position.x + size.width + 40);
    maxY = Math.max(maxY, container.position.y + size.height + 40);
  }
  return { width: maxX, height: maxY };
}

/**
 * Renders a DiagramModel to self-contained SVG: no external network calls, no remote fonts —
 * satisfies the constitution's export constraint and Contract IV's export-fidelity requirement.
 */
export function renderToSvg(model: DiagramModel, resolveIcon?: IconResolver): string {
  const nodesById = new Map(model.nodes.map((n) => [n.id, n]));
  const { width, height } = computeBounds(model);

  const containerMarkup = model.containers.map(renderContainer).join('');
  const edgeMarkup = model.edges.map((e) => renderEdge(e, nodesById)).join('');
  const nodeMarkup = model.nodes.map((n) => renderNode(n, resolveIcon)).join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<defs>',
    // auto-start-reverse: behaves exactly like "auto" as a marker-end, but as a marker-start it
    // points the arrowhead the other way — the one marker definition works for both ends of a
    // bidirectional (arrow: 'both') edge.
    '<marker id="arrowhead" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto-start-reverse">',
    '<path d="M0,0 L0,6 L9,3 z" fill="#333333" />',
    '</marker>',
    '</defs>',
    containerMarkup,
    edgeMarkup,
    nodeMarkup,
    '</svg>',
  ].join('');
}
