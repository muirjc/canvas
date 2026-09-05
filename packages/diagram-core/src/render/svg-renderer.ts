import type { ClassMember, DiagramContainer, DiagramEdge, DiagramModel, DiagramNode, EntityAttribute, Size } from '../model/diagram-model.js';

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

// canvas-x66: an ER entity's attributes (EntityAttribute[]) or a UML class's members
// (ClassMember[]) were parsed and modeled correctly but never drawn by either renderer — every
// entity/class rendered as a bare labeled box, indistinguishable from one with no body at all.
// Formats one row of text per attribute/member, deliberately duplicating (not importing)
// erd.ts's/uml.ts's own line-formatting logic: this render module's only dependency is
// ../model (see the single import above), and pulling in a specific DSL family's parser module
// here would invert that layering for the sake of a few lines neither format needs to be
// byte-identical to its own DSL round-trip form, only visually equivalent.
function formatAttributeRow(attribute: EntityAttribute): string {
  const keysPart = attribute.keys.length > 0 ? ` ${attribute.keys.join(', ')}` : '';
  // canvas-??? (comment rendering): real Mermaid draws an attribute's comment as its own
  // rightmost column, after type/name/key (confirmed against Mermaid's own erRenderer.js source,
  // not assumed) — this codebase's simplified single-text-row-per-attribute convention (rather
  // than true per-column grid cells) appends it in that same rightmost position instead.
  const commentPart = attribute.comment ? ` "${attribute.comment}"` : '';
  return `${attribute.type} ${attribute.name}${keysPart}${commentPart}`;
}

function formatMemberRow(member: ClassMember): string {
  const visibility = member.visibility ?? '';
  const modifier = member.isStatic ? '$' : member.isAbstract ? '*' : '';
  if (member.kind === 'method') {
    const returnPart = member.returnType ? ` ${member.returnType}` : '';
    return `${visibility}${member.name}(${member.params ?? ''})${returnPart}${modifier}`;
  }
  const typePart = member.type ? `${member.type} ` : '';
  return `${visibility}${typePart}${member.name}${modifier}`;
}

/** The row texts for a node's attribute/member "table" body, or `[]` for a node with neither
 *  (every non-ER/UML node, or a bare entity/class declaration with no body) — the exact case
 *  that must keep rendering exactly as it did before this table-body support existed. */
function tableRows(node: DiagramNode): string[] {
  if (node.attributes && node.attributes.length > 0) return node.attributes.map(formatAttributeRow);
  if (node.members && node.members.length > 0) return node.members.map(formatMemberRow);
  return [];
}

const TABLE_HEADER_PADDING_Y = 6;
const TABLE_ROW_PADDING_Y = 3;
const TABLE_ROW_PADDING_X = 8;

/** canvas-7vs.4: a UML `<<Stereotype>>` annotation (`DiagramNode.umlStereotype`) renders as its
 *  own smaller line stacked above the class name, inside the same header band `tableNodeLayout`
 *  already draws — matches Mermaid's own placement and this file's own `<<Name>>` textual
 *  convention (uml.ts's serializer emits the identical ` <<${stereotype}>>` form). `undefined`
 *  for a class with no stereotype, so header height/layout are completely unaffected. */
function formatStereotype(node: DiagramNode): string | undefined {
  return node.umlStereotype ? `<<${node.umlStereotype}>>` : undefined;
}

/** Content-fit size for a node with attribute/member rows and no explicit `node.size` — mirrors
 *  `iconNodeSize`'s own precedent exactly (content-fit default, explicit `node.size` always
 *  wins). Grows both height (one band per row, below a header band for the entity/class name)
 *  and width (to whichever row or the header is widest, using the same character-count
 *  heuristic `wrapLine` uses elsewhere in this file — rows are never word-wrapped, matching how
 *  Mermaid itself renders a fixed-width ER/class table). */
