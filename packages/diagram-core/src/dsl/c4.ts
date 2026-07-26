import { createEmptyDiagramModel, type DiagramContainer, type DiagramNode } from '../model/diagram-model.js';
import { splitFrontMatter, joinFrontMatter, type CanvasFrontMatter } from './front-matter.js';
import type { ParseError, ParseResult } from './types.js';

const ID = String.raw`[A-Za-z0-9_]+`;

const HEADER_TO_LEVEL: Record<string, string> = {
  C4Context: 'c4-context',
  C4Container: 'c4-container',
  C4Component: 'c4-component',
  C4Dynamic: 'c4-code',
};
const LEVEL_TO_HEADER: Record<string, string> = Object.fromEntries(
  Object.entries(HEADER_TO_LEVEL).map(([header, level]) => [level, header]),
);

// Person(alias, "label", "description") / Person_Ext(...) — description is optional.
const ELEMENT_PATTERN = new RegExp(
  `^(Person|Person_Ext|System|System_Ext|SystemDb|Container|Container_Ext|Component|Component_Ext)\\(\\s*(${ID})\\s*,\\s*"([^"]*)"(?:\\s*,\\s*"([^"]*)")?\\s*\\)$`,
);
const REL_PATTERN = new RegExp(`^Rel\\(\\s*(${ID})\\s*,\\s*(${ID})\\s*,\\s*"([^"]*)"\\s*\\)$`);
const BOUNDARY_START = new RegExp(`^(System_Boundary|Container_Boundary|Enterprise_Boundary)\\(\\s*(${ID})\\s*,\\s*"([^"]*)"\\s*\\)\\s*\\{$`);
const BOUNDARY_END = /^\}$/;

const ELEMENT_TO_ROLE: Record<string, string> = {
  Person: 'person',
  Person_Ext: 'person',
  System: 'system',
  System_Ext: 'system',
  SystemDb: 'system',
  Container: 'container',
  Container_Ext: 'container',
  Component: 'component',
  Component_Ext: 'component',
};
const ELEMENT_TO_SHAPE: Record<string, DiagramNode['shape']> = {
  Person: 'person',
  Person_Ext: 'person',
  System: 'rectangle',
  System_Ext: 'rectangle',
  SystemDb: 'cylinder',
  Container: 'rounded-rectangle',
  Container_Ext: 'rounded-rectangle',
  Component: 'rounded-rectangle',
  Component_Ext: 'rounded-rectangle',
};
const SHAPE_TO_ELEMENT: Record<string, string> = {
  'c4-context': 'System',
  'c4-container': 'Container',
  'c4-component': 'Component',
  'c4-code': 'Component',
};

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
  const containerMeta = frontMatter.canvas?.containers ?? {};

  const lines = body.split(/\r?\n/);
  const errors: ParseError[] = [];
  const nodesById = new Map<string, DiagramNode>();
  const containersById = new Map<string, DiagramContainer>();
  const edges: { id: string; sourceId: string; targetId: string; label?: string }[] = [];
  const containerStack: string[] = [];
  let level: string | null = null;
  let edgeCounter = 0;

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
      const [, source, target, label] = relMatch;
      edgeCounter += 1;
      edges.push({ id: `e${edgeCounter}`, sourceId: source, targetId: target, label });
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

  const model = createEmptyDiagramModel(level ?? 'c4-context');
  model.nodes = Array.from(nodesById.values());
  model.containers = Array.from(containersById.values());
  model.edges = edges;
  return { model };
}

function elementKindFor(node: DiagramNode): string {
  if (node.role === 'person') return 'Person';
  if (node.role === 'system') return node.shape === 'cylinder' ? 'SystemDb' : 'System';
  if (node.role === 'container') return 'Container';
  if (node.role === 'component') return 'Component';
  return SHAPE_TO_ELEMENT[node.shape] ?? 'System';
}

export function serializeC4(model: import('../model/diagram-model.js').DiagramModel): string {
  const frontMatter: CanvasFrontMatter = {
    canvas: {
      positions: Object.fromEntries(model.nodes.map((n) => [n.id, n.position])),
      styles: Object.fromEntries(model.nodes.filter((n) => n.style).map((n) => [n.id, n.style!])),
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

  const emitContainer = (container: DiagramContainer): string[] => {
    const out: string[] = [`System_Boundary(${container.id}, "${container.label}") {`];
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
    lines.push(`Rel(${edge.sourceId}, ${edge.targetId}, "${edge.label ?? ''}")`);
  }

  return joinFrontMatter(frontMatter, `${lines.join('\n')}\n`);
}
