import { createEmptyDiagramModel, type DiagramContainer, type DiagramModel, type DiagramNode } from '../model/diagram-model.js';
import { splitFrontMatter, joinFrontMatter, type CanvasFrontMatter } from './front-matter.js';
import type { ParseError, ParseResult } from './types.js';

const ID = String.raw`[A-Za-z0-9_]+`;

// group groupId(icon)[Title]
const GROUP_PATTERN = new RegExp(`^group\\s+(${ID})\\(([^)]*)\\)\\[(.+)\\]$`);
// service serviceId(icon)[Title] in groupId
const SERVICE_PATTERN = new RegExp(`^service\\s+(${ID})\\(([^)]*)\\)\\[(.+?)\\](?:\\s+in\\s+(${ID}))?$`);
// jmuir-dtu.5: junction junctionId (in groupId)? -- "a special type of node which acts as a
// potential 4-way split between edges" (Mermaid docs). No icon/label, unlike service.
const JUNCTION_PATTERN = new RegExp(`^junction\\s+(${ID})(?:\\s+in\\s+(${ID}))?$`);
// serviceA:R --> L:serviceB   or   serviceA <-- serviceB   or   serviceA -- serviceB
// jmuir-dtu.5: the {group} modifier escalates an endpoint to its service's parent group boundary
// -- per Mermaid's own docs, it can ONLY follow a serviceId (never a bare groupId; "groupIds
// cannot be used for specifying edges"), so the id captured here always still names a service.
const EDGE_PATTERN = new RegExp(
  `^(${ID})(\\{group\\})?(?::([TBLR]))?\\s*(-->|<--|--)\\s*(?:([TBLR]):)?(${ID})(\\{group\\})?$`,
);
// jmuir-dtu.5: align row/column <id> <id> ... -- declares a shared row (same y) or column (same
// x) for a set of service/group ids. Real Mermaid grammar (unlike positions/styles/icons, which
// are this app's own front-matter extension), so it round-trips as a literal body line, matching
// direction's own precedent, not tucked into front-matter.
const ALIGN_PATTERN = new RegExp(`^align\\s+(row|column)\\s+((?:${ID})(?:\\s+${ID})*)$`);
// jmuir-dtu.5: an iconify.design custom icon pack reference ("name:icon-name" -- e.g.
// "logos:aws-lambda"), distinct from this app's own bare curated-library icon ids (which never
// contain a colon). Only matters for a first-time import with no front-matter icons[id] entry yet
// (front-matter is the canonical round-trip mechanism once an icon has been resolved once).
const ICONIFY_ICON_PATTERN = /^([a-z0-9-]+):(.+)$/i;

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
  const edges: {
    id: string;
    sourceId: string;
    targetId: string;
    arrow?: 'source' | 'target';
    sourceAnchor?: 'T' | 'B' | 'L' | 'R';
    targetAnchor?: 'T' | 'B' | 'L' | 'R';
    sourceIsGroup?: boolean;
    targetIsGroup?: boolean;
  }[] = [];
  const alignments: { axis: 'row' | 'column'; ids: string[] }[] = [];
  let headerSeen = false;
  let edgeCounter = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('%%')) continue;

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
        icon: iconRef ?? resolveIconFromName(iconName),
      });
      continue;
    }

    const junctionMatch = line.match(JUNCTION_PATTERN);
    if (junctionMatch) {
      const [, id, groupId] = junctionMatch;
      // No icon/label -- a junction is a pure routing point, not a service (Mermaid's own docs:
      // "a special type of node which acts as a potential 4-way split between edges").
      nodesById.set(id, {
        id,
        label: '',
        shape: 'circle',
        role: 'junction',
        position: positions[id] ?? nextAutoPosition(),
        containerId: groupId,
      });
      continue;
    }

    const alignMatch = line.match(ALIGN_PATTERN);
    if (alignMatch) {
      const [, axis, idList] = alignMatch;
      alignments.push({ axis: axis as 'row' | 'column', ids: idList.split(/\s+/) });
      continue;
    }

    const edgeMatch = line.match(EDGE_PATTERN);
    if (edgeMatch) {
      const [, source, sourceGroup, sourceAnchor, connector, targetAnchor, target, targetGroup] = edgeMatch;
      edgeCounter += 1;
      const arrow: 'source' | 'target' | undefined =
        connector === '-->' ? 'target' : connector === '<--' ? 'source' : undefined;
      edges.push({
        id: `e${edgeCounter}`,
        sourceId: source,
        targetId: target,
        arrow,
        sourceAnchor: sourceAnchor as 'T' | 'B' | 'L' | 'R' | undefined,
        targetAnchor: targetAnchor as 'T' | 'B' | 'L' | 'R' | undefined,
        sourceIsGroup: sourceGroup ? true : undefined,
        targetIsGroup: targetGroup ? true : undefined,
      });
      continue;
    }

    errors.push({ line: i + 1, content: rawLine, message: `Could not interpret line as a group, service, junction, align, or edge: "${line}"` });
  }

  if (errors.length > 0) return { errors };

  const model = createEmptyDiagramModel('cloud-infrastructure');
  model.nodes = Array.from(nodesById.values());
  model.containers = Array.from(containersById.values());
  model.edges = edges;
  if (alignments.length > 0) model.architectureAlignments = alignments;
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
    const inClause = node.containerId ? ` in ${node.containerId}` : '';
    if (node.role === 'junction') {
      lines.push(`junction ${node.id}${inClause}`);
      continue;
    }
    // Iconify-sourced icons (jmuir-dtu.5) re-emit as "prefix:iconId" so the reference survives
    // textually too, not just via the front-matter icons[id] entry -- matters for a fresh export
    // with no prior front-matter round-trip yet.
    const iconName = node.icon
      ? node.icon.libraryVersion === 'iconify'
        ? `${node.icon.libraryId}:${node.icon.iconId}`
        : node.icon.iconId
      : 'default';
    lines.push(`service ${node.id}(${iconName})[${node.label}]${inClause}`);
  }
  for (const edge of model.edges) {
    const connector = edge.arrow === 'target' ? '-->' : edge.arrow === 'source' ? '<--' : '--';
    const sourceGroupSuffix = edge.sourceIsGroup ? '{group}' : '';
    const targetGroupSuffix = edge.targetIsGroup ? '{group}' : '';
    const sourcePart = edge.sourceAnchor
      ? `${edge.sourceId}${sourceGroupSuffix}:${edge.sourceAnchor}`
      : `${edge.sourceId}${sourceGroupSuffix}`;
    const targetPart = edge.targetAnchor
      ? `${edge.targetAnchor}:${edge.targetId}${targetGroupSuffix}`
      : `${edge.targetId}${targetGroupSuffix}`;
    lines.push(`${sourcePart} ${connector} ${targetPart}`);
  }
  for (const alignment of model.architectureAlignments ?? []) {
    lines.push(`align ${alignment.axis} ${alignment.ids.join(' ')}`);
  }

  return joinFrontMatter(frontMatter, `${lines.join('\n')}\n`);
}

/** jmuir-dtu.5: resolves a service's `(iconName)` token to an IconRef on first import (no
 *  front-matter icons[id] entry yet). Detects the iconify.design "prefix:icon-name" custom-pack
 *  format (e.g. "logos:aws-lambda") distinctly from this app's own bare curated-library icon ids
 *  (azure-icons/aws-icons/c4-notation/generic, none of which ever contain a colon) -- tagging it
 *  with libraryVersion 'iconify' rather than mislabeling it as this app's own 'generic' library,
 *  which would point at a nonexistent icon and silently render as a placeholder. Resolving real
 *  iconify artwork (network fetch, caching) is a separate, much larger feature, not attempted
 *  here -- this is parse/model/round-trip fidelity only, matching this epic's consistent scope. */
function resolveIconFromName(iconName: string): DiagramNode['icon'] {
  if (!iconName) return undefined;
  const iconifyMatch = iconName.match(ICONIFY_ICON_PATTERN);
  if (iconifyMatch) {
    const [, libraryId, iconId] = iconifyMatch;
    return { libraryId, libraryVersion: 'iconify', iconId };
  }
  return { libraryId: 'generic', libraryVersion: '1.0.0', iconId: iconName };
}
