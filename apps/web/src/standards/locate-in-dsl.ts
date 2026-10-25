import { findElementLine } from '@canvas/diagram-core';

// canvas-3s5.3: moved to diagram-core (shared with the CI validator).
export { findElementLine };

/** Character offsets of a 1-based line, for selecting it in a textarea. */
export function lineRange(dsl: string, line: number): { start: number; end: number } {
  const lines = dsl.split('\n');
  let start = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i += 1) start += lines[i].length + 1;
  return { start, end: start + (lines[line - 1]?.length ?? 0) };
}
