// canvas-4h1j: Mermaid Wardley maps (`wardley-beta`, Mermaid 11.14+; the grammar is the same from 11.15 to 12.3).
// Model (family `wardley`):
// - anchors, components and pipeline components are nodes (roles `anchor`, `component`, `pipeline-component`);
//   a name is its id, as in Mermaid, and a repeated name is one node (the later statement wins, a missing label
//   offset is kept). A pipeline component's id is `<parent>_<name>`, its label the name, its visibility the
//   parent's. Notes, annotations, accelerators and deaccelerators are nodes too (roles `note`, `annotation`,
//   `accelerator`, `deaccelerator`; generated ids that start with `~`), so they can be moved like the rest.
// - every node's `wardley` holds the coordinates as written and its markings (label offset, strategy, inertia,
//   evolve target, annotation number); `position` is the drawn centre (model/wardley-geometry.ts). A save writes
//   the coordinates back, or new ones (0-1, two decimals) for a node whose position changed.
// - a pipeline is a container (role `pipeline`, id `~pipeline:<parent>`, attached to its parent) holding its
//   components; links are edges (`e<n>`), resolved like Mermaid's resolveNodeId (an id, else a label); a link to
//   an unknown name is kept, and not drawn, as in Mermaid.
// - map settings (size, evolution stages, the annotations box) are `model.wardley`.
// As in Mermaid, statements take effect by kind (anchors, components, notes, pipelines, links, evolves, ...), not
// in text order, so the writer emits them grouped that way. Canvas reads a little more than Mermaid -- an unquoted
// name may start with a keyword (`notebook`) -- and the writer quotes every name Mermaid would misread. Unlike
// Mermaid, an `evolve` naming no component is an error (Mermaid ignores it), and it may name a pipeline
// component. No front matter is written: positions are the text's own coordinates.
import {
  createEmptyDiagramModel,
  type DiagramContainer,
  type DiagramEdge,
  type DiagramModel,
  type DiagramNode,
  type WardleyFlow,
  type WardleyLinkData,
  type WardleyStage,
  type WardleyStrategy,
} from '../model/diagram-model.js';
import { wardleyCoordinatesAt, wardleyFrame, wardleyPercent, wardleyPoint, wardleyX, wardleyY, type WardleyFrame } from '../model/wardley-geometry.js';
import { splitFrontMatter } from './front-matter.js';
import type { ParseError, ParseResult } from './types.js';

export const WARDLEY_HEADER = 'wardley-beta';

