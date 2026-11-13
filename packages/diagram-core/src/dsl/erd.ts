import { inReadOrder } from './read-order.js';
import { createEmptyDiagramModel, type DiagramContainer, type DiagramModel, type DiagramNode, type EntityAttribute, type NodeStyle } from '../model/diagram-model.js';
import { computeContainmentLayout } from '../model/containment-layout.js';
import { splitFrontMatter, joinFrontMatter, stripTrailingComment, type CanvasFrontMatter, readLegend, readPinned, applyLinks, withLegend, withPinned, withLinks, NO_ENTRIES } from './front-matter.js';
import type { FlowchartDirection } from '../model/diagram-model.js';
import type { ParseError, ParseResult } from './types.js';

const ID = String.raw`[A-Za-z0-9_-]+`;
const PLAIN_ID = new RegExp(`^${ID}$`);
// canvas-lwa4: a relationship end may be a quoted subgraph id (`"Customer Domain" ||--o{ ORDER : has`).
const END = String.raw`(${ID}|"[^"]+")`;
// CUSTOMER ||--o{ ORDER : places
const RELATIONSHIP_PATTERN = new RegExp(`^${END}\\s+([|o}{.-]+)\\s+${END}\\s*:\\s*(.+)$`);
// canvas-lwa4: Mermaid 11.17 subgraphs. `subgraph Sales`, `subgraph "Customer Domain"`, `subgraph s1 [Sales team]`;
// closed by `end`; nestable; `direction` inside one is the subgraph's own.
const SUBGRAPH_START = new RegExp(`^subgraph\\s+(${ID}|"[^"]+")(?:\\s*\\[([^\\]]*)\\])?$`);
const SUBGRAPH_END = /^end$/;
/** A subgraph title as Mermaid joins it: its words (a quoted word without its quotes) with single spaces. */
const titleWords = (text: string): string => (text.match(/"[^"]*"|[^\s"]+/g) ?? []).map((word) => word.replace(/"/g, '')).join(' ');
/** A subgraph or relationship-end id as written: quoted when it isn't a plain id. */
const erName = (id: string): string => (PLAIN_ID.test(id) ? id : `"${id.replace(/"/g, '')}"`);
/** A subgraph title as written: bare when Mermaid reads it as plain words, else quoted. */
const titleText = (label: string): string =>
  /^[\w\-*\u0080-\uFFFF]+(?: [\w\-*\u0080-\uFFFF]+)*$/.test(label) ? label : `"${label.replace(/"/g, '')}"`;
// canvas-vcv follow-up: exported (re-exported via index.ts's `export * from './dsl/erd.js'`) so
// the interactive canvas's connect-mode gesture can give a freshly-drawn ER relationship real
// cardinality data at creation time, instead of only visually defaulting to a plain arrow until a
// save/reparse round-trip re-derives DEFAULT_CARDINALITY below. One shared source of truth for
// both, rather than the canvas hardcoding its own copy of '||'/'o{' that could silently drift
// from this file's own default.
export const DEFAULT_ER_SOURCE_CARDINALITY = '||';
export const DEFAULT_ER_TARGET_CARDINALITY = 'o{';
const DEFAULT_CARDINALITY = `${DEFAULT_ER_SOURCE_CARDINALITY}--${DEFAULT_ER_TARGET_CARDINALITY}`;
// canvas-2s6.4: the 4 meaningful crow's-foot cardinality tokens per side (zero/exactly-one,
// zero/one-or-many, mirrored for source vs. target) — RELATIONSHIP_PATTERN's own character class
// is more permissive than this (any run of `|o}{.-` chars), but these are the only combinations
// that are real, meaningful crow's-foot notation; exported as the single source of truth for the
// canvas UI's cardinality pickers (connect-mode and the post-hoc popup) and the AI tool schema,
// same precedent as DEFAULT_ER_SOURCE_CARDINALITY/DEFAULT_ER_TARGET_CARDINALITY above.
export const ER_SOURCE_CARDINALITY_TOKENS = ['||', '|o', '}|', '}o'] as const;
export const ER_TARGET_CARDINALITY_TOKENS = ['||', 'o|', '|{', 'o{'] as const;
// A relationship's label is NOT optional in real Mermaid erDiagram grammar (RELATIONSHIP_PATTERN's
// own `(.+)$` requires at least one character) -- unlike flowchart/UML, there is no valid
// zero-label form to fall back to. serializeErd must never emit one, regardless of how the edge
// was created (e.g. the canvas's connect-mode gesture, which sets no label at all) or a
// freshly-drawn relationship would fail to re-parse the very next time its own DSL is applied.
export const DEFAULT_RELATIONSHIP_LABEL = 'relates to';
// CUSTOMER {
const ENTITY_BLOCK_START = new RegExp(`^(${ID})\\s*\\{$`);
const BLOCK_END = /^\}$/;
// string id PK, UK "comment"
// canvas-lwa4: a type or name may be written in backticks (Mermaid 11.16), so it can hold spaces:
// `` string `first name` PK ``. The backticks aren't part of the word.
const ATTRIBUTE_WORD = String.raw`(\`[^\`]+\`|[^\s\`]\S*)`;
const ATTRIBUTE_LINE = new RegExp(`^${ATTRIBUTE_WORD}\\s+${ATTRIBUTE_WORD}(?:\\s+([^"]*?))?\\s*(?:"([^"]*)")?$`);
const unquoteWord = (word: string): string => (word.startsWith('`') ? word.slice(1, -1) : word);
/** A type or name as written: in backticks when it holds whitespace or a double quote (and no backtick). */
const attributeWord = (word: string): string => (/[\s"]/.test(word) && !word.includes('`') ? `\`${word}\`` : word);
const RECOGNIZED_KEYS = new Set(['PK', 'FK', 'UK']);

// jmuir-dtu.6: entity aliases — "An alias can be added to an entity using square brackets. If
// provided, the alias will be showed in the diagram instead of the entity name" (Mermaid docs).
// Both a standalone alias declaration (`p[Person]`) and an aliased attribute block start
// (`p[Person] {`) are real syntax — the bracket part is identical, only the trailing `{` differs.
const ALIAS_BLOCK_START = new RegExp(`^(${ID})\\s*\\[([^\\]]+)\\]\\s*\\{$`);
const ALIAS_PATTERN = new RegExp(`^(${ID})\\s*\\[([^\\]]+)\\]$`);
// A bare entity declaration with no relationship/attributes/alias at all — real Mermaid's own
// basic-syntax grammar makes the relationship part of `<entity> [<rel> <entity> : <label>]`
// optional, so `CUSTOMER` alone is valid. Needed so a standalone (no attributes, no edges) entity
// round-trips instead of silently vanishing on serialize (FR-003: no element is silently dropped).
const BARE_ENTITY = new RegExp(`^(${ID})$`);
// direction TB|BT|LR|RL — top-level only (ER has no subgraph-equivalent nesting to scope it to).
// TD isn't Mermaid's here (only TB), but Auto Layout's top-down wrote it (canvas-rshf), so it is read too.
const DIRECTION_PATTERN = /^direction\s+(TB|TD|BT|LR|RL)$/i;
const TITLE_PATTERN = /^title\s+(.+)$/;
// jmuir-dtu.17: same cross-family precedent as TITLE_PATTERN. Single-line colon form only; the
// multi-line `accDescr { ... }` block form is out of scope (a clean parse error, not a silent
// drop).
const ACC_TITLE_PATTERN = /^accTitle\s*:\s*(.+)$/;
const ACC_DESCR_PATTERN = /^accDescr\s*:\s*(.+)$/;
// jmuir-dtu.18: same shared precedent as flowchart-parser.ts's own copy of this constant/handling
// -- see that file for the full writeup.
const MERMAID_CONFIG_DIRECTIVE_PATTERN = /^%%\{.*\}%%$/;
// style/classDef/class/::: — identical grammar and precedence to flowchart-parser.ts's own
// versions (style/classDef/class groupings, docs/flowchart-completeness-brief.md grouping C) —
// each DSL family's parser is self-contained by this codebase's own convention, so this is a
// deliberate copy, not a shared import.
const STYLE_DIRECTIVE = new RegExp(`^style\\s+(${ID})\\s+(.+)$`);
const CLASSDEF_DIRECTIVE = new RegExp(`^classDef\\s+(${ID})\\s+(.+?);?$`);
const CLASS_ASSIGN_DIRECTIVE = new RegExp(`^class\\s+((?:${ID})(?:\\s*,\\s*${ID})*)\\s+(${ID})\\s*;?$`);
// Shorthand form: `id:::className` or `id[Alias]:::className,otherClassName`.
const CLASS_SHORTHAND = new RegExp(`^(${ID})(?:\\s*\\[([^\\]]+)\\])?:::(${ID}(?:\\s*,\\s*${ID})*)$`);

/** Shared by `style <entityId> ...` and `classDef <name> ...` — same prop grammar as flowchart's
 *  own parseStyleProps. Unrecognized properties are silently ignored (same convention). */
function parseStyleProps(propsRaw: string): NodeStyle {
  const style: NodeStyle = {};
  for (const prop of propsRaw.split(',')) {
    const [key, value] = prop.split(':').map((part) => part.trim());
    if (key === 'fill') style.fillColor = value;
    else if (key === 'stroke') style.strokeColor = value;
    else if (key === 'stroke-width') style.strokeWidth = Number.parseFloat(value);
    else if (key === 'stroke-dasharray') style.strokeDasharray = value;
  }
  return style;
}

// canvas-2ut: splits a relationship's full middle token (e.g. "||--o{", "}o..||") into its two
// 2-character crow's-foot cardinality tokens plus whether the line is dashed (non-identifying,
// `..`) or solid (identifying, `--`) — real Mermaid grammar always uses exactly one of those two
// fixed-length separators between two fixed-length cardinality tokens. Returns null for a
// malformed token (defensive only — RELATIONSHIP_PATTERN's own character class already
// constrains what can reach here); parsing/rendering simply proceeds without cardinality data in
// that case, rather than hard-erroring the whole line, matching this file's existing
// unrecognized-detail-is-silently-ignored convention (e.g. parseStyleProps above).
function parseCardinalityToken(token: string): { source: string; target: string; dashed: boolean } | null {
  const match = token.match(/^([|o{}]{2})(--|\.\.)([|o{}]{2})$/);
  if (!match) return null;
  const [, source, line, target] = match;
  return { source, target, dashed: line === '..' };
}

let autoPositionCounter = 0;
function nextPosition(): { x: number; y: number } {
  const position = { x: (autoPositionCounter % 4) * 200 + 40, y: Math.floor(autoPositionCounter / 4) * 140 + 40 };
  autoPositionCounter += 1;
  return position;
}

/**
 * Parses Mermaid `erDiagram` (entity-relationship). canvas-2ut: the crow's-foot cardinality
 * notation (`||--o{`, `||--||`, etc.) is captured into `DiagramEdge.erSourceCardinality`/
 * `erTargetCardinality` (raw 2-character tokens, `lineStyle: 'dotted'` for a non-identifying
 * `..` relationship) and round-trips exactly on serialize — previously parsed and discarded
 * entirely, silently normalizing every relationship to the default one-to-many token on export.
 */
export function parseErd(dsl: string): ParseResult {
  autoPositionCounter = 0;
  const { frontMatter, body } = splitFrontMatter(dsl);
  const positions = frontMatter.canvas?.positions ?? NO_ENTRIES;
  const styles = frontMatter.canvas?.styles ?? NO_ENTRIES;
  const containerMeta = frontMatter.canvas?.containers ?? NO_ENTRIES;
  const isFreshImport = Object.keys(positions).length === 0 && Object.keys(containerMeta).length === 0;

  const lines = body.split(/\r?\n/);
  const errors: ParseError[] = [];
  const nodesById = new Map<string, DiagramNode>();
  const edges: {
    id: string;
    sourceId: string;
    targetId: string;
    label?: string;
    erSourceCardinality?: string;
    erTargetCardinality?: string;
    lineStyle?: 'dotted';
  }[] = [];
  let headerSeen = false;
  let edgeCounter = 0;
  let openEntity: { id: string; line: number; content: string } | null = null;
  let direction: FlowchartDirection | undefined;
  let title: string | undefined;
  let accTitle: string | undefined;
  let accDescr: string | undefined;
  let mermaidConfigDirective: string | undefined;

  // jmuir-dtu.6: style/classDef/class(+shorthand) are applied as a second pass once every entity
  // is known — mirrors flowchart-parser.ts's own style/classDef second-pass convention exactly,
  // so a class assignment referencing an entity or classDef declared later in the file still
  // resolves, and an explicit `style` line overrides a class-applied property on the same entity.
  const classDefs = new Map<string, NodeStyle>();
  const classAssignments: { entityIds: string[]; className: string }[] = [];
  const styleDirectives: { entityId: string; propsRaw: string }[] = [];

  // canvas-lwa4: subgraphs. Membership is settled after reading, as Mermaid does: in the order subgraphs close
  // (inner ones first), each takes the entities named directly inside it that no subgraph has taken yet.
  const subgraphsById = new Map<string, DiagramContainer>();
  const subgraphStack: { id: string; line: number; content: string; mentions: string[] }[] = [];
  const closedSubgraphs: { id: string; mentions: string[] }[] = [];
  const declaredEntities = new Map<string, { line: number; content: string }>();
  const quotedEnds: { name: string; line: number; content: string }[] = [];
  const mention = (id: string) => subgraphStack[subgraphStack.length - 1]?.mentions.push(id);
  let lineIndex = 0;
  const declare = (id: string) => {
    if (!declaredEntities.has(id)) declaredEntities.set(id, { line: lineIndex + 1, content: lines[lineIndex] });
    mention(id);
  };

  const ensureEntity = (id: string, aliasLabel?: string) => {
    const existing = nodesById.get(id);
    if (!existing) {
      nodesById.set(id, {
        id,
        label: aliasLabel ?? id,
        shape: 'rectangle',
        role: 'entity',
        position: positions[id] ?? nextPosition(),
        style: styles[id],
      });
    } else if (aliasLabel !== undefined) {
      existing.label = aliasLabel;
    }
  };

  const pushAttribute = (entityId: string, attribute: EntityAttribute) => {
    const node = nodesById.get(entityId)!;
    node.attributes = node.attributes ? [...node.attributes, attribute] : [attribute];
  };

  for (let i = 0; i < lines.length; i += 1) {
    lineIndex = i;
    const rawLine = lines[i];
    let line = rawLine.trim();
    if (!line) continue;

    if (MERMAID_CONFIG_DIRECTIVE_PATTERN.test(line)) {
      mermaidConfigDirective = line;
      continue;
    }

    line = stripTrailingComment(line);
    if (!line) continue;

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
        const [, type, name, constraintsRaw, comment] = attrMatch;
        const keys = (constraintsRaw ?? '')
          .split(',')
          .map((k) => k.trim().toUpperCase())
          .filter((k) => RECOGNIZED_KEYS.has(k));
        // canvas-??? (attribute comment round-trip): previously captured by ATTRIBUTE_LINE's own
        // 4th group and immediately discarded — a real Mermaid attribute comment ("does not
        // impact the rendering of the diagram" per Mermaid's own docs, but is still real authored
        // content) silently vanished on every save.
        pushAttribute(openEntity.id, { type: unquoteWord(type), name: unquoteWord(name), keys, comment: comment || undefined });
        continue;
      }
      errors.push({ line: i + 1, content: rawLine, message: `Could not interpret line as an entity attribute: "${line}"` });
      continue;
    }

    const subgraphStart = line.match(SUBGRAPH_START);
    if (subgraphStart) {
      const [, rawId, rawTitle] = subgraphStart;
      const id = rawId.startsWith('"') ? rawId.slice(1, -1) : rawId;
      if (subgraphsById.has(id)) {
        errors.push({ line: i + 1, content: rawLine, message: `Subgraph '${id}' is declared twice` });
      }
      // Stored numbers only: a place or size that isn't one (hand-edited front matter) is worked out again.
      const meta = containerMeta[id] as Record<string, unknown> | undefined;
      const stored = (key: string): number | undefined => (meta && typeof meta === 'object' && typeof meta[key] === 'number' ? (meta[key] as number) : undefined);
      const [x, y, width, height] = [stored('x'), stored('y'), stored('width'), stored('height')];
      const title = rawTitle === undefined ? '' : titleWords(rawTitle);
      subgraphsById.set(id, {
        id,
        label: title || id,
        position: x !== undefined && y !== undefined ? { x, y } : isFreshImport ? { x: 0, y: 0 } : nextPosition(),
        size: width !== undefined && height !== undefined ? { width, height } : undefined,
        parentContainerId: subgraphStack[subgraphStack.length - 1]?.id,
      });
      subgraphStack.push({ id, line: i + 1, content: rawLine, mentions: [] });
      continue;
    }

    if (subgraphStack.length > 0 && SUBGRAPH_END.test(line)) {
      const closed = subgraphStack.pop()!;
      closedSubgraphs.push({ id: closed.id, mentions: closed.mentions });
      continue;
    }

    const directionMatch = line.match(DIRECTION_PATTERN);
    if (directionMatch) {
      const value = directionMatch[1].toUpperCase() as FlowchartDirection;
      const open = subgraphStack[subgraphStack.length - 1];
      if (open) subgraphsById.get(open.id)!.direction = value;
      else direction = value;
      continue;
    }

    // canvas-vtg: mirrors c4.ts's own TITLE_PATTERN/handling exactly (canvas-79b introduced it
    // there first) -- a real, cross-family Mermaid top-level statement.
    const titleMatch = line.match(TITLE_PATTERN);
    if (titleMatch) {
      title = titleMatch[1];
      continue;
    }

    const accTitleMatch = line.match(ACC_TITLE_PATTERN);
    if (accTitleMatch) {
      accTitle = accTitleMatch[1];
      continue;
    }

    const accDescrMatch = line.match(ACC_DESCR_PATTERN);
    if (accDescrMatch) {
      accDescr = accDescrMatch[1];
      continue;
    }

    const aliasBlockStart = line.match(ALIAS_BLOCK_START);
    if (aliasBlockStart) {
      const [, id, alias] = aliasBlockStart;
      ensureEntity(id, alias);
      declare(id);
      openEntity = { id, line: i + 1, content: rawLine };
      continue;
    }

    const blockStart = line.match(ENTITY_BLOCK_START);
    if (blockStart) {
      const [, id] = blockStart;
      ensureEntity(id);
      declare(id);
      openEntity = { id, line: i + 1, content: rawLine };
      continue;
    }

    const classShorthand = line.match(CLASS_SHORTHAND);
    if (classShorthand) {
      const [, id, alias, classNames] = classShorthand;
      ensureEntity(id, alias);
      declare(id);
      classAssignments.push({ entityIds: [id], className: classNames.split(',')[0].trim() });
      continue;
    }

    // jmuir-dtu.6 bugfix: style/classDef/class must be checked before RELATIONSHIP_PATTERN, not
    // after — mirroring flowchart-parser.ts's own ordering (style/linkStyle/classDef/class are all
    // matched before any edge pattern there). RELATIONSHIP_PATTERN's cardinality group
    // (`[|o}{.-]+`) can match a single-character entity id of literally `o` (a plausible
    // abbreviation, e.g. for "Order"), so without this ordering a line like
    // `style o stroke-width:3` was misread as a relationship between two bogus entities `style`
    // and `stroke-width` instead of a style directive on entity `o`.
    const styleMatch = line.match(STYLE_DIRECTIVE);
    if (styleMatch) {
      const [, entityId, propsRaw] = styleMatch;
      styleDirectives.push({ entityId, propsRaw });
      continue;
    }

    const classDefMatch = line.match(CLASSDEF_DIRECTIVE);
    if (classDefMatch) {
      const [, className, propsRaw] = classDefMatch;
      classDefs.set(className, parseStyleProps(propsRaw));
      continue;
    }

    const classAssignMatch = line.match(CLASS_ASSIGN_DIRECTIVE);
    if (classAssignMatch) {
      const [, idList, className] = classAssignMatch;
      classAssignments.push({ entityIds: idList.split(',').map((id) => id.trim()), className });
      continue;
    }

    const relMatch = line.match(RELATIONSHIP_PATTERN);
    if (relMatch) {
      const [, rawSource, cardinalityToken, rawTarget, rawLabel] = relMatch;
      // A quoted end can only be a subgraph (checked once every subgraph is known); a plain one is an entity
      // unless it turns out to be a subgraph's id.
      const endName = (raw: string): string => {
        if (!raw.startsWith('"')) {
          ensureEntity(raw);
          mention(raw);
          return raw;
        }
        quotedEnds.push({ name: raw.slice(1, -1), line: i + 1, content: rawLine });
        return raw.slice(1, -1);
      };
      const source = endName(rawSource);
      const target = endName(rawTarget);
      edgeCounter += 1;
      const cardinality = parseCardinalityToken(cardinalityToken);
      // canvas-??? (quoted relationship label): a label may be quoted in real Mermaid (needed
      // if it contains a comma, or just written that way out of habit) — previously the literal
      // quote characters were kept as part of the label text itself and rendered visibly (e.g.
      // `"places, urgently"` shown with its quote marks), unlike every other quoted-string value
      // elsewhere in this codebase (c4.ts's own POSITIONAL_MACRO_ARG strips its quotes the same
      // way). Only stripped when the ENTIRE label is one quoted span start-to-end — a label with
      // an internal quote not wrapping the whole string is left exactly as written.
      const quotedLabel = rawLabel.match(/^"([\s\S]*)"$/);
      const label = quotedLabel ? quotedLabel[1] : rawLabel;
      edges.push({
        id: `e${edgeCounter}`,
        sourceId: source,
        targetId: target,
        label,
        erSourceCardinality: cardinality?.source,
        erTargetCardinality: cardinality?.target,
        lineStyle: cardinality?.dashed ? 'dotted' : undefined,
      });
      continue;
    }

    const aliasOnly = line.match(ALIAS_PATTERN);
    if (aliasOnly) {
      const [, id, alias] = aliasOnly;
      ensureEntity(id, alias);
      declare(id);
      continue;
    }

    const bareEntity = line.match(BARE_ENTITY);
    if (bareEntity) {
      ensureEntity(bareEntity[1]);
      declare(bareEntity[1]);
      continue;
    }

    errors.push({ line: i + 1, content: rawLine, message: `Could not interpret line as an entity, relationship, or directive: "${line}"` });
  }

  if (openEntity) {
    errors.push({
      line: openEntity.line,
      content: openEntity.content,
      message: `Unclosed attribute block for entity '${openEntity.id}' opened at line ${openEntity.line}`,
    });
  }
  for (const open of subgraphStack) {
    errors.push({ line: open.line, content: open.content, message: `Unclosed subgraph '${open.id}' opened at line ${open.line}` });
  }
  for (const { name, line, content } of quotedEnds) {
    if (!subgraphsById.has(name)) errors.push({ line, content, message: `"${name}" is not a subgraph: only a subgraph's id may be quoted` });
  }
  for (const [id, where] of declaredEntities) {
    if (subgraphsById.has(id)) errors.push({ ...where, message: `'${id}' is both an entity and a subgraph` });
  }

  if (errors.length > 0) return { errors };

  // A relationship end naming a subgraph is the subgraph, not an entity.
  for (const id of subgraphsById.keys()) nodesById.delete(id);
  for (const { id, mentions } of closedSubgraphs) {
    for (const entityId of mentions) {
      const node = nodesById.get(entityId);
      if (node && node.containerId === undefined) node.containerId = id;
    }
  }
  if (isFreshImport && subgraphsById.size > 0) {
    const allNodes = Array.from(nodesById.values());
    const allContainers = Array.from(subgraphsById.values());
    const layout = computeContainmentLayout(allNodes, allContainers);
    for (const node of allNodes) node.position = layout.nodePositions.get(node.id) ?? node.position;
    for (const container of allContainers) {
      container.position = layout.containerPositions.get(container.id) ?? container.position;
      container.size = layout.containerSizes.get(container.id);
    }
  }

  // Class assignments before style directives, so an explicit `style` line on the same entity
  // overrides a class-applied property — same precedence flowchart-parser.ts already established.
  for (const { entityIds, className } of classAssignments) {
    const classStyle = classDefs.get(className);
    if (!classStyle) continue;
    for (const entityId of entityIds) {
      const node = nodesById.get(entityId);
      if (!node) continue;
      node.style = { ...node.style, ...classStyle };
    }
  }
  for (const { entityId, propsRaw } of styleDirectives) {
    const node = nodesById.get(entityId);
    if (!node) continue;
    node.style = { ...node.style, ...parseStyleProps(propsRaw) };
  }

  const model = createEmptyDiagramModel('erd');
  model.nodes = Array.from(nodesById.values());
  model.edges = edges;
  model.containers = Array.from(subgraphsById.values());
  model.direction = direction;
  model.title = title;
  model.accTitle = accTitle;
  model.accDescr = accDescr;
  model.mermaidConfigDirective = mermaidConfigDirective;
  model.legend = readLegend(frontMatter);
  const pinned = readPinned(frontMatter, model);
  if (pinned) model.pinned = pinned;
  applyLinks(frontMatter, model);
  return { model };
}

/** Writes the model as Mermaid text, in the order reading it back gives (canvas-ra0g: see inReadOrder). */
export function serializeErd(model: DiagramModel): string {
  return writeErd(inReadOrder(model, parseErd, writeErd));
}

function writeErd(model: DiagramModel): string {
  const frontMatter: CanvasFrontMatter = {
    canvas: {
      positions: Object.fromEntries(model.nodes.map((n) => [n.id, n.position])),
      styles: Object.fromEntries(model.nodes.filter((n) => n.style).map((n) => [n.id, n.style!])),
      // canvas-lwa4: subgraphs' places and sizes, as flowchart and class diagrams keep their groups' (only when
      // there are any, so diagrams without subgraphs are written as before).
      ...(model.containers.length > 0
        ? {
            containers: Object.fromEntries(
              model.containers.map((c) => [
                c.id,
                c.size ? { x: c.position.x, y: c.position.y, width: c.size.width, height: c.size.height } : { x: c.position.x, y: c.position.y },
              ]),
            ),
          }
        : {}),
    },
  };

  const lines: string[] = ['erDiagram'];
  if (model.title) lines.push(`title ${model.title}`);
  if (model.mermaidConfigDirective) lines.unshift(model.mermaidConfigDirective);
  if (model.accTitle) lines.push(`accTitle: ${model.accTitle}`);
  if (model.accDescr) lines.push(`accDescr: ${model.accDescr}`);
  if (model.direction) lines.push(`direction ${model.direction === 'TD' ? 'TB' : model.direction}`);

  const declared = new Set<string>();
  const declarationFor = (node: DiagramNode): string => (node.label !== node.id ? `${node.id}[${node.label}]` : node.id);
  const attributeBlock = (node: DiagramNode, indent: string): string[] => [
    `${indent}${declarationFor(node)} {`,
    ...(node.attributes ?? []).map((attribute) => {
      const keysPart = attribute.keys.length > 0 ? ` ${attribute.keys.join(', ')}` : '';
      const commentPart = attribute.comment ? ` "${attribute.comment}"` : '';
      return `${indent}  ${attributeWord(attribute.type)} ${attributeWord(attribute.name)}${keysPart}${commentPart}`;
    }),
    `${indent}}`,
  ];

  // canvas-lwa4: subgraph blocks first (a relationship can name a subgraph only once its block has ended, in
  // Mermaid), each declaring its own entities. An aliased entity without attributes is written with an empty
  // block: Mermaid's bare `id[Alias]` line doesn't put the entity in the subgraph.
  const containerIds = new Set(model.containers.map((c) => c.id));
  const written = new Set<string>();
  const writeSubgraph = (container: DiagramContainer, indent: string) => {
    if (written.has(container.id)) return;
    written.add(container.id);
    const title = container.label && container.label !== container.id ? ` [${titleText(container.label)}]` : '';
    lines.push(`${indent}subgraph ${erName(container.id)}${title}`);
    if (container.direction) lines.push(`${indent}  direction ${container.direction === 'TD' ? 'TB' : container.direction}`);
    for (const node of model.nodes) {
      if (node.containerId !== container.id || declared.has(node.id)) continue;
      if ((node.attributes && node.attributes.length > 0) || node.label !== node.id) lines.push(...attributeBlock(node, `${indent}  `));
      else lines.push(`${indent}  ${node.id}`);
      declared.add(node.id);
    }
    for (const child of model.containers) {
      if (child.parentContainerId === container.id) writeSubgraph(child, `${indent}  `);
    }
    lines.push(`${indent}end`);
  };
  for (const container of model.containers) {
    if (container.parentContainerId === undefined || !containerIds.has(container.parentContainerId)) writeSubgraph(container, '');
  }
  // Groups whose parents form a loop (a broken model) still get written, at the top level.
  for (const container of model.containers) writeSubgraph(container, '');

  for (const node of model.nodes) {
    if (!declared.has(node.id) && node.attributes && node.attributes.length > 0) {
      lines.push(...attributeBlock(node, ''));
      declared.add(node.id);
    }
  }
  // jmuir-dtu.6 bugfix: a relationship line only ever references an entity by its bare id
  // (`sourceId`/`targetId` — there's no room in `<id> <cardinality> <id> : <label>` for a bracketed
  // alias), so an aliased entity with no attribute block that appears only in a relationship must
  // get its own standalone `id[Alias]` declaration line first, or its alias is silently lost even
  // though parsing captured it correctly (order-independence of alias resolution is a parse-side
  // guarantee only — serialize still needs an explicit declaration to carry the alias back out).
  for (const node of model.nodes) {
    if (!declared.has(node.id) && node.label !== node.id) {
      lines.push(declarationFor(node));
      declared.add(node.id);
    }
  }
  for (const edge of model.edges) {
    // canvas-2ut: round-trips the real cardinality tokens when present (imported from DSL, or
    // set some other way); DEFAULT_CARDINALITY only ever covers an edge that never had ER
    // cardinality data at all — e.g. one added via the canvas UI's plain "add edge" action.
    const lineToken = edge.lineStyle === 'dotted' ? '..' : '--';
    const cardinalityToken =
      edge.erSourceCardinality && edge.erTargetCardinality
        ? `${edge.erSourceCardinality}${lineToken}${edge.erTargetCardinality}`
        : DEFAULT_CARDINALITY;
    lines.push(`${erName(edge.sourceId)} ${cardinalityToken} ${erName(edge.targetId)} : ${edge.label?.trim() || DEFAULT_RELATIONSHIP_LABEL}`);
    declared.add(edge.sourceId);
    declared.add(edge.targetId);
  }
  // jmuir-dtu.6: an entity with no attribute block and no relationship (a bare alias declaration,
  // or any other standalone entity) previously vanished entirely on serialize — FR-003 requires no
  // element be silently dropped. Emitted last so entities already introduced by an attribute block,
  // the alias pass above, or a relationship line aren't redundantly re-declared.
  for (const node of model.nodes) {
    if (!declared.has(node.id)) lines.push(declarationFor(node));
  }

  return joinFrontMatter(withLinks(withPinned(withLegend(frontMatter, model), model), model), `${lines.join('\n')}\n`);
}
