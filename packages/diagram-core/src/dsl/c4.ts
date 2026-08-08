import { createEmptyDiagramModel, type DiagramContainer, type DiagramNode, type NodeStyle } from '../model/diagram-model.js';
import { splitFrontMatter, joinFrontMatter, type CanvasFrontMatter } from './front-matter.js';
import type { ParseError, ParseResult } from './types.js';

const ID = String.raw`[A-Za-z0-9_]+`;

const HEADER_TO_LEVEL: Record<string, string> = {
  C4Context: 'c4-context',
  C4Container: 'c4-container',
  C4Component: 'c4-component',
  C4Dynamic: 'c4-code',
  C4Deployment: 'c4-deployment',
};
const LEVEL_TO_HEADER: Record<string, string> = Object.fromEntries(
  Object.entries(HEADER_TO_LEVEL).map(([header, level]) => [level, header]),
);

// jmuir-dtu.3: the full Db/Queue/_Ext element-kind matrix (System/Container/Component each cross
// Db and Queue, plus every kind's own _Ext "external" variant) — was previously just
// Person/Person_Ext/System/System_Ext/SystemDb/Container/Container_Ext/Component/Component_Ext,
// silently rejecting any real C4 diagram using e.g. ContainerQueue or SystemDb_Ext. _Ext variants
// collapse to the same role+shape as their base kind (no separate "external" visual marker) —
// matches the pre-existing Person_Ext/System_Ext/Container_Ext/Component_Ext simplification
// exactly, not a new gap.
const ELEMENT_KINDS = [
  'Person',
  'Person_Ext',
  'System',
  'System_Ext',
  'SystemDb',
  'SystemDb_Ext',
  'SystemQueue',
  'SystemQueue_Ext',
  'Container',
  'Container_Ext',
  'ContainerDb',
  'ContainerDb_Ext',
  'ContainerQueue',
  'ContainerQueue_Ext',
  'Component',
  'Component_Ext',
  'ComponentDb',
  'ComponentDb_Ext',
  'ComponentQueue',
  'ComponentQueue_Ext',
] as const;

// Person(alias, "label", "description") / Person_Ext(...) — description is optional.
const ELEMENT_PATTERN = new RegExp(
  `^(${ELEMENT_KINDS.join('|')})\\(\\s*(${ID})\\s*,\\s*"([^"]*)"(?:\\s*,\\s*"([^"]*)")?\\s*\\)$`,
);
// Rel(from, to, "label") and its BiRel/Rel_Back/directional variants (jmuir-dtu.3) — the
// Up/Down/Left/Right long forms and their U/D/L/R short forms are both real Mermaid syntax.
const REL_KINDS = ['Rel', 'BiRel', 'Rel_Back', 'Rel_U', 'Rel_D', 'Rel_L', 'Rel_R', 'Rel_Up', 'Rel_Down', 'Rel_Left', 'Rel_Right'] as const;
const REL_PATTERN = new RegExp(
  `^(${REL_KINDS.join('|')})\\(\\s*(${ID})\\s*,\\s*(${ID})\\s*,\\s*"([^"]*)"\\s*\\)$`,
);
// jmuir-dtu.3.2: Deployment_Node (and its Node/Node_L/Node_R shortcuts -- Node is documented as
// simply "short name of Deployment_Node()", Node_L/Node_R the same with a left/right layout
// alignment hint) are grammatically the exact same nestable-boundary construct as System_Boundary/
// Container_Boundary/Enterprise_Boundary (confirmed against Mermaid's own c4Diagram.jison grammar:
// all six keywords feed the same boundaryStartStatement production) -- a C4Deployment diagram's
// infrastructure tree (e.g. "Live" -> "Web Server" -> a Container running on it) is expressed as
// nested Deployment_Node blocks exactly like a nested System_Boundary. The alignment hint
// (Node_L vs Node_R) has no equivalent in this app's rendering (positions come from
// canvas.positions front-matter, not a left/right layout algorithm) -- accepted, not modeled, same
// treatment as C4's other pure layout hints (Rel_U/D/L/R, UpdateLayoutConfig).
const DEPLOYMENT_NODE_KINDS = ['Deployment_Node', 'Node_L', 'Node_R', 'Node'] as const;
const BOUNDARY_START = new RegExp(
  `^(System_Boundary|Container_Boundary|Enterprise_Boundary|${DEPLOYMENT_NODE_KINDS.join('|')})\\(\\s*(${ID})\\s*,\\s*"([^"]*)"(?:\\s*,\\s*"[^"]*")?\\s*\\)\\s*\\{$`,
);
const BOUNDARY_END = /^\}$/;

