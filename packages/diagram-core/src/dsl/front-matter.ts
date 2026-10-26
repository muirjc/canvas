import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { DiagramLegend, DiagramModel, LegendEntrySpec, NodeStyle } from '../model/diagram-model.js';
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
  return { frontMatter: upgradeLegacyIconRefs(parsed ?? {}), body: dsl.slice(match[0].length) };
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
  const hasContent = Object.keys(frontMatter.canvas ?? {}).some(
    (key) => Object.keys((frontMatter.canvas as Record<string, unknown>)[key] ?? {}).length > 0,
  );
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