function tableNodeSize(node: DiagramNode, rows: string[]): Size {
  const fontSize = node.style?.fontSize ?? 14;
  const rowFontSize = Math.max(fontSize - 2, 10);
  const stereotype = formatStereotype(node);
  const stereotypeHeight = stereotype ? rowFontSize * 1.2 + TABLE_HEADER_PADDING_Y : 0;
  const headerHeight = stereotypeHeight + fontSize * 1.2 + TABLE_HEADER_PADDING_Y * 2;
  const rowHeight = rowFontSize * 1.2 + TABLE_ROW_PADDING_Y * 2;
  const widest = Math.max(
    node.label.length * fontSize * AVG_CHAR_WIDTH_RATIO,
    (stereotype?.length ?? 0) * rowFontSize * AVG_CHAR_WIDTH_RATIO,
    ...rows.map((row) => row.length * rowFontSize * AVG_CHAR_WIDTH_RATIO),
  );
  return {
    width: Math.max(DEFAULT_NODE_SIZE.width, widest + TABLE_ROW_PADDING_X * 2),
    height: headerHeight + rows.length * rowHeight,
  };
}

// Exported (same pattern as computeBounds/clipEdgeEndpoint/splitLabelLines below) so auto-layout.ts
// can size dagre's input nodes identically to how this renderer and the canvas already do, rather
// than adding a third hand-copied {140, 60} default (shapes.tsx has its own copy with a "must
// match" comment — this avoids a fourth).
export function nodeSize(node: DiagramNode): Size {
  if (node.shape === 'icon' && !node.size) return iconNodeSize(node);
  if (!node.size) {
    const rows = tableRows(node);
    if (rows.length > 0) return tableNodeSize(node, rows);
  }
  return node.size ?? DEFAULT_NODE_SIZE;
}

/** Full render geometry for a node's attribute/member table body (canvas-x66) — `null` for a
 *  node with no rows, so callers can fall back to the plain centered-label rendering unchanged.
 *  One shared calculation so the export renderer (`renderNode` below) and the interactive canvas
 *  (apps/web/src/canvas/Canvas.tsx) can't disagree about row position/content (SC-004, same
 *  convention `iconNodeLayout` above already established). */
export function tableNodeLayout(node: DiagramNode): {
  width: number;
  height: number;
  headerX: number;
  headerY: number;
  headerFontSize: number;
  /** canvas-7vs.4: `<<Stereotype>>` text/position, stacked above headerX/headerY -- undefined
   *  for a class with no umlStereotype, so callers can skip drawing it entirely. */
  stereotype?: { text: string; x: number; y: number; fontSize: number };
  dividerY: number;
  rows: { text: string; x: number; y: number; fontSize: number }[];
} | null {
  const rows = tableRows(node);
  if (rows.length === 0) return null;

  const { x, y } = node.position;
  const { width, height } = nodeSize(node);
  const fontSize = node.style?.fontSize ?? 14;
  const rowFontSize = Math.max(fontSize - 2, 10);
  const stereotypeText = formatStereotype(node);
  const stereotypeHeight = stereotypeText ? rowFontSize * 1.2 + TABLE_HEADER_PADDING_Y : 0;
  const headerHeight = stereotypeHeight + fontSize * 1.2 + TABLE_HEADER_PADDING_Y * 2;
  const rowHeight = rowFontSize * 1.2 + TABLE_ROW_PADDING_Y * 2;

  return {
    width,
    height,
    headerX: x + width / 2,
    headerY: y + stereotypeHeight + (fontSize * 1.2 + TABLE_HEADER_PADDING_Y * 2) / 2,
    headerFontSize: fontSize,
    stereotype: stereotypeText
      ? { text: stereotypeText, x: x + width / 2, y: y + TABLE_HEADER_PADDING_Y + rowFontSize, fontSize: rowFontSize }
      : undefined,
    dividerY: y + headerHeight,
    rows: rows.map((text, i) => ({
      text,
      x: x + TABLE_ROW_PADDING_X,
      y: y + headerHeight + i * rowHeight + rowHeight / 2,
      fontSize: rowFontSize,
    })),
  };
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

/** canvas-7vs.6: architecture diagrams' explicit `:T`/`:B`/`:L`/`:R` anchor hint pins an edge
 *  endpoint to that literal side's midpoint, instead of `clipEdgeEndpoint`'s direction-toward-
 *  the-other-node default. Exported so the interactive canvas clips identically (SC-004). */
export function clipToAnchorSide(center: Point, size: Size, anchor: 'T' | 'B' | 'L' | 'R'): Point {
  switch (anchor) {
    case 'T':
      return { x: center.x, y: center.y - size.height / 2 };
    case 'B':
      return { x: center.x, y: center.y + size.height / 2 };
    case 'L':
      return { x: center.x - size.width / 2, y: center.y };
    case 'R':
      return { x: center.x + size.width / 2, y: center.y };
  }
}

/** canvas-7vs.7: architecture diagrams' `{group}` edge modifier escalates an endpoint's
 *  connection point to the service's PARENT CONTAINER's boundary rather than the service node's
 *  own — `sourceId`/`targetId` still reference the service; this only changes which box
 *  `clipEdgeEndpoint`/`clipToAnchorSide` clips against. Falls back to the node's own box if it
 *  has no parent container (defensive — real Mermaid grammar requires a `{group}` service to
 *  actually sit inside a group). Exported for the same canvas/export parity reason (SC-004). */
export function architectureEndpointBox(
  node: DiagramNode,
  isGroup: boolean | undefined,
  containersById: Map<string, DiagramContainer>,
): { center: Point; size: Size; shape: DiagramNode['shape'] } {
  if (isGroup && node.containerId) {
    const container = containersById.get(node.containerId);
    if (container) {
      const size = containerSize(container);
      return {
        center: { x: container.position.x + size.width / 2, y: container.position.y + size.height / 2 },
        size,
        shape: 'rectangle',
      };
    }
  }
  return { center: nodeCenter(node), size: nodeSize(node), shape: node.shape };
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

const CROWSFOOT_GLYPH_SPACING = 7;
const CROWSFOOT_TICK_HALF = 5;
const CROWSFOOT_CIRCLE_RADIUS = 4;
const CROWSFOOT_FORK_LENGTH = 10;
const CROWSFOOT_FORK_SPREAD = 5;

export type CardinalityGlyph =
  | { kind: 'tick'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'fork'; apexX: number; apexY: number; prongs: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }] };