// jmuir-dtu.3: styling macros. Both of Mermaid's documented argument forms are accepted --
// positional (`UpdateRelStyle(a, b, "red", "blue", "-40", "60")`) and named
// (`$lineColor="blue"`) — resolved by resolveMacroArgs below. Only properties with a real
// NodeStyle equivalent are applied (bgColor/borderColor, lineColor); textColor/offsetX/offsetY/
// shadowing/shape/sprite/techn/legend* have no modeled equivalent and are silently ignored,
// matching flowchart's own style/classDef "other properties silently ignored" precedent.
const UPDATE_ELEMENT_STYLE = new RegExp(`^UpdateElementStyle\\(\\s*(${ID})\\s*,\\s*(.+)\\)$`);
const UPDATE_REL_STYLE = new RegExp(`^UpdateRelStyle\\(\\s*(${ID})\\s*,\\s*(${ID})\\s*,\\s*(.+)\\)$`);
// UpdateLayoutConfig is a pure layout hint (shapes/boundaries per row) with no rendering
// equivalent in this app (no row-wrapping layout engine for C4) -- accepted so a real file using
// it doesn't hard-error, but deliberately not modeled or round-tripped, same treatment as the
// Rel_U/D/L/R directional hints below.
const UPDATE_LAYOUT_CONFIG = /^UpdateLayoutConfig\(.*\)$/;

const ELEMENT_TO_ROLE: Record<string, string> = {
  Person: 'person',
  Person_Ext: 'person',
  System: 'system',
  System_Ext: 'system',
  SystemDb: 'system',
  SystemDb_Ext: 'system',
  SystemQueue: 'system',
  SystemQueue_Ext: 'system',
  Container: 'container',
  Container_Ext: 'container',
  ContainerDb: 'container',
  ContainerDb_Ext: 'container',
  ContainerQueue: 'container',
  ContainerQueue_Ext: 'container',
  Component: 'component',
  Component_Ext: 'component',
  ComponentDb: 'component',
  ComponentDb_Ext: 'component',
  ComponentQueue: 'component',
  ComponentQueue_Ext: 'component',
};
// Db variants reuse the existing 'cylinder' shape (already established for SystemDb); Queue
// variants use 'stadium' (pill shape) as the closest existing visual analog to Mermaid's own
// queue rendering — deliberately not a new NodeShape value, reusing what flowchart-family
// diagrams already added (009-flowchart-node-shapes) rather than growing the shared enum further.
const ELEMENT_TO_SHAPE: Record<string, DiagramNode['shape']> = {
  Person: 'person',
  Person_Ext: 'person',
  System: 'rectangle',
  System_Ext: 'rectangle',
  SystemDb: 'cylinder',
  SystemDb_Ext: 'cylinder',
  SystemQueue: 'stadium',
  SystemQueue_Ext: 'stadium',
  Container: 'rounded-rectangle',
  Container_Ext: 'rounded-rectangle',
  ContainerDb: 'cylinder',
  ContainerDb_Ext: 'cylinder',
  ContainerQueue: 'stadium',
  ContainerQueue_Ext: 'stadium',
  Component: 'rounded-rectangle',
  Component_Ext: 'rounded-rectangle',
  ComponentDb: 'cylinder',
  ComponentDb_Ext: 'cylinder',
  ComponentQueue: 'stadium',
  ComponentQueue_Ext: 'stadium',
};

