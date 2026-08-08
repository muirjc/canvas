import { createEmptyDiagramModel, type DiagramModel, type DiagramNode, type EntityAttribute, type NodeStyle } from '../model/diagram-model.js';
import { splitFrontMatter, joinFrontMatter, type CanvasFrontMatter } from './front-matter.js';
import type { FlowchartDirection } from '../model/diagram-model.js';
import type { ParseError, ParseResult } from './types.js';

const ID = String.raw`[A-Za-z0-9_-]+`;
// CUSTOMER ||--o{ ORDER : places
const RELATIONSHIP_PATTERN = new RegExp(`^(${ID})\\s+([|o}{.-]+)\\s+(${ID})\\s*:\\s*(.+)$`);
const DEFAULT_CARDINALITY = '||--o{';
// CUSTOMER {
const ENTITY_BLOCK_START = new RegExp(`^(${ID})\\s*\\{$`);
const BLOCK_END = /^\}$/;
// string id PK, UK "comment"
const ATTRIBUTE_LINE = /^(\S+)\s+(\S+)(?:\s+([^"]*?))?\s*(?:"([^"]*)")?$/;
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
const DIRECTION_PATTERN = /^direction\s+(TB|BT|LR|RL)$/i;
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

let autoPositionCounter = 0;
function nextPosition(): { x: number; y: number } {
  const position = { x: (autoPositionCounter % 4) * 200 + 40, y: Math.floor(autoPositionCounter / 4) * 140 + 40 };
  autoPositionCounter += 1;
  return position;
}

/**
 * Parses Mermaid `erDiagram` (entity-relationship). Any cardinality notation (`||--o{`, `||--||`,
 * etc.) parses correctly, but — like sequence.ts's arrow style — DiagramEdge has no cardinality
 * field, so serialization always emits the common one-to-many token (`||--o{`). A disclosed
 * scope limitation: import preserves the *entities and relationship labels* exactly; the exact
 * cardinality symbol is not modeled and is normalized on export.
 */
export function parseErd(dsl: string): ParseResult {
  autoPositionCounter = 0;
  const { frontMatter, body } = splitFrontMatter(dsl);
  const positions = frontMatter.canvas?.positions ?? {};
  const styles = frontMatter.canvas?.styles ?? {};

  const lines = body.split(/\r?\n/);
  const errors: ParseError[] = [];
  const nodesById = new Map<string, DiagramNode>();
  const edges: { id: string; sourceId: string; targetId: string; label?: string }[] = [];
  let headerSeen = false;
  let edgeCounter = 0;
  let openEntity: { id: string; line: number; content: string } | null = null;
  let direction: FlowchartDirection | undefined;

  // jmuir-dtu.6: style/classDef/class(+shorthand) are applied as a second pass once every entity
  // is known — mirrors flowchart-parser.ts's own style/classDef second-pass convention exactly,
  // so a class assignment referencing an entity or classDef declared later in the file still
  // resolves, and an explicit `style` line overrides a class-applied property on the same entity.
  const classDefs = new Map<string, NodeStyle>();
  const classAssignments: { entityIds: string[]; className: string }[] = [];
  const styleDirectives: { entityId: string; propsRaw: string }[] = [];

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
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('%%')) continue;

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
        const [, type, name, constraintsRaw] = attrMatch;
        const keys = (constraintsRaw ?? '')
          .split(',')
          .map((k) => k.trim().toUpperCase())
          .filter((k) => RECOGNIZED_KEYS.has(k));
        pushAttribute(openEntity.id, { type, name, keys });
        continue;
      }
      errors.push({ line: i + 1, content: rawLine, message: `Could not interpret line as an entity attribute: "${line}"` });
      continue;
    }

    const directionMatch = line.match(DIRECTION_PATTERN);
    if (directionMatch) {
      direction = directionMatch[1].toUpperCase() as FlowchartDirection;
      continue;
    }

    const aliasBlockStart = line.match(ALIAS_BLOCK_START);
    if (aliasBlockStart) {
      const [, id, alias] = aliasBlockStart;
      ensureEntity(id, alias);
      openEntity = { id, line: i + 1, content: rawLine };
      continue;
    }

    const blockStart = line.match(ENTITY_BLOCK_START);
    if (blockStart) {
      const [, id] = blockStart;
      ensureEntity(id);
      openEntity = { id, line: i + 1, content: rawLine };
      continue;
    }

    const classShorthand = line.match(CLASS_SHORTHAND);
    if (classShorthand) {
      const [, id, alias, classNames] = classShorthand;
      ensureEntity(id, alias);
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
      const [, source, , target, label] = relMatch;
      ensureEntity(source);
      ensureEntity(target);
      edgeCounter += 1;
      edges.push({ id: `e${edgeCounter}`, sourceId: source, targetId: target, label });
      continue;
    }

    const aliasOnly = line.match(ALIAS_PATTERN);
    if (aliasOnly) {
      const [, id, alias] = aliasOnly;
      ensureEntity(id, alias);
      continue;
    }

    const bareEntity = line.match(BARE_ENTITY);
    if (bareEntity) {
      ensureEntity(bareEntity[1]);
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

  if (errors.length > 0) return { errors };

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
  model.direction = direction;
  return { model };
}

export function serializeErd(model: DiagramModel): string {
  const frontMatter: CanvasFrontMatter = {
    canvas: {
      positions: Object.fromEntries(model.nodes.map((n) => [n.id, n.position])),
      styles: Object.fromEntries(model.nodes.filter((n) => n.style).map((n) => [n.id, n.style!])),
    },
  };

  const lines: string[] = ['erDiagram'];
  if (model.direction) lines.push(`direction ${model.direction}`);

  const declared = new Set<string>();
  const declarationFor = (node: DiagramNode): string => (node.label !== node.id ? `${node.id}[${node.label}]` : node.id);

  for (const node of model.nodes) {
    if (node.attributes && node.attributes.length > 0) {
      lines.push(`${declarationFor(node)} {`);
      for (const attribute of node.attributes) {
        const keysPart = attribute.keys.length > 0 ? ` ${attribute.keys.join(', ')}` : '';
        lines.push(`  ${attribute.type} ${attribute.name}${keysPart}`);
      }
      lines.push('}');
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
    lines.push(`${edge.sourceId} ${DEFAULT_CARDINALITY} ${edge.targetId} : ${edge.label ?? ''}`);
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

  return joinFrontMatter(frontMatter, `${lines.join('\n')}\n`);
}