// Mermaid's terminals (wardley.langium, common.langium).
const QUOTED = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`;
const BARE = String.raw`[A-Za-z](?:[A-Za-z0-9_()&]|-(?!>))*(?:[ \t]+[A-Za-z(](?:[A-Za-z0-9_()&]|-(?!>))*)*`;
const UNDERSCORE_ID = String.raw`_(?:[-\w]*\w)?`;
const NAME = `(${QUOTED}|${BARE}|${UNDERSCORE_ID})`;
const NUM = String.raw`([0-9]+\.[0-9]+)`;
const INT = String.raw`(0|[1-9][0-9]*)`;
const NUM_OR_INT = String.raw`([0-9]+\.[0-9]+|0|[1-9][0-9]*)`;
const S = String.raw`[ \t]*`;
const PAIR = (value: string) => String.raw`\[${S}${value}${S},${S}${value}${S}\]`;
const LABEL = String.raw`(?:${S}label${S}\[${S}(-?)${S}${INT}${S},${S}(-?)${S}${INT}${S}\])?`;

const TITLE = /^title(?:[ \t]+(.*))?$/;
const ACC_TITLE = /^accTitle[ \t]*:(.*)$/;
const ACC_DESCR = /^accDescr[ \t]*:(.*)$/;
const ACC_DESCR_BLOCK = /^accDescr[ \t]*\{(.*)$/;
const CONFIG_DIRECTIVE = /^%%\{.*\}%%$/;
const SIZE = new RegExp(`^size${S}${PAIR(INT)}$`);
const EVOLUTION = /^evolution[ \t]+(.+)$/;
const STAGE = new RegExp(`^${NAME}(?:${S}@${S}${NUM})?(?:${S}/${S}${NAME})?`);
const ANCHOR = new RegExp(`^anchor[ \\t]+${NAME}${S}${PAIR(NUM)}$`);
const COMPONENT = new RegExp(
  `^component[ \\t]+${NAME}${S}${PAIR(NUM)}${LABEL}(?:${S}\\(${S}(build|buy|outsource|market)${S}\\))?(?:${S}(inertia|\\(${S}inertia${S}\\)))?$`,
);
const PIPELINE = new RegExp(`^pipeline[ \\t]+${NAME}${S}\\{$`);
const PIPELINE_COMPONENT = new RegExp(`^component[ \\t]+${NAME}${S}\\[${S}${NUM}${S}\\]${LABEL}$`);
const EVOLVE = new RegExp(`^evolve[ \\t]+${NAME}[ \\t]+${NUM}$`);
const NOTE = new RegExp(`^note${S}(${QUOTED})${S}${PAIR(NUM)}$`);
const ANNOTATIONS = new RegExp(`^annotations${S}${PAIR(NUM_OR_INT)}$`);
const ANNOTATION = new RegExp(`^annotation[ \\t]+${INT}${S},${S}${PAIR(NUM_OR_INT)}${S}(${QUOTED})$`);
const ACCELERATOR = new RegExp(`^(accelerator|deaccelerator)[ \\t]+${NAME}${S}${PAIR(NUM)}$`);
const PORT = String.raw`(\+<>|\+>|\+<)`;
const ARROW = String.raw`(->|-->|-\.->|>|\+'[^']*'(?:<>|<|>))`;
const LINK = new RegExp(`^${NAME}${S}${PORT}?${S}${ARROW}?${S}${NAME}${S}${PORT}?$`);
const BARE_NAME = new RegExp(`^(?:${BARE})$`);

/** Words Mermaid's lexer reads as a keyword at the start of an unquoted name (it checks no word boundary). */
const RESERVED_PREFIXES = [
  'wardley-beta', 'size', 'evolution', 'anchor', 'component', 'label', 'inertia', 'evolve', 'pipeline', 'note',
  'annotations', 'annotation', 'accelerator', 'deaccelerator', 'build', 'buy', 'outsource', 'market',
  'title', 'accTitle', 'accDescr',
];

type Point = { visibility: number; evolution: number };

interface ComponentStatement {
  kind: 'anchor' | 'component';
  name: string;
  point: Point;
  labelOffset?: { x: number; y: number };
  strategy?: WardleyStrategy;
  inertia?: boolean;
  line: number;
}

/** Langium's string conversion: the quotes dropped, `\x` read as the escape (or the character itself). */
function unquote(token: string): string {
  if (!(token.startsWith('"') || token.startsWith("'"))) return token;
  const escapes: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '0': '\0' };
  let out = '';
  for (let i = 1; i < token.length - 1; i += 1) {
    const c = token[i];
    if (c === '\\') {
      i += 1;
      const next = token[i];
      out += Object.prototype.hasOwnProperty.call(escapes, next) ? escapes[next] : next;
    } else {
      out += c;
    }
  }
  return out;
}

/** Splits off a link's `; label` (which runs to the end of the line, `%%` included, as in Mermaid) or a trailing
 *  `%%` comment, passing over quoted text. */
function splitLine(line: string): { code: string; label?: string } {
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      // A quote that opens a flow label (+'text'>) is not a string.
      if (c === "'" && line[i - 1] === '+') {
        const close = line.indexOf("'", i + 1);
        if (close !== -1) {
          i = close;
          continue;
        }
      }
      quote = c;
      continue;
    }
    if (c === ';') return { code: line.slice(0, i).trim(), label: line.slice(i + 1).trim() };
    if (c === '%' && line[i + 1] === '%') return { code: line.slice(0, i).trim() };
  }
  return { code: line.trim() };
}

const number = (text: string) => Number(text);
const offset = (negative: string | undefined, value: string) => (negative ? -1 : 1) * Number(value);

/** Mermaid's range check after toPercent (0-1 or up to 100). */
function outOfRange(value: number): boolean {
  const percent = wardleyPercent(value);
  return percent < 0 || percent > 100;
}