/** Splits a macro's remaining argument list on top-level commas, respecting quoted strings so a
 *  comma inside a quoted value isn't split (jmuir-dtu.3's UpdateElementStyle/UpdateRelStyle). */
function splitMacroArgs(argsRaw: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of argsRaw) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ',' && !inQuotes) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

const NAMED_MACRO_ARG = /^\$(\w+)\s*=\s*"([^"]*)"$/;
const POSITIONAL_MACRO_ARG = /^"([^"]*)"$/;

/** Resolves a styling macro's remaining args to a name->value map. Mermaid accepts both a
 *  positional form (resolved via `positionalNames`, in order) and a named `$key="value"` form —
 *  see UpdateRelStyle's own two documented forms. Unrecognized args are silently ignored. */
function resolveMacroArgs(argsRaw: string, positionalNames: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  splitMacroArgs(argsRaw).forEach((part, index) => {
    const named = part.match(NAMED_MACRO_ARG);
    if (named) {
      result[named[1]] = named[2];
      return;
    }
    const positional = part.match(POSITIONAL_MACRO_ARG);
    if (positional && positionalNames[index]) {
      result[positionalNames[index]] = positional[1];
    }
  });
  return result;
}

let autoPositionCounter = 0;
function nextAutoPosition(): { x: number; y: number } {
  const position = { x: (autoPositionCounter % 5) * 200 + 40, y: Math.floor(autoPositionCounter / 5) * 140 + 40 };
  autoPositionCounter += 1;
  return position;
}

/**
 * Parses Mermaid C4 diagrams (C4Context/C4Container/C4Component/C4Dynamic) into a DiagramModel.
 * Person/System/Container/Component map to DiagramNode.role for Standards validation (e.g. "a
 * C4 Context diagram enforces the standard C4 person/system shapes").
 */
