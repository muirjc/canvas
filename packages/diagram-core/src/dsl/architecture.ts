import { createEmptyDiagramModel, type DiagramContainer, type DiagramModel, type DiagramNode } from '../model/diagram-model.js';
import { splitFrontMatter, joinFrontMatter, type CanvasFrontMatter } from './front-matter.js';
import type { ParseError, ParseResult } from './types.js';

const ID = String.raw`[A-Za-z0-9_]+`;

// group groupId(icon)[Title]
const GROUP_PATTERN = new RegExp(`^group\\s+(${ID})\\(([^)]*)\\)\\[(.+)\\]$`);
// service serviceId(icon)[Title] in groupId
const SERVICE_PATTERN = new RegExp(`^service\\s+(${ID})\\(([^)]*)\\)\\[(.+?)\\](?:\\s+in\\s+(${ID}))?$`);
// serviceA:R -- L:serviceB   or   serviceA -- serviceB
const EDGE_PATTERN = new RegExp(`^(${ID})(?::[TBLR])?\\s*--\\s*(?:[TBLR]:)?(${ID})$`);

let autoPositionCounter = 0;
function nextAutoPosition(): { x: number; y: number } {
  const position = { x: (autoPositionCounter % 5) * 180 + 40, y: Math.floor(autoPositionCounter / 5) * 140 + 40 };
  autoPositionCounter += 1;
  return position;
}

/**
 * Parses Mermaid `architecture-beta` diagrams — the cloud/network/deployment diagram family,
 * where nodes carry vendor icon references (Azure/AWS) via the `(iconId)` syntax, resolved
 * against a specific icon library/version through the front-matter `icons` map (research.md §1;
 * Mermaid's own icon syntax only carries a bare id, not a library+version-pinned reference).
 */
export function parseArchitecture(dsl: string): ParseResult {
  autoPositionCounter = 0;
  const { frontMatter, body } = splitFrontMatter(dsl);
  const positions = frontMatter.canvas?.positions ?? {};
  const containerMeta = frontMatter.canvas?.containers ?? {};
  const icons = frontMatter.canvas?.icons ?? {};

  const lines = body.split(/\r?\n/);
  const errors: ParseError[] = [];
  const nodesById = new Map<string, DiagramNode>();
  const containersById = new Map<string, DiagramContainer>();
  const edges: { id: string; sourceId: string; targetId: string }[] = [];
  let headerSeen = false;
  let edgeCounter = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;

    if (!headerSeen) {
      if (line === 'architecture-beta') {
        headerSeen = true;
        continue;
      }
      errors.push({ line: i + 1, content: rawLine, message: 'Expected "architecture-beta" header line' });
      continue;
    }

    const groupMatch = line.match(GROUP_PATTERN);
    if (groupMatch) {
      const [, id, , label] = groupMatch;
      const meta = containerMeta[id];
      containersById.set(id, {
        id,
        label,
        position: meta ? { x: meta.x, y: meta.y } : nextAutoPosition(),
        size: meta?.width !== undefined && meta?.height !== undefined ? { width: meta.width, height: meta.height } : undefined,
      });
      continue;
    }

    const serviceMatch = line.match(SERVICE_PATTERN);
    if (serviceMatch) {
      const [, id, iconName, label, groupId] = serviceMatch;
      const iconRef = icons[id];
      nodesById.set(id, {
        id,
        label,
        shape: 'icon',
        position: positions[id] ?? nextAutoPosition(),
        containerId: groupId,
        icon: iconRef ?? (iconName ? { libraryId: 'generic', libraryVersion: '1.0.0', iconId: iconName } : undefined),
      });
      continue;
    }

    const edgeMatch = line.match(EDGE_PATTERN);
    if (edgeMatch) {
      const [, source, target] = edgeMatch;
      edgeCounter += 1;
      edges.push({ id: `e${edgeCounter}`, sourceId: source, targetId: target });
      continue;
    }

    errors.push({ line: i + 1, content: rawLine, message: `Could not interpret line as a group, service, or edge: "${line}"` });
  }

  if (errors.length > 0) return { errors };

  const model = createEmptyDiagramModel('cloud-infrastructure');
  model.nodes = Array.from(nodesById.values());
  model.containers = Array.from(containersById.values());
  model.edges = edges;
  return { model };
}

export function serializeArchitecture(model: DiagramModel): string {
  const frontMatter: CanvasFrontMatter = {
    canvas: {
      positions: Object.fromEntries(model.nodes.map((n) => [n.id, n.position])),
      containers: Object.fromEntries(
        model.containers
          .filter((c) => c.size)
          .map((c) => [c.id, { x: c.position.x, y: c.position.y, width: c.size!.width, height: c.size!.height }]),
      ),
      icons: Object.fromEntries(model.nodes.filter((n) => n.icon).map((n) => [n.id, n.icon!])),
    },
  };

  const lines: string[] = ['architecture-beta'];
  for (const group of model.containers) {
    lines.push(`group ${group.id}(cloud)[${group.label}]`);
  }
  for (const node of model.nodes) {
    const iconName = node.icon?.iconId ?? 'default';
    const inClause = node.containerId ? ` in ${node.containerId}` : '';
    lines.push(`service ${node.id}(${iconName})[${node.label}]${inClause}`);
  }
  for (const edge of model.edges) {
    lines.push(`${edge.sourceId} -- ${edge.targetId}`);
  }

  return joinFrontMatter(frontMatter, `${lines.join('\n')}\n`);
}
