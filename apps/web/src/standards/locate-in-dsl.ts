import type { DiagramModel } from '@canvas/diagram-core';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * canvas-tfr: best-effort 1-based line number in `dsl` where an element is declared, so a standards
 * issue in hand-written DSL can point at its line. Nodes: the first line that declares the id
 * (flowchart `id[`/`id(`/`id{`/`id>`/`id:::`/bare `id` line, C4 `Macro(id,`). Edges: the first line
 * mentioning both endpoint ids. Undefined when nothing plausible matches -- the issue is then shown
 * without a line number rather than with a wrong one.
 */
export function findElementLine(dsl: string, elementId: string, model: DiagramModel): number | undefined {
  const lines = dsl.split('\n');
  const edge = model.edges.find((e) => e.id === elementId);
  if (edge) {
    const src = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(edge.sourceId)}([^A-Za-z0-9_]|$)`);
    const tgt = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(edge.targetId)}([^A-Za-z0-9_]|$)`);
    const index = lines.findIndex((line) => src.test(line) && tgt.test(line) && /--|==|-\.|~~|Rel/.test(line));
    return index >= 0 ? index + 1 : undefined;
  }
  const id = escapeRegExp(elementId);
  const declaration = new RegExp(`^\\s*(?:${id}\\s*(?:[[({>]|:::|$)|[A-Za-z_]+\\(\\s*${id}\\s*[,)]|subgraph\\s+${id}\\b)`);
  const index = lines.findIndex((line) => declaration.test(line));
  return index >= 0 ? index + 1 : undefined;
}

/** Character offsets of a 1-based line, for selecting it in a textarea. */
export function lineRange(dsl: string, line: number): { start: number; end: number } {
  const lines = dsl.split('\n');
  let start = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i += 1) start += lines[i].length + 1;
  return { start, end: start + (lines[line - 1]?.length ?? 0) };
}