export function parseC4(dsl: string): ParseResult {
  autoPositionCounter = 0;
  const { frontMatter, body } = splitFrontMatter(dsl);
  const positions = frontMatter.canvas?.positions ?? {};
  const styles = frontMatter.canvas?.styles ?? {};
  const edgeStyles = frontMatter.canvas?.edgeStyles ?? {};
  const containerMeta = frontMatter.canvas?.containers ?? {};

  const lines = body.split(/\r?\n/);
  const errors: ParseError[] = [];
  const nodesById = new Map<string, DiagramNode>();
  const containersById = new Map<string, DiagramContainer>();
  const edges: { id: string; sourceId: string; targetId: string; label?: string; arrow?: 'both'; style?: NodeStyle }[] = [];
  const containerStack: string[] = [];
  let level: string | null = null;
  let edgeCounter = 0;
  // jmuir-dtu.3: styling macros are applied as a second pass after every element/rel is parsed —
  // same reasoning and same "unknown id silently skipped" convention as flowchart's own
  // style/classDef directives (they may reference an element declared later in the file, and a
  // real Mermaid file conventionally puts Update* macros at the end anyway).
  const pendingElementStyles: { id: string; bgColor?: string; borderColor?: string }[] = [];
  const pendingRelStyles: { source: string; target: string; lineColor?: string }[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('%%')) continue;

    if (!level) {
      if (line in HEADER_TO_LEVEL) {
        level = HEADER_TO_LEVEL[line];
        continue;
      }
      errors.push({ line: i + 1, content: rawLine, message: 'Expected a C4 header (C4Context/C4Container/C4Component/C4Dynamic)' });
      continue;
    }

    const elementMatch = line.match(ELEMENT_PATTERN);
    if (elementMatch) {
      const [, kind, id, label] = elementMatch;
      nodesById.set(id, {
        id,
        label,
        shape: ELEMENT_TO_SHAPE[kind],
        role: ELEMENT_TO_ROLE[kind],
        position: positions[id] ?? nextAutoPosition(),
        style: styles[id],
        containerId: containerStack[containerStack.length - 1],
      });
      continue;
    }

    const relMatch = line.match(REL_PATTERN);
    if (relMatch) {
      const [, kind, from, to, label] = relMatch;
      edgeCounter += 1;
      // BiRel renders as a bidirectional edge (both endpoints arrowed) — same 'both' value
      // flowchart's own <--> already uses (canvas-7rr). Rel_Back is semantically Rel(to, from,
      // label) — swap the endpoints, same trick canvas-7rr's "Reversed" edge direction picker
      // uses, needing no special arrow value. Rel_U/D/L/R (and their Up/Down/Left/Right long
      // forms) are pure layout-position hints in real Mermaid (where the "to" element should sit
      // relative to "from") with no equivalent in this app's rendering — parsed successfully so a
      // real file using them doesn't hard-error, but otherwise treated as a plain Rel.
      const isBack = kind === 'Rel_Back';
      const edgeId = `e${edgeCounter}`;
      edges.push({
        id: edgeId,
        sourceId: isBack ? to : from,
        targetId: isBack ? from : to,
        label,
        arrow: kind === 'BiRel' ? 'both' : undefined,
        style: edgeStyles[edgeId],
      });
      continue;
    }

    const updateElementStyleMatch = line.match(UPDATE_ELEMENT_STYLE);
    if (updateElementStyleMatch) {
      const [, id, argsRaw] = updateElementStyleMatch;
      const args = resolveMacroArgs(argsRaw, ['bgColor', 'fontColor', 'borderColor']);
      pendingElementStyles.push({ id, bgColor: args.bgColor, borderColor: args.borderColor });
      continue;
    }

    const updateRelStyleMatch = line.match(UPDATE_REL_STYLE);
    if (updateRelStyleMatch) {
      const [, source, target, argsRaw] = updateRelStyleMatch;
      const args = resolveMacroArgs(argsRaw, ['textColor', 'lineColor', 'offsetX', 'offsetY']);
      pendingRelStyles.push({ source, target, lineColor: args.lineColor });
      continue;
    }

    if (UPDATE_LAYOUT_CONFIG.test(line)) {
      continue;
    }

    const boundaryStart = line.match(BOUNDARY_START);
    if (boundaryStart) {
      const [, , id, label] = boundaryStart;
      const meta = containerMeta[id];
      containersById.set(id, {
        id,
        label,
        position: meta ? { x: meta.x, y: meta.y } : nextAutoPosition(),
        size: meta?.width !== undefined && meta?.height !== undefined ? { width: meta.width, height: meta.height } : undefined,
        parentContainerId: containerStack[containerStack.length - 1],
      });
      containerStack.push(id);
      continue;
    }
    if (BOUNDARY_END.test(line)) {
      if (containerStack.length === 0) {
        errors.push({ line: i + 1, content: rawLine, message: '"}" with no matching boundary' });
      } else {
        containerStack.pop();
      }
      continue;
    }

    errors.push({ line: i + 1, content: rawLine, message: `Could not interpret line as a C4 element, relationship, or boundary: "${line}"` });
  }

  if (errors.length > 0) return { errors };

  // jmuir-dtu.3: apply styling macros now that every element/rel is known — an unrecognized id
  // is silently skipped, same convention as flowchart's own style/classDef second pass.
  for (const { id, bgColor, borderColor } of pendingElementStyles) {
    const node = nodesById.get(id);
    if (!node) continue;
    const style = { ...node.style };
    if (bgColor) style.fillColor = bgColor;
    if (borderColor) style.strokeColor = borderColor;
    node.style = style;
  }
  for (const { source, target, lineColor } of pendingRelStyles) {
    if (!lineColor) continue;
    for (const edge of edges) {
      if (edge.sourceId === source && edge.targetId === target) {
        edge.style = { ...edge.style, strokeColor: lineColor };
      }
    }
  }

  const model = createEmptyDiagramModel(level ?? 'c4-context');
  model.nodes = Array.from(nodesById.values());
  model.containers = Array.from(containersById.values());
  model.edges = edges;
  return { model };
}

