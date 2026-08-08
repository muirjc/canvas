import { createEmptyDiagramModel, type ClassMember, type DiagramContainer, type DiagramModel, type DiagramNode, type NodeStyle } from '../model/diagram-model.js';
import { splitFrontMatter, joinFrontMatter, type CanvasFrontMatter } from './front-matter.js';
import type { FlowchartDirection } from '../model/diagram-model.js';
import type { ParseError, ParseResult } from './types.js';

const ID = String.raw`[A-Za-z0-9_]+`;

// jmuir-dtu.2: a class declaration may carry an inline <<Stereotype>> annotation and/or open a
// member body — both optional and independent, so one pattern per trailing shape rather than
// trying to cram every combination into one regex. Order doesn't actually matter for correctness
// (each is anchored to its own distinct trailing shape, `$` vs `\{$`), but BLOCK_START is checked
// first by convention, matching this codebase's usual style.
const CLASS_BLOCK_START = new RegExp(`^class\\s+(${ID})(?:\\s+<<(\\w+)>>)?\\s*\\{$`);
const CLASS_DECL = new RegExp(`^class\\s+(${ID})(?:\\s+<<(\\w+)>>)?$`);
// <<Interface>> Duck -- the "separate line" annotation form (Mermaid's own docs example),
// referencing the class by name rather than relying on body/decl-line adjacency. Order-
// independent here like every other alias/annotation resolution in this codebase: it doesn't
// matter whether the class was already declared elsewhere in the file.
const STANDALONE_ANNOTATION = new RegExp(`^<<(\\w+)>>\\s+(${ID})$`);
// <<Interface>> alone, as its own line INSIDE a class body -- the third documented placement
// ("nested: within braces alongside class definition").
const BODY_ANNOTATION = /^<<(\w+)>>$/;
const BLOCK_END = /^\}$/;

// jmuir-dtu.2: the full relationship-token set (was just 5, always serialized as inheritance
// regardless of which was parsed -- a real, disclosed gap this closes). Optional quoted
// cardinality/multiplicity labels flank the token on either side. Longer/more-specific tokens are
// listed before the shorter tokens they textually overlap with (`..` is a literal prefix of both
// `..>` and `..|>`; `--` is a literal prefix of `-->`) purely for clarity/convention -- JS regex
// alternation backtracks across the whole pattern, so correctness doesn't actually depend on the
// order here, only readability does.
const REL_TOKEN = String.raw`\.\.\|>|<\|--|\*--|o--|-->|\.\.>|--|\.\.`;
const RELATIONSHIP = new RegExp(
  `^(${ID})\\s*(?:"([^"]*)"\\s*)?(${REL_TOKEN})\\s*(?:"([^"]*)"\\s*)?(${ID})(?:\\s*:\\s*(.+))?$`,
);
const REL_TOKEN_TO_KIND: Record<string, NonNullable<import('../model/diagram-model.js').DiagramEdge['umlRelationKind']>> = {
  '..|>': 'realization',
  '<|--': 'inheritance',
  '*--': 'composition',
  'o--': 'aggregation',
  '-->': 'association',
  '..>': 'dependency',
  '--': 'link-solid',
  '..': 'link-dashed',
};
const REL_KIND_TO_TOKEN: Record<string, string> = Object.fromEntries(
  Object.entries(REL_TOKEN_TO_KIND).map(([token, kind]) => [kind, token]),
);

// jmuir-dtu.2: notes -- a standalone `note "text"` (no attached class) or a class-attached
// `note for ClassName "text"`.
const NOTE_FOR = new RegExp(`^note\\s+for\\s+(${ID})\\s+"([^"]*)"$`);
const NOTE_STANDALONE = /^note\s+"([^"]*)"$/;

// jmuir-dtu.2: `namespace Name { class A class B }` groups classes -- member classes reference it
// via their own containerId, exactly like box/C4-boundary membership elsewhere in this codebase,
// not via attachedNodeIds. Dot-notation (`namespace A.B.C`, auto-creating parent namespaces) and
// the v11.15+ bracketed display-label form (`namespace Name["Label"]`) are deliberately not
// supported -- see this bead's own follow-up notes for the scope decision.
const NAMESPACE_START = new RegExp(`^namespace\\s+(${ID})\\s*\\{$`);

const DIRECTION_PATTERN = /^direction\s+(TB|BT|LR|RL)$/i;

