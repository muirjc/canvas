import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { isDiagramLinkId, MAX_FRAMES, type DiagramFrame, type DiagramLegend, type DiagramModel, type LegendEntrySpec, type NodeStyle } from '../model/diagram-model.js';
import { AWS_ICONS_VERSION, LEGACY_AWS_PLACEHOLDER_VERSION } from '../libraries/aws-icons.js';

/**
 * The platform's visual-metadata extension point (research.md §1): free-form positions, sizes,
 * and per-element style overrides that classic Mermaid grammar has no room for, carried as a
 * YAML front-matter block any standard Mermaid tool already knows to ignore/pass through.
 */
export interface CanvasFrontMatter {
  canvas?: {
    positions?: Record<string, { x: number; y: number }>;
    containers?: Record<string, { x: number; y: number; width?: number; height?: number }>;
    styles?: Record<string, NodeStyle>;
    /** Per-edge style overrides (`linkStyle`) — keyed by edge id, same shape as node `styles`. */
    edgeStyles?: Record<string, NodeStyle>;
    icons?: Record<string, { libraryId: string; libraryVersion: string; iconId: string }>;
    /** jmuir-dtu.28: element kind per node id, for families whose Mermaid grammar can't carry one
     *  (architecture-beta). */
    kinds?: Record<string, string>;
    /** canvas-ltk: the diagram's legend (validated by readLegend). */
    legend?: unknown;
    /** canvas-rqm6: ids of the shapes and groups Auto Layout leaves where they are (validated by readPinned). */
    pinned?: unknown;
    /** canvas-8uh1.1: element id -> the id of the diagram it links to (validated by applyLinks). */
    links?: Record<string, unknown>;
    /** canvas-8uh1.6: frames, a list of {id, diagramId, x, y, width, height} (validated by applyFrames). */
    frames?: unknown;
  };
}

export interface SplitDocument {
  frontMatter: CanvasFrontMatter;
  body: string;
}

export const FRONT_MATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function splitFrontMatter(dsl: string): SplitDocument {
  const match = dsl.match(FRONT_MATTER_PATTERN);
  if (!match) {
    return { frontMatter: {}, body: dsl };
  }
  const parsed = parseYaml(match[1]) as CanvasFrontMatter | null;
  return { frontMatter: upgradeLegacyIconRefs(ownKeysOnly(parsed ?? {})), body: dsl.slice(match[0].length) };
}

/** An id-keyed section the front matter doesn't have: empty, and no prototype either (see ownKeysOnly). */
export const NO_ENTRIES: Readonly<Record<string, never>> = Object.freeze(Object.create(null) as Record<string, never>);

/** The canvas sections keyed by a diagram's own ids (node, edge, container ids). */
const ID_KEYED_SECTIONS = ['positions', 'containers', 'styles', 'edgeStyles', 'icons', 'kinds', 'links'] as const;

/**
 * canvas-1bty.15.9: each id-keyed section as an object with no prototype, so `positions[id]` finds only
 * what the front matter holds -- an id such as `constructor`, `toString` or `__proto__` is an ordinary
 * id, not a member of Object.prototype (which crashed serializing, or gave a node a function as its
 * style). A section that isn't a map counts as empty. Same as the Python diagram-core.
 */
function ownKeysOnly(frontMatter: CanvasFrontMatter): CanvasFrontMatter {
  const canvas: unknown = frontMatter.canvas;
  if (!isRecord(canvas)) return frontMatter;
  for (const key of ID_KEYED_SECTIONS) {
    const section = canvas[key];
    if (section === undefined || section === null) continue;
    canvas[key] = isRecord(section) ? Object.assign(Object.create(null), section) : Object.create(null);
  }
  return frontMatter;
}

/**
 * jmuir-dtu.29: the aws-icons library's version moved from '2024.1-placeholder' to
 * AWS_ICONS_VERSION (shared by the placeholder and a locally generated real library). Rewriting
 * saved references here covers every diagram family, since they all read icons from front-matter.
 */
function upgradeLegacyIconRefs(frontMatter: CanvasFrontMatter): CanvasFrontMatter {
  const icons = frontMatter.canvas?.icons;
  if (!icons) return frontMatter;
  for (const ref of Object.values(icons)) {
    if (ref && ref.libraryId === 'aws-icons' && String(ref.libraryVersion) === LEGACY_AWS_PLACEHOLDER_VERSION) {
      ref.libraryVersion = AWS_ICONS_VERSION;
    }
  }
  return frontMatter;
}