/**
 * canvas-2ut: crow's-foot glyph geometry for one end of an ER relationship. `token`'s two
 * characters are read nearest-node-first — index 0 drawn right at `point` (the node-boundary
 * clipped endpoint), index 1 drawn one glyph-width further along the line toward the other
 * endpoint: `|` a perpendicular tick (one/mandatory), `o` a hollow circle (zero/optional),
 * `{`/`}` a three-pronged fork (many) — Mermaid's own erDiagram cardinality vocabulary. A
 * character outside that set is silently skipped (defensive only — erd.ts's own
 * parseCardinalityToken already constrains what reaches here).
 *
 * `dx`/`dy` need not be normalized — only their direction (from `point`, outward along the edge
 * toward the other endpoint) is used. Exported so the interactive canvas draws pixel-identical
 * glyphs to the export renderer (SC-004), the same shared-geometry convention `clipEdgeEndpoint`/
 * `tableNodeLayout` above already establish.
 */
export function cardinalityGlyphs(point: { x: number; y: number }, dx: number, dy: number, token: string): CardinalityGlyph[] {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const glyphs: CardinalityGlyph[] = [];
  let dist = 0;
  for (const ch of token) {
    const baseX = point.x + ux * dist;
    const baseY = point.y + uy * dist;
    if (ch === '|') {
      glyphs.push({
        kind: 'tick',
        x1: baseX + px * CROWSFOOT_TICK_HALF,
        y1: baseY + py * CROWSFOOT_TICK_HALF,
        x2: baseX - px * CROWSFOOT_TICK_HALF,
        y2: baseY - py * CROWSFOOT_TICK_HALF,
      });
      dist += CROWSFOOT_GLYPH_SPACING;
    } else if (ch === 'o') {
      glyphs.push({
        kind: 'circle',
        cx: point.x + ux * (dist + CROWSFOOT_CIRCLE_RADIUS),
        cy: point.y + uy * (dist + CROWSFOOT_CIRCLE_RADIUS),
        r: CROWSFOOT_CIRCLE_RADIUS,
      });
      dist += CROWSFOOT_CIRCLE_RADIUS * 2 + 2;
    } else if (ch === '{' || ch === '}') {
      glyphs.push({
        kind: 'fork',
        apexX: point.x + ux * (dist + CROWSFOOT_FORK_LENGTH),
        apexY: point.y + uy * (dist + CROWSFOOT_FORK_LENGTH),
        prongs: [
          { x: baseX, y: baseY },
          { x: baseX + px * CROWSFOOT_FORK_SPREAD, y: baseY + py * CROWSFOOT_FORK_SPREAD },
          { x: baseX - px * CROWSFOOT_FORK_SPREAD, y: baseY - py * CROWSFOOT_FORK_SPREAD },
        ],
      });
      dist += CROWSFOOT_FORK_LENGTH;
    }
  }
  return glyphs;
}