// jmuir-dtu.2: style/classDef/class/::: -- identical grammar and second-pass-application
// precedent to flowchart-parser.ts's own support (and ERD's own copy of it). UML's own `class`
// keyword is ALSO the node-declaration keyword ("class Foo"), unlike flowchart/ERD where it's
// exclusively a style-assignment directive -- disambiguated purely by shape: a bare "class <id>"
// (optionally with a trailing `<<Annotation>>` or `{`) is a declaration, handled by CLASS_DECL/
// CLASS_BLOCK_START above; CLASS_ASSIGN_DIRECTIVE below only matches when there's MORE than that
// single identifier (a comma-list and/or a trailing style name), which the single-identifier
// patterns' own `$` anchor already excludes -- so checking the more specific declaration patterns
// first (already done, see the parse loop below) resolves the ambiguity with no extra logic.
const STYLE_DIRECTIVE = new RegExp(`^style\\s+(${ID})\\s+(.+)$`);
const CLASSDEF_DIRECTIVE = new RegExp(`^classDef\\s+(${ID})\\s+(.+?);?$`);
const CLASS_ASSIGN_DIRECTIVE = new RegExp(`^class\\s+((?:${ID})(?:\\s*,\\s*${ID})*)\\s+(${ID})\\s*;?$`);
const CLASS_SHORTHAND = new RegExp(`^(${ID}):::(${ID}(?:\\s*,\\s*${ID})*)$`);

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

/** Splits a member-declaration's trailing text into its core content and any `$`(static)/
 *  `*`(abstract) modifier suffix -- the modifier, if present, is always the very last character,
 *  directly adjacent with no space (`String field$`, `someMethod()*`). */
function splitMemberModifier(text: string): { core: string; isStatic: boolean; isAbstract: boolean } {
  const trimmed = text.trim();
  if (trimmed.endsWith('$')) return { core: trimmed.slice(0, -1).trim(), isStatic: true, isAbstract: false };
  if (trimmed.endsWith('*')) return { core: trimmed.slice(0, -1).trim(), isStatic: false, isAbstract: true };
  return { core: trimmed, isStatic: false, isAbstract: false };
}

/** Parses one line from inside a `class Foo { ... }` body into a ClassMember. Returns null for a
 *  blank/unparseable line (caller reports the structured error). */
function parseMemberLine(rawLine: string): ClassMember | null {
  let remainder = rawLine.trim();
  if (!remainder) return null;

  let visibility: ClassMember['visibility'];
  if (/^[+\-#~]/.test(remainder)) {
    visibility = remainder[0] as ClassMember['visibility'];
    remainder = remainder.slice(1).trim();
  }
  if (!remainder) return null;

  const parenIndex = remainder.indexOf('(');
  if (parenIndex !== -1) {
    const closeIndex = remainder.indexOf(')', parenIndex);
    if (closeIndex === -1) return null;
    const name = remainder.slice(0, parenIndex).trim();
    const params = remainder.slice(parenIndex + 1, closeIndex).trim();
    if (!name) return null;
    const { core: returnTypeRaw, isStatic, isAbstract } = splitMemberModifier(remainder.slice(closeIndex + 1));
    return {
      kind: 'method',
      visibility,
      name,
      params,
      returnType: returnTypeRaw || undefined,
      isStatic: isStatic || undefined,
      isAbstract: isAbstract || undefined,
    };
  }

  // Attribute: "type name" (two or more whitespace-separated tokens, name is the last one) or a
  // bare "name" (one token) -- either way, an optional $/* modifier suffix on the very last token.
  const { core, isStatic, isAbstract } = splitMemberModifier(remainder);
  const parts = core.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) {
    return { kind: 'attribute', visibility, name: parts[0], isStatic: isStatic || undefined, isAbstract: isAbstract || undefined };
  }
  const name = parts[parts.length - 1];
  const type = parts.slice(0, -1).join(' ');
  return { kind: 'attribute', visibility, name, type, isStatic: isStatic || undefined, isAbstract: isAbstract || undefined };
}

/** Reconstructs one member's declaration line for serialization -- the inverse of
 *  parseMemberLine, modulo whitespace normalization (not a byte-exact round-trip of the original
 *  spacing, same "canonical form" convention used throughout this codebase). */