function elementKindFor(node: DiagramNode): string {
  if (node.role === 'person') return 'Person';
  if (node.role === 'system') {
    if (node.shape === 'cylinder') return 'SystemDb';
    if (node.shape === 'stadium') return 'SystemQueue';
    return 'System';
  }
  if (node.role === 'container') {
    if (node.shape === 'cylinder') return 'ContainerDb';
    if (node.shape === 'stadium') return 'ContainerQueue';
    return 'Container';
  }
  if (node.role === 'component') {
    if (node.shape === 'cylinder') return 'ComponentDb';
    if (node.shape === 'stadium') return 'ComponentQueue';
    return 'Component';
  }
  return 'System';
}

export function serializeC4(model: import('../model/diagram-model.js').DiagramModel): string {
  const frontMatter: CanvasFrontMatter = {
    canvas: {
      positions: Object.fromEntries(model.nodes.map((n) => [n.id, n.position])),
      styles: Object.fromEntries(model.nodes.filter((n) => n.style).map((n) => [n.id, n.style!])),
      edgeStyles: Object.fromEntries(model.edges.filter((e) => e.style).map((e) => [e.id, e.style!])),
      containers: Object.fromEntries(
        model.containers.map((c) => [
          c.id,
          c.size
            ? { x: c.position.x, y: c.position.y, width: c.size.width, height: c.size.height }
            : { x: c.position.x, y: c.position.y },
        ]),
      ),
    },
  };

  const header = LEVEL_TO_HEADER[model.diagramTypeId] ?? 'C4Context';
  const lines: string[] = [header];
  const emitted = new Set<string>();
  // jmuir-dtu.3.2: a C4Deployment model's containers always re-emit as Deployment_Node (not
  // System_Boundary, which isn't semantically valid there) -- driven purely by diagramTypeId,
  // not a per-container flag, since every container in a c4-deployment model necessarily came
  // from Deployment_Node/Node/Node_L/Node_R parsing in the first place (BOUNDARY_START accepts
  // all six keywords regardless of header, same lenient precedent System_Boundary itself already
  // has, but only c4-deployment's own header re-emits this way).
  const boundaryKeyword = model.diagramTypeId === 'c4-deployment' ? 'Deployment_Node' : 'System_Boundary';

  const emitContainer = (container: DiagramContainer): string[] => {
    const out: string[] = [`${boundaryKeyword}(${container.id}, "${container.label}") {`];
    for (const node of model.nodes) {
      if (node.containerId === container.id) {
        out.push(`  ${elementKindFor(node)}(${node.id}, "${node.label}")`);
        emitted.add(node.id);
      }
    }
    for (const child of model.containers) {
      if (child.parentContainerId === container.id) out.push(...emitContainer(child));
    }
    out.push('}');
    return out;
  };

  for (const container of model.containers.filter((c) => !c.parentContainerId)) {
    lines.push(...emitContainer(container));
  }
  for (const node of model.nodes) {
    if (!emitted.has(node.id)) lines.push(`${elementKindFor(node)}(${node.id}, "${node.label}")`);
  }
  for (const edge of model.edges) {
    // Rel_Back/Rel_U/D/L/R aren't distinguishable after parse (Rel_Back is folded into a plain
    // swapped-endpoint edge, same as flowchart's "Reversed" picker; the directional hints carry
    // no model state at all) — round-trips as a semantically equivalent plain Rel/BiRel, matching
    // this app's established DSL-fidelity convention (front matter is the canonical round-trip
    // mechanism; a directive that only maps to existing model fields re-serializes in its
    // canonical form, not byte-for-byte, same as style/classDef/linkStyle before it).
    const kind = edge.arrow === 'both' ? 'BiRel' : 'Rel';
    lines.push(`${kind}(${edge.sourceId}, ${edge.targetId}, "${edge.label ?? ''}")`);
  }

  return joinFrontMatter(frontMatter, `${lines.join('\n')}\n`);
}