function renderCardinalityGlyph(glyph: CardinalityGlyph, stroke: string): string {
  switch (glyph.kind) {
    case 'tick':
      return `<line x1="${glyph.x1}" y1="${glyph.y1}" x2="${glyph.x2}" y2="${glyph.y2}" stroke="${stroke}" />`;
    case 'circle':
      return `<circle cx="${glyph.cx}" cy="${glyph.cy}" r="${glyph.r}" fill="white" stroke="${stroke}" />`;
    case 'fork':
      return glyph.prongs
        .map((p) => `<line x1="${glyph.apexX}" y1="${glyph.apexY}" x2="${p.x}" y2="${p.y}" stroke="${stroke}" />`)
        .join('');
  }
}

// canvas-7vs.3: a UML class diagram's arrowhead shape carries real semantic meaning (hollow
// triangle = inheritance/realization, filled diamond = composition, hollow diamond = aggregation,
// plain open arrowhead = association/dependency, small circle = lollipop interface) that the
// generic filled-triangle `#arrowhead` marker every other family shares doesn't distinguish at
// all -- every UML edge previously rendered with that identical generic arrowhead regardless of
// umlRelationKind.
export type UmlMarkerKind = 'triangle-hollow' | 'diamond-filled' | 'diamond-hollow' | 'arrow-open' | 'circle';

/** Which end(s) of a relationship carry a marker, and whether the line itself is dashed --
 *  derived purely from `umlRelationKind` (uml.ts never sets `lineStyle` for these, so dashedness
 *  isn't otherwise available). Token-adjacency in uml.ts's own REL_TOKEN_TO_KIND table decides
 *  which end: inheritance's `<|--`/composition's `*--`/aggregation's `o--` all have their marker
 *  character immediately after the source id, so the marker sits at the SOURCE end; realization's
 *  `..|>`/association's `-->`/dependency's `..>` all have it immediately before the target id, so
 *  TARGET. Lollipop kinds already encode which end directly in their own name. Exported so
 *  Canvas.tsx shares this lookup rather than re-deriving it (SC-004). */
export function umlEndpointMarkers(kind: DiagramEdge['umlRelationKind']): {
  source?: UmlMarkerKind;
  target?: UmlMarkerKind;
  dashed: boolean;
} {
  switch (kind) {
    case 'inheritance':
      return { source: 'triangle-hollow', dashed: false };
    case 'realization':
      return { target: 'triangle-hollow', dashed: true };
    case 'composition':
      return { source: 'diamond-filled', dashed: false };
    case 'aggregation':
      return { source: 'diamond-hollow', dashed: false };
    case 'association':
      return { target: 'arrow-open', dashed: false };
    case 'dependency':
      return { target: 'arrow-open', dashed: true };
    case 'link-dashed':
      return { dashed: true };
    case 'lollipop-source':
      return { source: 'circle', dashed: false };
    case 'lollipop-target':
      return { target: 'circle', dashed: false };
    case 'link-solid':
    default:
      return { dashed: false };
  }
}

const UML_MARKER_LENGTH = 12;
const UML_MARKER_HALF_WIDTH = 5;
const UML_LOLLIPOP_RADIUS = 5;

type Point = { x: number; y: number };

export type UmlEndpointGlyph =
  | { kind: 'triangle'; tip: Point; baseLeft: Point; baseRight: Point; filled: boolean }
  | { kind: 'diamond'; near: Point; right: Point; far: Point; left: Point; filled: boolean }
  | { kind: 'open-arrow'; tip: Point; wingLeft: Point; wingRight: Point }
  | { kind: 'circle'; cx: number; cy: number; r: number };

/** Geometry for one UML relationship-end marker — mirrors `cardinalityGlyphs`' own shared-geometry
 *  convention exactly (`point` is the node-boundary clipped endpoint, `dx`/`dy`'s direction only
 *  is used, pointing outward from the node toward the other endpoint) so the interactive canvas
 *  draws pixel-identical markers to the export renderer (SC-004). */