export function parseWardley(dsl: string): ParseResult {
  const { frontMatter, body } = splitFrontMatter(dsl);
  const lines = body.split(/\r?\n/);
  const errors: ParseError[] = [];
  const fail = (index: number, message: string) => errors.push({ line: index + 1, content: lines[index], message });

  let headerSeen = false;
  let title = typeof (frontMatter as Record<string, unknown>).title === 'string' ? ((frontMatter as Record<string, unknown>).title as string) : undefined;
  let accTitle: string | undefined;
  let accDescr: string | undefined;
  let mermaidConfigDirective: string | undefined;
  let size: { width: number; height: number } | undefined;
  let stages: WardleyStage[] | undefined;
  const components: ComponentStatement[] = [];
  const notes: { text: string; point: Point }[] = [];
  const pipelines: { parent: string; line: number; children: { name: string; evolution: number; labelOffset?: { x: number; y: number } }[] }[] = [];
  const links: { from: string; to: string; label?: string; data: WardleyLinkData }[] = [];
  const evolves: { name: string; target: number; line: number }[] = [];
  let annotationsBox: Point | undefined;
  const annotations: { number: number; point: Point; text: string }[] = [];
  const accelerators: { kind: 'accelerator' | 'deaccelerator'; name: string; point: Point }[] = [];
  let openPipeline: (typeof pipelines)[number] | undefined;
  let openAccDescr: string[] | undefined;

  const checkPoint = (index: number, what: string, point: Point): boolean => {
    for (const [axis, value] of [['visibility', point.visibility], ['evolution', point.evolution]] as const) {
      if (outOfRange(value)) {
        fail(index, `${what} ${axis} must be between 0-1 (decimal) or 0-100 (percentage). Received: ${value}`);
        return false;
      }
    }
    return true;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (openAccDescr) {
      const close = trimmed.indexOf('}');
      if (close === -1) {
        openAccDescr.push(trimmed);
        continue;
      }
      openAccDescr.push(trimmed.slice(0, close));
      accDescr = openAccDescr.join('\n').trim();
      openAccDescr = undefined;
      if (trimmed.slice(close + 1).trim()) fail(i, 'Nothing may follow the "}" of an accDescr block');
      continue;
    }
    if (!trimmed) continue;
    if (CONFIG_DIRECTIVE.test(trimmed)) {
      mermaidConfigDirective = trimmed;
      continue;
    }
    if (trimmed.startsWith('%%')) {
      if (!headerSeen) fail(i, `Expected "${WARDLEY_HEADER}" header line`);
      continue;
    }
    if (!headerSeen) {
      if (trimmed.replace(/[ \t]*%%.*$/, '') === WARDLEY_HEADER) headerSeen = true;
      else fail(i, `Expected "${WARDLEY_HEADER}" header line`);
      continue;
    }

    let m: RegExpMatchArray | null;
    // Title and accessibility lines run to the end (or to a `%%`), as in Mermaid.
    const uncommented = trimmed.replace(/[ \t]*%%.*$/, '');
    if ((m = uncommented.match(TITLE))) {
      title = (m[1] ?? '').trim() || undefined;
      continue;
    }
    if ((m = uncommented.match(ACC_TITLE))) {
      accTitle = m[1].trim() || undefined;
      continue;
    }
    if ((m = trimmed.match(ACC_DESCR_BLOCK))) {
      const rest = m[1];
      const close = rest.indexOf('}');
      if (close === -1) {
        openAccDescr = rest.trim() ? [rest.trim()] : [];
      } else {
        accDescr = rest.slice(0, close).trim() || undefined;
      }
      continue;
    }
    if ((m = uncommented.match(ACC_DESCR))) {
      accDescr = m[1].trim() || undefined;
      continue;
    }

    const { code, label } = splitLine(trimmed);
    if (!code) continue;

    if (openPipeline) {
      if (code === '}' && label === undefined) {
        if (openPipeline.children.length === 0) fail(i, `Pipeline "${openPipeline.parent}" needs at least one component`);
        openPipeline = undefined;
        continue;
      }
      if (label === undefined && (m = code.match(PIPELINE_COMPONENT))) {
        const evolution = number(m[2]);
        if (outOfRange(evolution)) {
          fail(i, `Pipeline component "${unquote(m[1])}" evolution must be between 0-1 (decimal) or 0-100 (percentage). Received: ${evolution}`);
          continue;
        }
        openPipeline.children.push({
          name: unquote(m[1]),
          evolution,
          ...(m[4] !== undefined ? { labelOffset: { x: offset(m[3], m[4]), y: offset(m[5], m[6]) } } : {}),
        });
        continue;
      }
      fail(i, `Expected "component Name [evolution]" or "}" inside pipeline "${openPipeline.parent}": "${code}"`);
      continue;
    }

    if (label === undefined) {
      if ((m = code.match(SIZE))) {
        size = { width: number(m[1]), height: number(m[2]) };
        continue;
      }
      if ((m = code.match(EVOLUTION))) {
        const parsed = readStages(m[1]);
        if (typeof parsed === 'string') fail(i, parsed);
        else stages = parsed;
        continue;
      }
      if ((m = code.match(ANCHOR))) {
        const point = { visibility: number(m[2]), evolution: number(m[3]) };
        if (checkPoint(i, `Anchor "${unquote(m[1])}"`, point)) components.push({ kind: 'anchor', name: unquote(m[1]), point, line: i });
        continue;
      }
      if ((m = code.match(COMPONENT))) {
        const point = { visibility: number(m[2]), evolution: number(m[3]) };
        if (!checkPoint(i, `Component "${unquote(m[1])}"`, point)) continue;
        components.push({
          kind: 'component',
          name: unquote(m[1]),
          point,
          ...(m[5] !== undefined ? { labelOffset: { x: offset(m[4], m[5]), y: offset(m[6], m[7]) } } : {}),
          ...(m[8] ? { strategy: m[8] as WardleyStrategy } : {}),
          ...(m[9] ? { inertia: true } : {}),
          line: i,
        });
        continue;
      }
      if ((m = code.match(PIPELINE))) {
        openPipeline = { parent: unquote(m[1]), line: i, children: [] };
        pipelines.push(openPipeline);
        continue;
      }
      if ((m = code.match(EVOLVE))) {
        const target = number(m[2]);
        if (outOfRange(target)) fail(i, `Evolve target for "${unquote(m[1])}" must be between 0-1 (decimal) or 0-100 (percentage). Received: ${target}`);
        else evolves.push({ name: unquote(m[1]), target, line: i });
        continue;
      }
      if ((m = code.match(NOTE))) {
        const point = { visibility: number(m[2]), evolution: number(m[3]) };
        if (checkPoint(i, `Note "${unquote(m[1])}"`, point)) notes.push({ text: unquote(m[1]), point });
        continue;
      }
      if ((m = code.match(ANNOTATIONS))) {
        const point = { visibility: number(m[1]), evolution: number(m[2]) };
        if (checkPoint(i, 'Annotations box', point) && !annotationsBox) annotationsBox = point;
        continue;
      }
      if ((m = code.match(ANNOTATION))) {
        const point = { visibility: number(m[2]), evolution: number(m[3]) };
        if (checkPoint(i, `Annotation ${m[1]}`, point)) annotations.push({ number: number(m[1]), point, text: unquote(m[4]) });
        continue;
      }
      if ((m = code.match(ACCELERATOR))) {
        const kind = m[1] as 'accelerator' | 'deaccelerator';
        const point = { visibility: number(m[3]), evolution: number(m[4]) };
        const what = `${kind === 'accelerator' ? 'Accelerator' : 'Deaccelerator'} "${unquote(m[2])}"`;
        if (checkPoint(i, what, point)) accelerators.push({ kind, name: unquote(m[2]), point });
        continue;
      }
    }
    if ((m = code.match(LINK))) {
      const [, fromToken, fromPort, arrowToken, toToken, toPort] = m;
      // With nothing between them, two unquoted names are one name to Mermaid ("A B"), so not a link.
      if (!arrowToken && !fromPort && isBareToken(fromToken) && isBareToken(toToken)) {
        fail(i, `Could not read "${code}" as a link: put an arrow (->) between the names, or quote them`);
        continue;
      }
      const data: WardleyLinkData = {};
      if (fromPort) data.fromPort = fromPort as WardleyFlow;
      if (arrowToken) {
        const flow = arrowToken.match(/^\+'([^']*)'(<>|<|>)$/);
        if (flow) data.flowArrow = { label: flow[1], flow: `+${flow[2]}` as WardleyFlow };
        else data.arrow = arrowToken as WardleyLinkData['arrow'];
      }
      if (toPort) data.toPort = toPort as WardleyFlow;
      links.push({ from: unquote(fromToken), to: unquote(toToken), ...(label ? { label } : {}), data });
      continue;
    }
    if (/^(?:anchor|component|note|annotations?|accelerator|deaccelerator|evolve)\b/.test(code) && /(?:^|[^0-9.])(?:\.[0-9]|[0-9]+(?![0-9.]))/.test(code.replace(/label[ \t]*\[[^\]]*\]/, '').replace(/^annotation[ \t]+[0-9]+/, ''))) {
      fail(i, `Could not interpret line as a Wardley map statement: "${trimmed}" (coordinates are written as decimals, such as 0.5 or 1.0)`);
      continue;
    }
    fail(i, `Could not interpret line as a Wardley map statement: "${trimmed}"`);
  }
  if (openPipeline) fail(openPipeline.line, `Pipeline "${openPipeline.parent}" is missing its closing "}"`);
  if (openAccDescr) errors.push({ line: lines.length, content: '', message: 'An accDescr block is missing its closing "}"' });
  if (!headerSeen && errors.length === 0) errors.push({ line: 1, content: lines[0] ?? '', message: `Expected "${WARDLEY_HEADER}" header line` });
  if (errors.length > 0) return { errors };

  const model = createEmptyDiagramModel('wardley');
  model.title = title;
  model.accTitle = accTitle;
  model.accDescr = accDescr;
  model.mermaidConfigDirective = mermaidConfigDirective;
  const settings: NonNullable<DiagramModel['wardley']> = {};
  if (size) settings.size = size;
  if (stages) settings.stages = stages;
  if (annotationsBox) settings.annotationsBox = annotationsBox;
  if (Object.keys(settings).length > 0) model.wardley = settings;
  const frame = wardleyFrame(model);

  // Mermaid's node map: anchors, then components, then pipeline components; a repeated id merges.
  const nodes = new Map<string, DiagramNode>();
  const addNode = (id: string, label: string, role: string, data: NonNullable<DiagramNode['wardley']>) => {
    const existing = nodes.get(id);
    const node: DiagramNode = {
      id,
      label,
      shape: 'circle',
      role,
      position: wardleyPoint(frame, data),
      wardley: { ...data, ...(data.labelOffset === undefined && existing?.wardley?.labelOffset ? { labelOffset: existing.wardley.labelOffset } : {}) },
    };
    nodes.set(id, node);
    return node;
  };
  for (const statement of [...components.filter((c) => c.kind === 'anchor'), ...components.filter((c) => c.kind === 'component')]) {
    addNode(statement.name, statement.name, statement.kind, {
      ...statement.point,
      ...(statement.labelOffset ? { labelOffset: statement.labelOffset } : {}),
      ...(statement.strategy ? { strategy: statement.strategy } : {}),
      ...(statement.inertia ? { inertia: true } : {}),
    });
  }
  const containers: DiagramContainer[] = [];
  const piped = new Set<string>();
  for (const pipeline of pipelines) {
    const parent = nodes.get(pipeline.parent);
    if (!parent) {
      return { errors: [{ line: pipeline.line + 1, content: lines[pipeline.line], message: `Pipeline "${pipeline.parent}" must reference an existing component with coordinates.` }] };
    }
    if (piped.has(parent.id)) {
      return { errors: [{ line: pipeline.line + 1, content: lines[pipeline.line], message: `Component "${pipeline.parent}" already has a pipeline` }] };
    }
    piped.add(parent.id);
    const containerId = uniqueId(`~pipeline:${parent.id}`, nodes, containers);
    for (const child of pipeline.children) {
      const node = addNode(`${parent.id}_${child.name}`, child.name, 'pipeline-component', {
        visibility: parent.wardley!.visibility,
        evolution: child.evolution,
        ...(child.labelOffset ? { labelOffset: child.labelOffset } : {}),
      });
      node.containerId = containerId;
    }
    containers.push({ id: containerId, label: '', role: 'pipeline', attachedNodeIds: [parent.id], position: { x: 0, y: 0 } });
  }
  const resolve = (name: string): string => {
    if (nodes.has(name)) return name;
    for (const [id, node] of nodes) if (node.label === name) return id;
    return name;
  };
  const edges: DiagramEdge[] = links.map((link, index) => ({
    id: `e${index + 1}`,
    sourceId: resolve(link.from),
    targetId: resolve(link.to),
    ...(link.label ? { label: link.label } : {}),
    ...(link.data.arrow === '-.->' ? { lineStyle: 'dotted' as const } : {}),
    wardley: link.data,
  }));
  for (const evolve of evolves) {
    const node = nodes.get(resolve(evolve.name));
    if (!node) {
      return { errors: [{ line: evolve.line + 1, content: lines[evolve.line], message: `evolve: there is no component named "${evolve.name}"` }] };
    }
    node.wardley!.evolve = evolve.target;
  }
  const extra: DiagramNode[] = [];
  const addExtra = (base: string, role: string, label: string, data: NonNullable<DiagramNode['wardley']>) => {
    const id = uniqueId(base, nodes, containers, extra);
    extra.push({ id, label, shape: role === 'annotation' ? 'circle' : 'rectangle', role, position: wardleyPoint(frame, data), wardley: data });
  };
  notes.forEach((note, index) => addExtra(`~note${index + 1}`, 'note', note.text, { ...note.point }));
  annotations.forEach((annotation, index) => addExtra(`~annotation${index + 1}`, 'annotation', annotation.text, { ...annotation.point, number: annotation.number }));
  let accelerated = 0;
  let decelerated = 0;
  for (const item of accelerators) {
    const n = item.kind === 'accelerator' ? (accelerated += 1) : (decelerated += 1);
    addExtra(`~${item.kind}${n}`, item.kind, item.name, { ...item.point });
  }

  model.nodes = [...nodes.values(), ...extra];
  model.edges = edges;
  model.containers = containers;
  layOutPipelines(model, frame);
  return { model };
}