/**
 * jmuir-dtu.16: strips a Mermaid `%%` comment from a line -- both the whole-line form (`%% ...`)
 * every parser already recognized (`line.startsWith('%%')`), and a trailing same-line form
 * (`A --> B %% note`) none of them did: a trailing comment failed every construct regex on that
 * line and hard-errored instead of being stripped. Matches real Mermaid's own naive behavior (the
 * first `%%` anywhere ends the line, even inside otherwise-valid text) rather than trying to be
 * smarter about quoted content -- shared by all 6 DSL parsers so they can't drift apart on this.
 * Returns the line trimmed of trailing whitespace after stripping; an empty result means the whole
 * line was a comment, same outcome the old whole-line-only check already produced.
 */
export function stripTrailingComment(line: string): string {
  const index = line.indexOf('%%');
  return index === -1 ? line : line.slice(0, index).trimEnd();
}

export function joinFrontMatter(frontMatter: CanvasFrontMatter, body: string): string {
  // canvas-bnnh: a key beside `canvas` (a state diagram's `title`) is content too.
  const hasContent =
    Object.keys(frontMatter).some((key) => key !== 'canvas') ||
    Object.keys(frontMatter.canvas ?? {}).some((key) => Object.keys((frontMatter.canvas as Record<string, unknown>)[key] ?? {}).length > 0);
  if (!hasContent) {
    return body;
  }
  return `---\n${stringifyYaml(frontMatter).trimEnd()}\n---\n${body}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : undefined);

/** canvas-ltk: the legend from front-matter, validated; anything malformed is dropped (never a parse error). */
export function readLegend(frontMatter: CanvasFrontMatter): DiagramLegend | undefined {
  const raw = frontMatter.canvas?.legend;
  if (!isRecord(raw)) return undefined;
  const legend: DiagramLegend = { visible: raw.visible !== false };
  if (isRecord(raw.position) && Number.isFinite(Number(raw.position.x)) && Number.isFinite(Number(raw.position.y))) {
    legend.position = { x: Number(raw.position.x), y: Number(raw.position.y) };
  }
  const title = str(raw.title);
  if (title) legend.title = title;
  if (Array.isArray(raw.hidden)) {
    const hidden = raw.hidden.filter((h): h is string => typeof h === 'string');
    if (hidden.length) legend.hidden = hidden;
  }
  if (isRecord(raw.labels)) {
    const labels = Object.fromEntries(Object.entries(raw.labels).flatMap(([k, v]) => (str(v) ? [[k, str(v)!]] : [])));
    if (Object.keys(labels).length) legend.labels = labels;
  }
  if (Array.isArray(raw.extra)) {
    const extra = raw.extra.flatMap((e): LegendEntrySpec[] => {
      if (!isRecord(e) || !str(e.id) || !str(e.label) || !isRecord(e.sample)) return [];
      const s = e.sample;
      if (s.kind === 'shape' && str(s.shape)) {
        return [{ id: str(e.id)!, label: str(e.label)!, sample: { kind: 'shape', shape: str(s.shape) as never, ...(str(s.fill) ? { fill: str(s.fill) } : {}), ...(str(s.stroke) ? { stroke: str(s.stroke) } : {}) } }];
      }
      if (s.kind === 'line') {
        return [
          {
            id: str(e.id)!,
            label: str(e.label)!,
            sample: { kind: 'line', ...(str(s.lineStyle) ? { lineStyle: str(s.lineStyle) as never } : {}), ...(str(s.arrow) ? { arrow: str(s.arrow) as never } : {}), ...(str(s.stroke) ? { stroke: str(s.stroke) } : {}) },
          },
        ];
      }
      return [];
    });
    if (extra.length) legend.extra = extra;
  }
  return legend;
}

/** canvas-ltk: adds the model's legend to a serializer's front-matter (when it has one). */
export function withLegend(frontMatter: CanvasFrontMatter, model: Pick<DiagramModel, 'legend'>): CanvasFrontMatter {
  if (!model.legend) return frontMatter;
  return { ...frontMatter, canvas: { ...(frontMatter.canvas ?? {}), legend: model.legend } };
}

/** canvas-rqm6: the pinned ids from front matter: strings naming a shape or group the model has, each once, in
 *  order. Undefined when there are none (anything else in the list is dropped, never a parse error). */
export function readPinned(frontMatter: CanvasFrontMatter, model: Pick<DiagramModel, 'nodes' | 'containers'>): string[] | undefined {
  return pinnedIds(frontMatter.canvas?.pinned, model);
}

/** canvas-rqm6: adds the model's pinned ids to a serializer's front matter (only ids it still has). */
export function withPinned(frontMatter: CanvasFrontMatter, model: Pick<DiagramModel, 'nodes' | 'containers' | 'pinned'>): CanvasFrontMatter {
  const pinned = pinnedIds(model.pinned, model);
  if (!pinned) return frontMatter;
  return { ...frontMatter, canvas: { ...(frontMatter.canvas ?? {}), pinned } };
}

function pinnedIds(raw: unknown, model: Pick<DiagramModel, 'nodes' | 'containers'>): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const known = new Set<string>([...model.nodes.map((n) => n.id), ...model.containers.map((c) => c.id)]);
  const ids = [...new Set(raw.filter((id): id is string => typeof id === 'string' && known.has(id)))];
  return ids.length > 0 ? ids : undefined;
}

/** canvas-8uh1.1: gives each node and group named in `canvas.links` its `diagramRef`. An entry for an id the
 *  model lacks, or whose value isn't a diagram id, is dropped (never a parse error). Changes the model's own
 *  elements: call it at the end of a parse. */
export function applyLinks(frontMatter: CanvasFrontMatter, model: Pick<DiagramModel, 'nodes' | 'containers'>): void {
  const links = frontMatter.canvas?.links;
  if (!links || typeof links !== 'object') return;
  for (const element of [...model.nodes, ...model.containers]) {
    if (!Object.prototype.hasOwnProperty.call(links, element.id)) continue;
    const diagramId = links[element.id];
    if (isDiagramLinkId(diagramId)) element.diagramRef = { diagramId };
  }
}

/** canvas-8uh1.1: adds the model's links to a serializer's front matter, nodes then groups in model order, each
 *  under the id the element will have when the text is read back (`savedId`; the same id unless a family renames
 *  on save). Nothing is added when no element links anywhere. */
export function withLinks(
  frontMatter: CanvasFrontMatter,
  model: Pick<DiagramModel, 'nodes' | 'containers'>,
  savedId: (id: string, kind: 'node' | 'container') => string | undefined = (id) => id,
): CanvasFrontMatter {
  const links: Record<string, string> = Object.create(null) as Record<string, string>;
  let any = false;
  const add = (element: { id: string; diagramRef?: { diagramId: string } }, kind: 'node' | 'container') => {
    const diagramId = element.diagramRef?.diagramId;
    const id = savedId(element.id, kind);
    if (id === undefined || !isDiagramLinkId(diagramId) || Object.prototype.hasOwnProperty.call(links, id)) return;
    links[id] = diagramId;
    any = true;
  };
  for (const node of model.nodes) add(node, 'node');
  for (const container of model.containers) add(container, 'container');
  if (!any) return frontMatter;
  return { ...frontMatter, canvas: { ...(frontMatter.canvas ?? {}), links: { ...links } } };
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** canvas-8uh1.6: sets `model.frames` from the front matter's `canvas.frames`: entries that aren't a frame (bad
 *  ids, a repeated id, numbers that aren't finite, a size that isn't positive) are dropped, never an error; at
 *  most MAX_FRAMES are read. */
export function applyFrames(frontMatter: CanvasFrontMatter, model: Pick<DiagramModel, 'frames'>): void {
  const listed = frontMatter.canvas?.frames;
  if (!Array.isArray(listed)) return;
  const frames: DiagramFrame[] = [];
  const seen = new Set<string>();
  for (const entry of listed as unknown[]) {
    if (frames.length >= MAX_FRAMES) break;
    if (!entry || typeof entry !== 'object') continue;
    const { id, diagramId, x, y, width, height } = entry as Record<string, unknown>;
    if (!isDiagramLinkId(id) || !isDiagramLinkId(diagramId) || seen.has(id)) continue;
    if (!finite(x) || !finite(y) || !finite(width) || !finite(height) || width <= 0 || height <= 0) continue;
    seen.add(id);
    frames.push({ id, diagramId, position: { x, y }, size: { width, height } });
  }
  if (frames.length > 0) model.frames = frames;
}

/** canvas-8uh1.6: adds the model's frames to a serializer's front matter (the same checks as applyFrames). Nothing
 *  is added when there are none. */
export function withFrames(frontMatter: CanvasFrontMatter, model: Pick<DiagramModel, 'frames'>): CanvasFrontMatter {
  const read: Pick<DiagramModel, 'frames'> = {};
  applyFrames(
    {
      canvas: {
        frames: (model.frames ?? []).map((f) => ({ id: f.id, diagramId: f.diagramId, x: f.position?.x, y: f.position?.y, width: f.size?.width, height: f.size?.height })),
      },
    },
    read,
  );
  if (!read.frames) return frontMatter;
  const frames = read.frames.map((f) => ({ id: f.id, diagramId: f.diagramId, x: f.position.x, y: f.position.y, width: f.size.width, height: f.size.height }));
  return { ...frontMatter, canvas: { ...(frontMatter.canvas ?? {}), frames } };
}