export function umlEndpointGlyph(point: Point, dx: number, dy: number, markerKind: UmlMarkerKind): UmlEndpointGlyph {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;

  if (markerKind === 'circle') {
    return { kind: 'circle', cx: point.x + ux * UML_LOLLIPOP_RADIUS, cy: point.y + uy * UML_LOLLIPOP_RADIUS, r: UML_LOLLIPOP_RADIUS };
  }
  if (markerKind === 'arrow-open') {
    return {
      kind: 'open-arrow',
      tip: point,
      wingLeft: {
        x: point.x + ux * UML_MARKER_LENGTH + px * UML_MARKER_HALF_WIDTH,
        y: point.y + uy * UML_MARKER_LENGTH + py * UML_MARKER_HALF_WIDTH,
      },
      wingRight: {
        x: point.x + ux * UML_MARKER_LENGTH - px * UML_MARKER_HALF_WIDTH,
        y: point.y + uy * UML_MARKER_LENGTH - py * UML_MARKER_HALF_WIDTH,
      },
    };
  }
  if (markerKind === 'triangle-hollow') {
    return {
      kind: 'triangle',
      tip: point,
      baseLeft: {
        x: point.x + ux * UML_MARKER_LENGTH + px * UML_MARKER_HALF_WIDTH,
        y: point.y + uy * UML_MARKER_LENGTH + py * UML_MARKER_HALF_WIDTH,
      },
      baseRight: {
        x: point.x + ux * UML_MARKER_LENGTH - px * UML_MARKER_HALF_WIDTH,
        y: point.y + uy * UML_MARKER_LENGTH - py * UML_MARKER_HALF_WIDTH,
      },
      filled: false,
    };
  }
  // diamond-filled / diamond-hollow
  const half = UML_MARKER_LENGTH / 2;
  return {
    kind: 'diamond',
    near: point,
    right: { x: point.x + ux * half + px * UML_MARKER_HALF_WIDTH, y: point.y + uy * half + py * UML_MARKER_HALF_WIDTH },
    far: { x: point.x + ux * UML_MARKER_LENGTH, y: point.y + uy * UML_MARKER_LENGTH },
    left: { x: point.x + ux * half - px * UML_MARKER_HALF_WIDTH, y: point.y + uy * half - py * UML_MARKER_HALF_WIDTH },
    filled: markerKind === 'diamond-filled',
  };
}

function renderUmlEndpointGlyph(glyph: UmlEndpointGlyph, stroke: string): string {
  switch (glyph.kind) {
    case 'triangle':
      return `<polygon points="${glyph.tip.x},${glyph.tip.y} ${glyph.baseLeft.x},${glyph.baseLeft.y} ${glyph.baseRight.x},${glyph.baseRight.y}" fill="${glyph.filled ? stroke : 'white'}" stroke="${stroke}" />`;
    case 'diamond':
      return `<polygon points="${glyph.near.x},${glyph.near.y} ${glyph.right.x},${glyph.right.y} ${glyph.far.x},${glyph.far.y} ${glyph.left.x},${glyph.left.y}" fill="${glyph.filled ? stroke : 'white'}" stroke="${stroke}" />`;
    case 'open-arrow':
      return (
        `<line x1="${glyph.tip.x}" y1="${glyph.tip.y}" x2="${glyph.wingLeft.x}" y2="${glyph.wingLeft.y}" stroke="${stroke}" />` +
        `<line x1="${glyph.tip.x}" y1="${glyph.tip.y}" x2="${glyph.wingRight.x}" y2="${glyph.wingRight.y}" stroke="${stroke}" />`
      );
    case 'circle':
      return `<circle cx="${glyph.cx}" cy="${glyph.cy}" r="${glyph.r}" fill="white" stroke="${stroke}" />`;
  }
}

const UML_CARDINALITY_LABEL_OFFSET = 16;
const UML_CARDINALITY_LABEL_SIDE_OFFSET = 8;

/** canvas-7vs.5: position for a UML relationship's multiplicity label (e.g. "1", "0..*") near one
 *  endpoint — offset further along the edge than a marker would reach (so it never overlaps one)
 *  and to one side of the line (so it never sits directly on top of it either). Exported for the
 *  same canvas/export-parity reason every other shared geometry helper in this file is. */
export function umlCardinalityLabelPosition(point: Point, dx: number, dy: number): Point {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  return {
    x: point.x + ux * UML_CARDINALITY_LABEL_OFFSET + px * UML_CARDINALITY_LABEL_SIDE_OFFSET,
    y: point.y + uy * UML_CARDINALITY_LABEL_OFFSET + py * UML_CARDINALITY_LABEL_SIDE_OFFSET,
  };
}

