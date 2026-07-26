import { splitFrontMatter } from './front-matter.js';

const HEADER_TO_FAMILY: Array<{ pattern: RegExp; family: string }> = [
  { pattern: /^(?:flowchart|graph)\s+(TD|LR|TB|RL|BT)$/i, family: 'flowchart' },
  { pattern: /^C4(Context|Container|Component|Dynamic)$/, family: 'c4' },
  { pattern: /^sequenceDiagram$/, family: 'sequence' },
  { pattern: /^erDiagram$/, family: 'erd' },
  { pattern: /^classDiagram$/, family: 'uml' },
  { pattern: /^architecture-beta$/, family: 'architecture' },
];

/**
 * Identifies which DSL family a raw block of Mermaid text belongs to, by its header line — the
 * missing piece for import (User Story 5): a pasted/uploaded diagram doesn't arrive already
 * tagged with a diagramTypeId, so the platform must work out how to parse it before anything
 * else can happen. Returns undefined for unrecognized/empty input (FR-019: reported specifically,
 * never silently guessed).
 */
export function detectDslFamily(dsl: string): string | undefined {
  const { body } = splitFrontMatter(dsl);
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return undefined;

  return HEADER_TO_FAMILY.find(({ pattern }) => pattern.test(firstLine))?.family;
}