function uniqueId(base: string, ...taken: Array<Map<string, unknown> | { id: string }[]>): string {
  const used = (id: string) => taken.some((t) => (t instanceof Map ? t.has(id) : t.some((x) => x.id === id)));
  let id = base;
  for (let n = 2; used(id); n += 1) id = `${base}~${n}`;
  return id;
}

function isBareToken(token: string): boolean {
  return !(token.startsWith('"') || token.startsWith("'"));
}

function readStages(text: string): WardleyStage[] | string {
  const stages: WardleyStage[] = [];
  let rest = text;
  for (;;) {
    const m = rest.match(STAGE);
    if (!m) return `Could not read the evolution stage "${rest}"`;
    stages.push({
      name: unquote(m[1]).trim(),
      ...(m[2] !== undefined ? { boundary: Number(m[2]) } : {}),
      ...(m[3] !== undefined ? { secondName: unquote(m[3]).trim() } : {}),
    });
    rest = rest.slice(m[0].length).trimStart();
    if (!rest) break;
    if (!rest.startsWith('->')) return `Expected "->" between evolution stages, at "${rest}"`;
    rest = rest.slice(2).trimStart();
  }
  if (stages.length < 2) return 'An evolution needs at least two stages ("A -> B")';
  return stages;
}

/** A pipeline's box and the place its parent is drawn (Mermaid moves the parent onto the box's top edge). */
export function wardleyPipelineBox(model: DiagramModel, container: DiagramContainer, _frame: WardleyFrame = wardleyFrame(model)): {
  x: number;
  y: number;
  width: number;
  height: number;
  parent: { x: number; y: number };
} | undefined {
  const children = model.nodes.filter((n) => n.containerId === container.id);
  if (children.length === 0) return undefined;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const child of children) {
    minX = Math.min(minX, child.position.x);
    maxX = Math.max(maxX, child.position.x);
  }
  const y = children[children.length - 1].position.y;
  const height = 6 * 4;
  const top = y - height / 2;
  return { x: minX - 15, y: top, width: maxX - minX + 30, height, parent: { x: (minX + maxX) / 2, y: top - (6 * 1.6) / 6 } };
}