function renderUmlCardinalityLabel(position: Point, text: string): string {
  return `<text x="${position.x}" y="${position.y}" font-size="11" font-family='${FONT_FAMILY}'>${escapeXml(text)}</text>`;
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

  // canvas-x66: an ER entity's attributes or a UML class's members render as a Mermaid-style
  // table body — header band (the entity/class name) over a divider, one row below it per
  // attribute/member — instead of falling through to the plain centered-label case below.
  const tableLayout = tableNodeLayout(node);
  if (tableLayout) {
    const stroke = node.style?.strokeColor ?? '#333333';
    return [
      `<g data-node-id="${escapeXml(node.id)}">`,
      renderNodeShape(node),
      `<line x1="${x}" y1="${tableLayout.dividerY}" x2="${x + width}" y2="${tableLayout.dividerY}" stroke="${stroke}" />`,
      tableLayout.stereotype
        ? `<text x="${tableLayout.stereotype.x}" y="${tableLayout.stereotype.y}" text-anchor="middle" font-size="${tableLayout.stereotype.fontSize}" font-family='${FONT_FAMILY}'>${escapeXml(tableLayout.stereotype.text)}</text>`
        : '',
      renderLabelText(tableLayout.headerX, tableLayout.headerY, node.label, tableLayout.headerFontSize, true, labelMaxWidth),
      tableLayout.rows
        .map(
          (row) =>
            `<text x="${row.x}" y="${row.y}" dominant-baseline="middle" font-size="${row.fontSize}" font-family='${FONT_FAMILY}'>${escapeXml(row.text)}</text>`,
        )
        .join(''),
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
  // canvas-7vs.2: a sequence `rect <color> ... end` background highlight's entire visual purpose
  // is its fill color (diagram-model.ts's own doc comment on DiagramContainer.role: "the color
  // lives in style, not label, which stays empty") -- previously hardcoded to 'none', so the
  // construct was accepted and positioned but rendered completely uncolored. Every other
  // container role (loop/alt/box/note/etc, which never set style.fillColor) is unaffected.
  const fill = container.style?.fillColor ?? 'none';
  return [
    `<g data-container-id="${escapeXml(container.id)}">`,
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}" stroke="#888888" stroke-dasharray="6,4" />`,
    `<text x="${x + 8}" y="${y + 16}" font-size="12" font-family='${FONT_FAMILY}'>${escapeXml(container.label)}</text>`,
    '</g>',
  ].join('');
}

function renderEdge(
  edge: DiagramModel['edges'][number],
  nodesById: Map<string, DiagramNode>,
  containersById: Map<string, DiagramContainer>,
): string {
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
  // canvas-7vs.7: {group} escalates the clip box to the parent container's boundary instead of
  // the node's own (architectureEndpointBox falls back to the node's own box for every non-
  // architecture edge, since sourceIsGroup/targetIsGroup are always undefined there).
  const sourceBox = architectureEndpointBox(source, edge.sourceIsGroup, containersById);
  const targetBox = architectureEndpointBox(target, edge.targetIsGroup, containersById);
  // canvas-7vs.6: an explicit :T/:B/:L/:R anchor hint pins the endpoint to that side instead of
  // clipEdgeEndpoint's direction-toward-the-other-node default.
  const clippedFrom = edge.sourceAnchor
    ? clipToAnchorSide(sourceBox.center, sourceBox.size, edge.sourceAnchor)
    : clipEdgeEndpoint(sourceBox.center, sourceBox.size, sourceBox.shape, targetBox.center.x, targetBox.center.y);
  const clippedTo = edge.targetAnchor
    ? clipToAnchorSide(targetBox.center, targetBox.size, edge.targetAnchor)
    : clipEdgeEndpoint(targetBox.center, targetBox.size, targetBox.shape, sourceBox.center.x, sourceBox.center.y);
  const label = edge.label ? renderLabelText(midX, midY - 4, edge.label, 12, false) : '';
  // Grouping B: lineStyle supplies a default treatment (dotted dasharray, thick width) that an
  // explicit edge.style (linkStyle) override still wins over, since linkStyle is layered on top.
  const isInvisible = edge.lineStyle === 'invisible';
  const stroke = isInvisible ? 'none' : (edge.style?.strokeColor ?? '#333333');
  const strokeWidthValue = edge.style?.strokeWidth ?? (edge.lineStyle === 'thick' ? DEFAULT_THICK_STROKE_WIDTH : undefined);
  const strokeWidth = strokeWidthValue ? ` stroke-width="${strokeWidthValue}"` : '';
  // canvas-7vs.3: uml.ts never sets lineStyle for these -- realization/dependency/link-dashed are
  // dashed purely by umlRelationKind, so this is derived here rather than read off a field.
  const umlMarkers = edge.umlRelationKind ? umlEndpointMarkers(edge.umlRelationKind) : undefined;
  const dasharrayValue =
    edge.style?.strokeDasharray ?? (edge.lineStyle === 'dotted' || umlMarkers?.dashed ? DEFAULT_DOTTED_DASHARRAY : undefined);
  const strokeDasharray = dasharrayValue ? ` stroke-dasharray="${dasharrayValue}"` : '';
  // canvas-2ut: an ER relationship's crow's-foot cardinality glyphs REPLACE the generic
  // arrowhead entirely — standard ERD notation has no arrowheads at all, only these symbols.
  const hasErCardinality = Boolean(edge.erSourceCardinality && edge.erTargetCardinality);
  // canvas-7vs.3: likewise, any UML umlRelationKind draws its own marker (or deliberately none,
  // for link-solid/link-dashed) instead of the generic arrowhead — never both.
  const suppressGenericMarker = hasErCardinality || Boolean(umlMarkers);
  const markerEnd = isInvisible || suppressGenericMarker || edge.arrow === 'none' ? '' : ' marker-end="url(#arrowhead)"';
  const markerStart = !isInvisible && !suppressGenericMarker && edge.arrow === 'both' ? ' marker-start="url(#arrowhead)"' : '';
  const cardinalityMarkup =
    isInvisible || !hasErCardinality
      ? ''
      : [
          ...cardinalityGlyphs(clippedFrom, to.x - from.x, to.y - from.y, edge.erSourceCardinality!),
          // canvas-2ut: the target token is written nearest-line-character-first in the DSL
          // (e.g. "o{" in `||--o{`, read left-to-right as [near the "--", near the target
          // entity]) — reversed here so cardinalityGlyphs' own nearest-node-first convention
          // (shared with the source side above) still applies without a second code path.
          ...cardinalityGlyphs(clippedTo, from.x - to.x, from.y - to.y, [...edge.erTargetCardinality!].reverse().join('')),
        ]
          .map((glyph) => renderCardinalityGlyph(glyph, stroke))
          .join('');
  const umlMarkerMarkup =
    isInvisible || !umlMarkers
      ? ''
      : [
          umlMarkers.source ? umlEndpointGlyph(clippedFrom, to.x - from.x, to.y - from.y, umlMarkers.source) : null,
          umlMarkers.target ? umlEndpointGlyph(clippedTo, from.x - to.x, from.y - to.y, umlMarkers.target) : null,
        ]
          .filter((glyph): glyph is UmlEndpointGlyph => glyph !== null)
          .map((glyph) => renderUmlEndpointGlyph(glyph, stroke))
          .join('');
  // canvas-7vs.5: UML relationship multiplicity labels (e.g. "1", "0..*") near each endpoint --
  // independent of umlRelationKind (a plain association can still carry cardinality).
  const cardinalityLabelMarkup = isInvisible
    ? ''
    : [
        edge.sourceCardinality
          ? renderUmlCardinalityLabel(umlCardinalityLabelPosition(clippedFrom, to.x - from.x, to.y - from.y), edge.sourceCardinality)
          : '',
        edge.targetCardinality
          ? renderUmlCardinalityLabel(umlCardinalityLabelPosition(clippedTo, from.x - to.x, from.y - to.y), edge.targetCardinality)
          : '',
      ].join('');
  return `<g data-edge-id="${escapeXml(edge.id)}"><line x1="${clippedFrom.x}" y1="${clippedFrom.y}" x2="${clippedTo.x}" y2="${clippedTo.y}" stroke="${stroke}"${strokeWidth}${strokeDasharray}${markerStart}${markerEnd} />${cardinalityMarkup}${umlMarkerMarkup}${cardinalityLabelMarkup}${label}</g>`;
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
  const containersById = new Map(model.containers.map((c) => [c.id, c]));
  const { width, height } = computeBounds(model);

  const containerMarkup = model.containers.map(renderContainer).join('');
  const edgeMarkup = model.edges.map((e) => renderEdge(e, nodesById, containersById)).join('');
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