function serializeMemberLine(member: ClassMember): string {
  const visibility = member.visibility ?? '';
  const modifier = member.isStatic ? '$' : member.isAbstract ? '*' : '';
  if (member.kind === 'method') {
    const returnPart = member.returnType ? ` ${member.returnType}` : '';
    return `  ${visibility}${member.name}(${member.params ?? ''})${returnPart}${modifier}`;
  }
  const typePart = member.type ? `${member.type} ` : '';
  return `  ${visibility}${typePart}${member.name}${modifier}`;
}

let autoPositionCounter = 0;
function nextPosition(): { x: number; y: number } {
  const position = { x: (autoPositionCounter % 4) * 180 + 40, y: Math.floor(autoPositionCounter / 4) * 140 + 40 };
  autoPositionCounter += 1;
  return position;
}

/**
 * Parses Mermaid `classDiagram`. jmuir-dtu.2 closes the previously-disclosed "class bodies are
 * recognized but their contents skipped entirely" limitation: members (attributes/methods, with
 * visibility/generics/static/abstract), the full relationship-token set with cardinality,
 * <<Stereotype>> annotations (all three placement forms), namespaces, notes, style/classDef/
 * class/:::, and direction are all now modeled.
 */
export function parseUml(dsl: string): ParseResult {
  autoPositionCounter = 0;
  const { frontMatter, body } = splitFrontMatter(dsl);
  const positions = frontMatter.canvas?.positions ?? {};
  const styles = frontMatter.canvas?.styles ?? {};
  const containerMeta = frontMatter.canvas?.containers ?? {};

  const lines = body.split(/\r?\n/);
  const errors: ParseError[] = [];
  const nodesById = new Map<string, DiagramNode>();
  const containersById = new Map<string, DiagramContainer>();
  const edges: {
    id: string;
    sourceId: string;
    targetId: string;
    label?: string;
    umlRelationKind?: NonNullable<import('../model/diagram-model.js').DiagramEdge['umlRelationKind']>;
    sourceCardinality?: string;
    targetCardinality?: string;
  }[] = [];
  let headerSeen = false;
  let insideClassBody: { id: string; line: number; content: string } | null = null;
  let edgeCounter = 0;
  let containerCounter = 0;
  let direction: FlowchartDirection | undefined;

  const namespaceStack: { id: string; line: number; content: string }[] = [];
  const currentNamespaceId = (): string | undefined => namespaceStack[namespaceStack.length - 1]?.id;

  const classDefs = new Map<string, NodeStyle>();
  const classAssignments: { classIds: string[]; className: string }[] = [];
  const styleDirectives: { classId: string; propsRaw: string }[] = [];

  const ensureClass = (id: string, annotation?: string, containerId?: string) => {
    const existing = nodesById.get(id);
    if (!existing) {
      nodesById.set(id, {
        id,
        label: id,
        shape: 'rectangle',
        role: 'class',
        position: positions[id] ?? nextPosition(),
        style: styles[id],
        containerId,
        umlStereotype: annotation,
      });
      return;
    }
    if (annotation !== undefined) existing.umlStereotype = annotation;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('%%')) continue;

    if (!headerSeen) {
      if (line === 'classDiagram') {
        headerSeen = true;
        continue;
      }
      errors.push({ line: i + 1, content: rawLine, message: 'Expected "classDiagram" header line' });
      continue;
    }

    if (insideClassBody) {
      if (BLOCK_END.test(line)) {
        insideClassBody = null;
        continue;
      }
      const bodyAnnotation = line.match(BODY_ANNOTATION);
      if (bodyAnnotation) {
        nodesById.get(insideClassBody.id)!.umlStereotype = bodyAnnotation[1];
        continue;
      }
      const member = parseMemberLine(line);
      if (!member) {
        errors.push({ line: i + 1, content: rawLine, message: `Could not interpret line as a class member: "${line}"` });
        continue;
      }
      const node = nodesById.get(insideClassBody.id)!;
      node.members = node.members ? [...node.members, member] : [member];
      continue;
    }

    const directionMatch = line.match(DIRECTION_PATTERN);
    if (directionMatch) {
      direction = directionMatch[1].toUpperCase() as FlowchartDirection;
      continue;
    }

    const namespaceStart = line.match(NAMESPACE_START);
    if (namespaceStart) {
      const [, name] = namespaceStart;
      // Uses the namespace's own given name as its container id (like C4 boundaries/ERD entities
      // use their DSL-authored id) rather than a counter -- stable across re-saves, unlike a
      // counter-based id that shifts if a namespace/note is added or removed elsewhere in the
      // file. Two same-named namespaces nested under different parents would collide (a real but
      // rare edge case, not worth a synthetic disambiguating suffix for this pass).
      const meta = containerMeta[name];
      containersById.set(name, {
        id: name,
        label: name,
        role: 'namespace',
        position: meta ? { x: meta.x, y: meta.y } : nextPosition(),
        parentContainerId: currentNamespaceId(),
      });
      namespaceStack.push({ id: name, line: i + 1, content: rawLine });
      continue;
    }
    if (namespaceStack.length > 0 && BLOCK_END.test(line)) {
      namespaceStack.pop();
      continue;
    }

    const noteFor = line.match(NOTE_FOR);
    if (noteFor) {
      const [, classId, text] = noteFor;
      ensureClass(classId, undefined, currentNamespaceId());
      containerCounter += 1;
      const id = `note${containerCounter}`;
      // Notes have no author-given identifier in Mermaid's own grammar at all (unlike
      // namespaces above), so a counter-based id -- and the same best-effort-only containerMeta
      // position lookup every other counter-id'd container in this codebase already has -- is
      // the best available option; position can still drift if notes are added/removed/reordered
      // elsewhere in the file between saves, same inherent limitation sequence.ts's own
      // note/block containers already carry.
      const meta = containerMeta[id];
      containersById.set(id, { id, label: text, role: 'note', attachedNodeIds: [classId], position: meta ? { x: meta.x, y: meta.y } : nextPosition() });
      continue;
    }
    const noteStandalone = line.match(NOTE_STANDALONE);
    if (noteStandalone) {
      containerCounter += 1;
      const id = `note${containerCounter}`;
      const meta = containerMeta[id];
      containersById.set(id, { id, label: noteStandalone[1], role: 'note', attachedNodeIds: [], position: meta ? { x: meta.x, y: meta.y } : nextPosition() });
      continue;
    }

    const standaloneAnnotation = line.match(STANDALONE_ANNOTATION);
    if (standaloneAnnotation) {
      const [, annotation, id] = standaloneAnnotation;
      ensureClass(id, annotation, currentNamespaceId());
      continue;
    }

    const blockStart = line.match(CLASS_BLOCK_START);
    if (blockStart) {
      const [, id, annotation] = blockStart;
      ensureClass(id, annotation, currentNamespaceId());
      insideClassBody = { id, line: i + 1, content: rawLine };
      continue;
    }

    const decl = line.match(CLASS_DECL);
    if (decl) {
      const [, id, annotation] = decl;
      ensureClass(id, annotation, currentNamespaceId());
      continue;
    }

    const styleMatch = line.match(STYLE_DIRECTIVE);
    if (styleMatch) {
      const [, classId, propsRaw] = styleMatch;
      styleDirectives.push({ classId, propsRaw });
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
      classAssignments.push({ classIds: idList.split(',').map((id) => id.trim()), className });
      continue;
    }

    const shorthandMatch = line.match(CLASS_SHORTHAND);
    if (shorthandMatch) {
      const [, id, classNames] = shorthandMatch;
      ensureClass(id, undefined, currentNamespaceId());
      classAssignments.push({ classIds: [id], className: classNames.split(',')[0].trim() });
      continue;
    }

    const rel = line.match(RELATIONSHIP);
    if (rel) {
      const [, source, sourceCard, token, targetCard, target, label] = rel;
      ensureClass(source, undefined, currentNamespaceId());
      ensureClass(target, undefined, currentNamespaceId());
      edgeCounter += 1;
      edges.push({
        id: `e${edgeCounter}`,
        sourceId: source,
        targetId: target,
        label,
        umlRelationKind: REL_TOKEN_TO_KIND[token],
        sourceCardinality: sourceCard,
        targetCardinality: targetCard,
      });
      continue;
    }

    errors.push({ line: i + 1, content: rawLine, message: `Could not interpret line as a class, relationship, or directive: "${line}"` });
  }

  if (insideClassBody) {
    errors.push({
      line: insideClassBody.line,
      content: insideClassBody.content,
      message: `Unclosed class body for '${insideClassBody.id}' opened at line ${insideClassBody.line}`,
    });
  }
  for (const open of namespaceStack) {
    errors.push({ line: open.line, content: open.content, message: `Unclosed 'namespace' block opened at line ${open.line}` });
  }

  if (errors.length > 0) return { errors };

  // Second pass, mirroring flowchart/ERD's own style/classDef/class convention exactly: class
  // assignments before explicit style directives (so an explicit `style` line overrides a
  // class-applied property on the same node), unknown ids/classDefs silently skipped.
  for (const { classIds, className } of classAssignments) {
    const classStyle = classDefs.get(className);
    if (!classStyle) continue;
    for (const classId of classIds) {
      const node = nodesById.get(classId);
      if (!node) continue;
      node.style = { ...node.style, ...classStyle };
    }
  }
  for (const { classId, propsRaw } of styleDirectives) {
    const node = nodesById.get(classId);
    if (!node) continue;
    node.style = { ...node.style, ...parseStyleProps(propsRaw) };
  }

  const model = createEmptyDiagramModel('uml');
  model.nodes = Array.from(nodesById.values());
  model.edges = edges;
  model.containers = Array.from(containersById.values());
  model.direction = direction;
  return { model };
}

