// canvas-8wxq: Mermaid 11.3+'s `@{ … }` blocks on flowchart nodes (`A@{ shape: cyl, label: "Orders" }`) and
// edge ids (`e1@{ animate: true }`). The block is a YAML flow mapping; Canvas reads the subset Mermaid's
// docs use: `key: value` pairs, values double-quoted (\" \\ \n \t \r escapes), single-quoted ('' for ')
// or bare (true/false, a plain number, else text).
import type { MermaidData, NodeShape } from '../model/diagram-model.js';

/** What goes between `@{` and `}`, quotes balanced, as a regex source (no capture groups). */
export const SHAPE_DATA_INNER_SOURCE = String.raw`(?:[^{}"']|"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')*`;
/** The block itself. */
export const SHAPE_DATA_SOURCE = String.raw`@\{${SHAPE_DATA_INNER_SOURCE}\}`;

/** canvas-sfz7: the longest flowchart link length kept (a longer link is read, and written back, at this length). */
export const MAX_LINK_LENGTH = 1000;

/** A key or a shape name. */
export const MERMAID_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

const WS = /\s*/y;
// canvas-lwa4: a key may be quoted, as JSON writes it (`"type": "boundary"`, the form Mermaid's sequence docs use).
const KEY = /([A-Za-z][A-Za-z0-9_-]*)|"([A-Za-z][A-Za-z0-9_-]*)"|'([A-Za-z][A-Za-z0-9_-]*)'/y;
const COLON = /:/y;
const COMMA = /,/y;
const DOUBLE_QUOTED = /"((?:[^"\\]|\\.)*)"/y;
const SINGLE_QUOTED = /'((?:[^']|'')*)'/y;
const BARE = /[^,\s](?:[^,]*[^,\s])?/y;
const NUMBER = /^-?[0-9]{1,9}(?:\.[0-9]{1,6})?$/;
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r' };

function at(pattern: RegExp, text: string, pos: number): RegExpExecArray | null {
  pattern.lastIndex = pos;
  return pattern.exec(text);
}

/** Reads the text between `@{` and `}`: the pairs in order, or what is wrong with it. */
export function parseShapeData(inner: string): { entries: [string, string | number | boolean][] } | { error: string } {
  const entries: [string, string | number | boolean][] = [];
  const seen = new Set<string>();
  let pos = at(WS, inner, 0)![0].length;
  while (pos < inner.length) {
    const key = at(KEY, inner, pos);
    if (!key) return { error: `Expected a key at "${inner.slice(pos)}"` };
    const name = key[1] ?? key[2] ?? key[3];
    pos += key[0].length;
    pos += at(WS, inner, pos)![0].length;
    if (!at(COLON, inner, pos)) return { error: `Expected ":" after "${name}"` };
    pos += 1;
    pos += at(WS, inner, pos)![0].length;
    let value: string | number | boolean;
    let match: RegExpExecArray | null;
    if ((match = at(DOUBLE_QUOTED, inner, pos))) {
      value = match[1].replace(/\\(.)/g, (_, c: string) => ESCAPES[c] ?? c);
    } else if ((match = at(SINGLE_QUOTED, inner, pos))) {
      value = match[1].replace(/''/g, "'");
    } else if ((match = at(BARE, inner, pos))) {
      const text = match[0];
      value = text === 'true' ? true : text === 'false' ? false : NUMBER.test(text) ? Number(text) : text;
    } else {
      return { error: `"${name}" has no value` };
    }
    pos += match[0].length;
    if (seen.has(name)) return { error: `"${name}" is given twice` };
    seen.add(name);
    entries.push([name, value]);
    pos += at(WS, inner, pos)![0].length;
    if (pos < inner.length) {
      if (!at(COMMA, inner, pos)) return { error: `Expected "," at "${inner.slice(pos)}"` };
      pos += 1;
      pos += at(WS, inner, pos)![0].length;
    }
  }
  return { entries };
}

function formatValue(value: string | number | boolean): string {
  if (typeof value !== 'string') return `${value}`;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

/** `@{ key: value, … }`; a shape name is written bare. Keys that aren't names, and values that aren't a
 *  string, a finite number or a boolean, are left out. */
export function formatShapeData(entries: [string, unknown][]): string {
  const parts: string[] = [];
  for (const [key, value] of entries) {
    if (!MERMAID_NAME.test(key)) continue;
    if (key === 'shape' && typeof value === 'string' && MERMAID_NAME.test(value)) parts.push(`shape: ${value}`);
    else if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      parts.push(`${key}: ${formatValue(value)}`);
    }
  }
  return `@{ ${parts.join(', ')} }`;
}

