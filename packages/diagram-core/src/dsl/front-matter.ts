import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { NodeStyle } from '../model/diagram-model.js';

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
  };
}

export interface SplitDocument {
  frontMatter: CanvasFrontMatter;
  body: string;
}

const FRONT_MATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function splitFrontMatter(dsl: string): SplitDocument {
  const match = dsl.match(FRONT_MATTER_PATTERN);
  if (!match) {
    return { frontMatter: {}, body: dsl };
  }
  const parsed = parseYaml(match[1]) as CanvasFrontMatter | null;
  return { frontMatter: parsed ?? {}, body: dsl.slice(match[0].length) };
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