export function serializeUml(model: DiagramModel): string {
  const frontMatter: CanvasFrontMatter = {
    canvas: {
      positions: Object.fromEntries(model.nodes.map((n) => [n.id, n.position])),
      styles: Object.fromEntries(model.nodes.filter((n) => n.style).map((n) => [n.id, n.style!])),
      // Namespace/note container positions round-trip via front-matter, mirroring C4's own
      // `containers` block -- see the parser's own comments on namespace ids being stable
      // (author-given name) vs note ids being counter-based (best-effort only).
      containers: Object.fromEntries(model.containers.map((c) => [c.id, { x: c.position.x, y: c.position.y }])),
    },
  };

  const lines: string[] = ['classDiagram'];
  if (model.direction) lines.push(`direction ${model.direction}`);

  const classLines = (node: DiagramNode): string[] => {
    const annotationPart = node.umlStereotype ? ` <<${node.umlStereotype}>>` : '';
    if (!node.members || node.members.length === 0) {
      return [`class ${node.id}${annotationPart}`];
    }
    const out = [`class ${node.id}${annotationPart} {`];
    out.push(...node.members.map(serializeMemberLine));
    out.push('}');
    return out;
  };

  const namespaces = model.containers.filter((c) => c.role === 'namespace' && !c.parentContainerId);
  const emitNamespace = (container: DiagramContainer): string[] => {
    const out = [`namespace ${container.label} {`];
    for (const node of model.nodes) {
      if (node.containerId === container.id) out.push(...classLines(node).map((l) => `  ${l}`));
    }
    for (const child of model.containers) {
      if (child.role === 'namespace' && child.parentContainerId === container.id) {
        out.push(...emitNamespace(child).map((l) => `  ${l}`));
      }
    }
    out.push('}');
    return out;
  };

  const namespacedNodeIds = new Set(
    model.containers.filter((c) => c.role === 'namespace').flatMap((ns) => model.nodes.filter((n) => n.containerId === ns.id).map((n) => n.id)),
  );
  for (const namespace of namespaces) {
    lines.push(...emitNamespace(namespace));
  }
  for (const node of model.nodes) {
    if (namespacedNodeIds.has(node.id)) continue;
    lines.push(...classLines(node));
  }
  for (const edge of model.edges) {
    const token = (edge.umlRelationKind && REL_KIND_TO_TOKEN[edge.umlRelationKind]) || REL_KIND_TO_TOKEN.association;
    const sourcePart = edge.sourceCardinality ? `${edge.sourceId} "${edge.sourceCardinality}"` : edge.sourceId;
    const targetPart = edge.targetCardinality ? `"${edge.targetCardinality}" ${edge.targetId}` : edge.targetId;
    const labelPart = edge.label ? ` : ${edge.label}` : '';
    lines.push(`${sourcePart} ${token} ${targetPart}${labelPart}`);
  }
  for (const container of model.containers) {
    if (container.role !== 'note') continue;
    if (container.attachedNodeIds && container.attachedNodeIds.length > 0) {
      lines.push(`note for ${container.attachedNodeIds[0]} "${container.label}"`);
    } else {
      lines.push(`note "${container.label}"`);
    }
  }

  return joinFrontMatter(frontMatter, `${lines.join('\n')}\n`);
}