/** The entries of a model's `mermaidData` worth writing: own keys that are names (see formatShapeData). */
export function dataEntries(data: MermaidData | undefined, skip: readonly string[] = []): [string, unknown][] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  return Object.keys(data)
    .filter((key) => MERMAID_NAME.test(key) && !skip.includes(key))
    .map((key): [string, unknown] => [key, data[key]]);
}

// Mermaid's shape table (flowchart docs, "Complete list of new shapes"), every name and alias Canvas draws as
// something other than a rectangle. Every other name -- Mermaid's document, cloud, flag, card, … -- is drawn
// as a rectangle, and the name is kept.
const NEAREST: Record<string, NodeShape> = Object.assign(Object.create(null) as Record<string, NodeShape>, {
  rounded: 'rounded-rectangle', event: 'rounded-rectangle', delay: 'rounded-rectangle', 'half-rounded-rectangle': 'rounded-rectangle',
  circle: 'circle', circ: 'circle', 'sm-circ': 'circle', 'small-circle': 'circle', start: 'circle',
  'f-circ': 'circle', 'filled-circle': 'circle', junction: 'circle',
  'cross-circ': 'circle', 'crossed-circle': 'circle', summary: 'circle',
  'dbl-circ': 'double-circle', 'double-circle': 'double-circle',
  'fr-circ': 'double-circle', 'framed-circle': 'double-circle', stop: 'double-circle',
  diam: 'diamond', diamond: 'diamond', decision: 'diamond', question: 'diamond',
  cyl: 'cylinder', cylinder: 'cylinder', database: 'cylinder', db: 'cylinder',
  'h-cyl': 'cylinder', das: 'cylinder', 'horizontal-cylinder': 'cylinder',
  'lin-cyl': 'cylinder', disk: 'cylinder', 'lined-cylinder': 'cylinder',
  datastore: 'cylinder', 'data-store': 'cylinder', bucket: 'cylinder',
  stadium: 'stadium', pill: 'stadium', terminal: 'stadium',
  'fr-rect': 'subroutine', 'framed-rectangle': 'subroutine', subproc: 'subroutine', subprocess: 'subroutine',
  subroutine: 'subroutine',
  hex: 'hexagon', hexagon: 'hexagon', prepare: 'hexagon',
  'lean-r': 'parallelogram', 'lean-right': 'parallelogram', 'in-out': 'parallelogram',
  'lean-l': 'parallelogram-alt', 'lean-left': 'parallelogram-alt', 'out-in': 'parallelogram-alt',
  'trap-b': 'trapezoid', trapezoid: 'trapezoid', priority: 'trapezoid', 'trapezoid-bottom': 'trapezoid',
  tri: 'trapezoid', extract: 'trapezoid', triangle: 'trapezoid',
  'trap-t': 'trapezoid-alt', 'inv-trapezoid': 'trapezoid-alt', manual: 'trapezoid-alt', 'trapezoid-top': 'trapezoid-alt',
  'flip-tri': 'trapezoid-alt', 'flipped-triangle': 'trapezoid-alt', 'manual-file': 'trapezoid-alt',
  odd: 'asymmetric',
  person: 'person',
  fork: 'fork-bar', join: 'fork-bar',
  // Mermaid 12.3's BPMN shapes (registered, not in the docs' table yet).
  'bpmn-start': 'circle', 'bpmn-intermediate': 'double-circle', 'bpmn-boundary': 'double-circle', 'bpmn-end': 'double-circle',
  'bpmn-gateway': 'diamond', 'bpmn-activity': 'rounded-rectangle', 'bpmn-data-store': 'cylinder',
});

/** The shape Canvas draws for a Mermaid shape name (a node with an icon from a library is an icon node). */
export function mermaidShapeToCanvas(name: string, hasIcon = false): NodeShape {
  const shape = NEAREST[name] ?? 'rectangle';
  return shape === 'rectangle' && hasIcon ? 'icon' : shape;
}

/** The name written for a shape when the node's Mermaid name no longer fits it (the shape was changed). */
export const MERMAID_SHAPE_NAME: Record<NodeShape, string> = {
  rectangle: 'rect',
  'rounded-rectangle': 'rounded',
  circle: 'circle',
  diamond: 'diam',
  cylinder: 'cyl',
  person: 'person',
  icon: 'rect',
  stadium: 'stadium',
  subroutine: 'fr-rect',
  'double-circle': 'dbl-circ',
  hexagon: 'hex',
  parallelogram: 'lean-r',
  'parallelogram-alt': 'lean-l',
  trapezoid: 'trap-b',
  'trapezoid-alt': 'trap-t',
  asymmetric: 'odd',
  'state-start': 'circle',
  'state-end': 'dbl-circ',
  'fork-bar': 'fork',
};