/** Each pipeline container's box, from its components' positions. */
export function layOutPipelines(model: DiagramModel, frame: WardleyFrame = wardleyFrame(model)): void {
  for (const container of model.containers) {
    if (container.role !== 'pipeline') continue;
    const box = wardleyPipelineBox(model, container, frame);
    if (!box) continue;
    container.position = { x: box.x, y: box.y };
    container.size = { width: box.width, height: box.height };
  }
}

/** A decimal as wardley-beta writes coordinates (`0.5`, `1.0`; never an exponent). */
export function wardleyNumber(value: number): string {
  let text = String(value);
  if (/e/i.test(text)) text = value.toFixed(20).replace(/0+$/, '');
  if (!text.includes('.')) text += '.0';
  if (text.endsWith('.')) text += '0';
  return text;
}

/** A name as Mermaid reads it: unquoted when it can be, else in double quotes. */
export function wardleyName(name: string): string {
  const bare = BARE_NAME.test(name) && !RESERVED_PREFIXES.some((word) => name.startsWith(word));
  if (bare) return name;
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

function quotedText(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

/** The coordinates a save writes for a node: as written, unless it was moved. */
function savedPoint(node: DiagramNode, frame: WardleyFrame): Point {
  const data = node.wardley;
  if (data && Number.isFinite(data.visibility) && Number.isFinite(data.evolution)) {
    const drawn = wardleyPoint(frame, data);
    if (Math.abs(drawn.x - node.position.x) < 1e-6 && Math.abs(drawn.y - node.position.y) < 1e-6) return { visibility: data.visibility, evolution: data.evolution };
  }
  return wardleyCoordinatesAt(frame, node.position);
}

/** A pipeline component's evolution: as written, unless it was moved along the axis. */
function savedEvolution(node: DiagramNode, frame: WardleyFrame): number {
  const data = node.wardley;
  if (data && Number.isFinite(data.evolution) && Math.abs(wardleyX(frame, data.evolution) - node.position.x) < 1e-6) return data.evolution;
  return wardleyCoordinatesAt(frame, node.position).evolution;
}

const pair = (point: Point) => `[${wardleyNumber(point.visibility)}, ${wardleyNumber(point.evolution)}]`;
const labelPart = (labelOffset: { x: number; y: number } | undefined) =>
  labelOffset ? ` label [${Math.round(labelOffset.x)}, ${Math.round(labelOffset.y)}]` : '';

export function serializeWardley(model: DiagramModel): string {
  const frame = wardleyFrame(model);
  const lines: string[] = [];
  if (model.mermaidConfigDirective) lines.push(model.mermaidConfigDirective);
  lines.push(WARDLEY_HEADER);
  const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ').trim();
  if (model.title && oneLine(model.title)) lines.push(`title ${oneLine(model.title)}`);
  if (model.accTitle && oneLine(model.accTitle)) lines.push(`accTitle: ${oneLine(model.accTitle)}`);
  if (model.accDescr) {
    if (/[\r\n]/.test(model.accDescr)) lines.push('accDescr {', ...model.accDescr.split(/\r?\n/).map((l) => `  ${l.replace(/}/g, ')')}`.trimEnd()), '}');
    else lines.push(`accDescr: ${model.accDescr.trim()}`);
  }
  const settings = model.wardley;
  if (settings?.size) lines.push(`size [${Math.round(settings.size.width)}, ${Math.round(settings.size.height)}]`);
  if (settings?.stages && settings.stages.length >= 2) {
    const stage = (s: WardleyStage) =>
      `${wardleyName(s.name)}${s.boundary !== undefined ? `@${wardleyNumber(s.boundary)}` : ''}${s.secondName ? ` / ${wardleyName(s.secondName)}` : ''}`;
    lines.push(`evolution ${settings.stages.map(stage).join(' -> ')}`);
  }

  const sections: string[][] = [];
  const pipelineIds = new Set(model.containers.filter((c) => c.role === 'pipeline').map((c) => c.id));
  const inPipeline = (node: DiagramNode) => node.containerId !== undefined && pipelineIds.has(node.containerId);
  const OTHER_ROLES = new Set(['note', 'annotation', 'accelerator', 'deaccelerator']);
  const mapNodes = model.nodes.filter((n) => !inPipeline(n) && !OTHER_ROLES.has(n.role ?? ''));
  const nodesById = new Map(model.nodes.map((n) => [n.id, n]));

  sections.push(mapNodes.filter((n) => n.role === 'anchor').map((n) => `anchor ${wardleyName(n.label)} ${pair(savedPoint(n, frame))}`));
  sections.push(
    mapNodes
      .filter((n) => n.role !== 'anchor')
      .map((n) => {
        const data = n.wardley;
        const strategy = data?.strategy ? ` (${data.strategy})` : '';
        return `component ${wardleyName(n.label)} ${pair(savedPoint(n, frame))}${labelPart(data?.labelOffset)}${strategy}${data?.inertia ? ' (inertia)' : ''}`;
      }),
  );
  const pipelineLines: string[] = [];
  for (const container of model.containers) {
    if (container.role !== 'pipeline') continue;
    const parent = nodesById.get(container.attachedNodeIds?.[0] ?? '');
    const children = model.nodes.filter((n) => n.containerId === container.id);
    if (!parent || children.length === 0) continue;
    pipelineLines.push(`pipeline ${wardleyName(parent.label)} {`);
    for (const child of children) {
      pipelineLines.push(`  component ${wardleyName(child.label)} [${wardleyNumber(savedEvolution(child, frame))}]${labelPart(child.wardley?.labelOffset)}`);
    }
    pipelineLines.push('}');
  }
  sections.push(pipelineLines);
  sections.push(model.edges.map((edge) => linkLine(edge, nodesById)));
  sections.push(
    model.nodes
      .filter((n) => n.wardley?.evolve !== undefined && Number.isFinite(n.wardley.evolve) && !OTHER_ROLES.has(n.role ?? ''))
      .map((n) => `evolve ${wardleyName(n.label)} ${wardleyNumber(n.wardley!.evolve!)}`),
  );
  sections.push(model.nodes.filter((n) => n.role === 'note').map((n) => `note ${quotedText(n.label)} ${pair(savedPoint(n, frame))}`));
  const annotationLines: string[] = [];
  if (settings?.annotationsBox) annotationLines.push(`annotations ${pair(settings.annotationsBox)}`);
  for (const n of model.nodes.filter((node) => node.role === 'annotation')) {
    const index = Math.max(0, Math.round(n.wardley?.number ?? 1));
    annotationLines.push(`annotation ${index},${pair(savedPoint(n, frame))} ${quotedText(n.label)}`);
  }
  sections.push(annotationLines);
  sections.push(
    model.nodes
      .filter((n) => n.role === 'accelerator' || n.role === 'deaccelerator')
      .map((n) => `${n.role} ${wardleyName(n.label)} ${pair(savedPoint(n, frame))}`),
  );
  for (const section of sections) {
    if (section.length === 0) continue;
    lines.push('', ...section);
  }
  return `${lines.join('\n')}\n`;
}

function linkLine(edge: DiagramEdge, nodesById: Map<string, DiagramNode>): string {
  const name = (id: string) => nodesById.get(id)?.label ?? id;
  const data = edge.wardley;
  let arrow: string | undefined = data ? data.arrow : '->';
  let flowArrow = data?.flowArrow;
  if (edge.lineStyle === 'dotted') {
    arrow = '-.->';
    flowArrow = undefined;
  } else if (arrow === '-.->') {
    arrow = '->';
  }
  const arrowText = flowArrow ? `+'${flowArrow.label.replace(/'/g, '’').replace(/[\r\n]+/g, ' ')}'${flowArrow.flow.slice(1)}` : arrow;
  const from = wardleyName(name(edge.sourceId));
  const to = wardleyName(name(edge.targetId));
  // With no arrow, two unquoted names would read as one: quote them.
  const quote = (text: string) => (text.startsWith('"') ? text : quotedText(text));
  const [fromText, toText] = arrowText || data?.fromPort ? [from, to] : [quote(from), quote(to)];
  const parts = [fromText];
  if (data?.fromPort) parts.push(data.fromPort);
  if (arrowText) parts.push(arrowText);
  parts.push(toText);
  if (data?.toPort) parts.push(data.toPort);
  const label = edge.label?.replace(/[\r\n]+/g, ' ').trim();
  return `${parts.join(' ')}${label ? `; ${label}` : ''}`;
}

/** Positions for every node from its coordinates (after a change to the map's size, say). */
export function wardleyPositionsFromCoordinates(model: DiagramModel): DiagramModel {
  const frame = wardleyFrame(model);
  const parents = new Map(model.containers.filter((c) => c.role === 'pipeline').map((c) => [c.id, c.attachedNodeIds?.[0]]));
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const next: DiagramModel = {
    ...model,
    nodes: model.nodes.map((n) => {
      if (!n.wardley) return n;
      const parent = n.containerId ? byId.get(parents.get(n.containerId) ?? '') : undefined;
      const visibility = parent?.wardley ? parent.wardley.visibility : n.wardley.visibility;
      return { ...n, position: { x: wardleyX(frame, n.wardley.evolution), y: wardleyY(frame, visibility) } };
    }),
    containers: model.containers.map((c) => ({ ...c })),
  };
  layOutPipelines(next, frame);
  return next;
}
