// canvas-4h1j.2: edits to a Wardley map (family `wardley`), shared by the editor and, in Python
// (diagram_core/wardley_ops.py, identical), the AI chat. Coordinates are [visibility, evolution]; a moved element
// gets 0-1 values to two decimals, kept inside the map (what a save writes for a moved element anyway, so the
// editor shows what the text will say). A pipeline component keeps its parent's visibility; moving a pipeline's
// parent carries its pipeline along. Names must stay distinct: in Mermaid two components with one name are one
// component.
import type { DiagramContainer, DiagramModel, DiagramNode, WardleyFlow, WardleyNodeData, WardleyStrategy } from './diagram-model.js';
import { wardleyCoordinatesAt, wardleyFrame, wardleyPoint } from './wardley-geometry.js';
import { layOutPipelines } from '../dsl/wardley.js';

function generateId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export type WardleyElementKind = 'anchor' | 'component' | 'note' | 'annotation' | 'accelerator' | 'deaccelerator';
export const WARDLEY_ELEMENT_KINDS: readonly WardleyElementKind[] = ['anchor', 'component', 'note', 'annotation', 'accelerator', 'deaccelerator'];
export const WARDLEY_STRATEGIES: readonly WardleyStrategy[] = ['build', 'buy', 'outsource', 'market'];
export const WARDLEY_FLOWS: readonly WardleyFlow[] = ['+>', '+<', '+<>'];

const DEFAULT_LABELS: Record<WardleyElementKind, string> = {
  anchor: 'New Anchor',
  component: 'New Component',
  note: 'New note',
  annotation: 'New annotation',
  accelerator: 'Accelerator',
  deaccelerator: 'Deaccelerator',
};
const NAMED_ROLES = new Set(['anchor', 'component']);

/** A coordinate as a move writes it: 0-1, two decimals. */
function fraction(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}

const isPipelineContainer = (model: DiagramModel, id: string | undefined) =>
  id !== undefined && model.containers.some((c) => c.id === id && c.role === 'pipeline');

/** The names Mermaid keys anchors and components by (pipeline components are keyed by their parent). */
function mapNames(model: DiagramModel, exceptId?: string): Set<string> {
  return new Set(
    model.nodes
      .filter((n) => n.id !== exceptId && (n.role === undefined || NAMED_ROLES.has(n.role)) && !isPipelineContainer(model, n.containerId))
      .map((n) => n.label),
  );
}

/** `label`, or `label 2`, `label 3`... when it's taken. */
function freeName(label: string, taken: Set<string>): string {
  if (!taken.has(label)) return label;
  let n = 2;
  while (taken.has(`${label} ${n}`)) n += 1;
  return `${label} ${n}`;
}

/** Whether `label` would give a node a name another anchor or component (or, for a pipeline component, another
 *  component of its pipeline) already has: Mermaid would read the two as one. */
export function wardleyNameTaken(model: DiagramModel, nodeId: string, label: string): boolean {
  const node = model.nodes.find((n) => n.id === nodeId);
  if (!node) return false;
  if (isPipelineContainer(model, node.containerId)) {
    return model.nodes.some((n) => n.id !== nodeId && n.containerId === node.containerId && n.label === label);
  }
  if (node.role !== undefined && !NAMED_ROLES.has(node.role)) return false;
  return mapNames(model, nodeId).has(label);
}

export interface AddWardleyElementInput {
  kind: WardleyElementKind;
  label?: string;
  visibility?: number;
  evolution?: number;
  /** Annotations only: the number drawn in the circle (default: one more than the highest). */
  number?: number;
}

/** Adds an anchor, component, note, annotation, accelerator or deaccelerator. Without coordinates it goes on a
 *  grid that steps with the number of elements, so new ones don't land on each other. An anchor's or component's
 *  name is made distinct (`New Component 2`). */
export function addWardleyElement(model: DiagramModel, input: AddWardleyElementInput): DiagramModel {
  const { kind } = input;
  if (!WARDLEY_ELEMENT_KINDS.includes(kind)) throw new Error(`addWardleyElement: unknown kind "${String(kind)}"`);
  const count = model.nodes.length;
  const point = {
    visibility: input.visibility !== undefined ? fraction(input.visibility) : fraction(0.85 - (Math.floor(count / 7) % 8) * 0.1),
    evolution: input.evolution !== undefined ? fraction(input.evolution) : fraction(0.15 + (count % 7) * 0.1),
  };
  let label = input.label ?? DEFAULT_LABELS[kind];
  if (label.trim() === '') throw new Error('addWardleyElement: the name must not be empty');
  if (NAMED_ROLES.has(kind)) label = freeName(label, mapNames(model));
  const data: WardleyNodeData = { ...point };
  if (kind === 'annotation') {
    const numbers = model.nodes.filter((n) => n.role === 'annotation').map((n) => n.wardley?.number ?? 0);
    data.number = input.number !== undefined ? Math.max(0, Math.round(input.number)) : numbers.reduce((a, b) => Math.max(a, b), 0) + 1;
  }
  const node: DiagramNode = {
    id: generateId('w'),
    label,
    shape: kind === 'note' || kind === 'accelerator' || kind === 'deaccelerator' ? 'rectangle' : 'circle',
    role: kind,
    position: wardleyPoint(wardleyFrame(model), point),
    wardley: data,
  };
  return { ...model, nodes: [...model.nodes, node] };
}

/** Moves an element to [visibility, evolution] (0-1, two decimals, kept inside the map). A pipeline component
 *  moves along the evolution axis only; a pipeline's parent takes its pipeline with it. */
export function moveWardleyElement(model: DiagramModel, nodeId: string, point: { visibility: number; evolution: number }): DiagramModel {
  const node = model.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`moveWardleyElement: there is no element "${nodeId}"`);
  const frame = wardleyFrame(model);
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const pipelineOf = new Map(model.containers.filter((c) => c.role === 'pipeline').map((c) => [c.id, c]));
  const moved = new Map<string, WardleyNodeData>();
  const ownPipeline = node.containerId !== undefined ? pipelineOf.get(node.containerId) : undefined;
  if (ownPipeline) {
    const parent = byId.get(ownPipeline.attachedNodeIds?.[0] ?? '');
    const visibility = parent?.wardley?.visibility ?? node.wardley?.visibility ?? 0;
    moved.set(node.id, { ...(node.wardley ?? { visibility }), visibility, evolution: fraction(point.evolution) });
  } else {
    const target = { visibility: fraction(point.visibility), evolution: fraction(point.evolution) };
    moved.set(node.id, { ...(node.wardley ?? target), ...target });
    const dx = wardleyPoint(frame, target).x - node.position.x;
    for (const pipeline of pipelineOf.values()) {
      if (pipeline.attachedNodeIds?.[0] !== node.id) continue;
      for (const child of model.nodes) {
        if (child.containerId !== pipeline.id) continue;
        const evolution = wardleyCoordinatesAt(frame, { x: child.position.x + dx, y: child.position.y }).evolution;
        moved.set(child.id, { ...(child.wardley ?? target), visibility: target.visibility, evolution });
      }
    }
  }
  const next: DiagramModel = {
    ...model,
    nodes: model.nodes.map((n) => {
      const data = moved.get(n.id);
      return data ? { ...n, position: wardleyPoint(frame, data), wardley: data } : n;
    }),
    containers: model.containers.map((c) => ({ ...c })),
  };
  layOutPipelines(next, frame);
  return next;
}

export interface WardleyMarkingsPatch {
  /** null clears it. */
  strategy?: WardleyStrategy | null;
  inertia?: boolean;
  /** Where the component is heading on the evolution axis (0-1); null clears it. */
  evolve?: number | null;
}

/** Sets or clears a component's strategy, inertia and evolve arrow (a pipeline component's evolve arrow only).
 *  Only the fields given change. */
export function setWardleyMarkings(model: DiagramModel, nodeId: string, patch: WardleyMarkingsPatch): DiagramModel {
  const node = model.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`setWardleyMarkings: there is no element "${nodeId}"`);
  if (node.role !== undefined && node.role !== 'component' && node.role !== 'pipeline-component') {
    throw new Error('setWardleyMarkings: only a component has a strategy, inertia or an evolve arrow');
  }
  // A pipeline's `component Name [evolution]` line has no room for them (an evolve line names any component).
  if (node.role === 'pipeline-component' && (patch.strategy !== undefined || patch.inertia !== undefined)) {
    throw new Error('setWardleyMarkings: a pipeline component has no strategy or inertia, only an evolve arrow');
  }
  if (patch.strategy && !WARDLEY_STRATEGIES.includes(patch.strategy)) throw new Error(`setWardleyMarkings: unknown strategy "${String(patch.strategy)}"`);
  if (patch.evolve !== undefined && patch.evolve !== null && !Number.isFinite(patch.evolve)) throw new Error('setWardleyMarkings: evolve must be a number');
  const data: WardleyNodeData = { ...(node.wardley ?? wardleyCoordinatesAt(wardleyFrame(model), node.position)) };
  if (patch.strategy !== undefined) {
    if (patch.strategy === null) delete data.strategy;
    else data.strategy = patch.strategy;
  }
  if (patch.inertia !== undefined) {
    if (patch.inertia) data.inertia = true;
    else delete data.inertia;
  }
  if (patch.evolve !== undefined) {
    if (patch.evolve === null) delete data.evolve;
    else data.evolve = fraction(patch.evolve);
  }
  return { ...model, nodes: model.nodes.map((n) => (n.id === nodeId ? { ...n, wardley: data } : n)) };
}

/** Adds a component to a component's pipeline (making the pipeline when it has none). It sits at the parent's
 *  visibility; without an evolution it goes just right of the pipeline's last component. */
export function addWardleyPipelineComponent(model: DiagramModel, parentId: string, input: { label?: string; evolution?: number } = {}): DiagramModel {
  const parent = model.nodes.find((n) => n.id === parentId);
  if (!parent) throw new Error(`addWardleyPipelineComponent: there is no component "${parentId}"`);
  if ((parent.role !== undefined && parent.role !== 'component') || isPipelineContainer(model, parent.containerId)) {
    throw new Error('addWardleyPipelineComponent: only a component (not an anchor, note or pipeline component) can have a pipeline');
  }
  const frame = wardleyFrame(model);
  const parentPoint = parent.wardley ?? wardleyCoordinatesAt(frame, parent.position);
  let containers = model.containers.map((c) => ({ ...c }));
  let pipeline = containers.find((c) => c.role === 'pipeline' && c.attachedNodeIds?.[0] === parentId);
  if (!pipeline) {
    const taken = new Set([...model.nodes.map((n) => n.id), ...model.containers.map((c) => c.id)]);
    let id = `~pipeline:${parentId}`;
    for (let n = 2; taken.has(id); n += 1) id = `~pipeline:${parentId}~${n}`;
    const created: DiagramContainer = { id, label: '', role: 'pipeline', attachedNodeIds: [parentId], position: { x: 0, y: 0 } };
    pipeline = created;
    containers = [...containers, created];
  }
  const pipelineId = pipeline.id;
  const children = model.nodes.filter((n) => n.containerId === pipelineId);
  const last = children.reduce((a, n) => Math.max(a, wardleyCoordinatesAt(frame, n.position).evolution), -1);
  const evolution = fraction(input.evolution ?? (last < 0 ? parentPoint.evolution : last + 0.1));
  const label = input.label ?? freeName(DEFAULT_LABELS.component, new Set(children.map((n) => n.label)));
  if (label.trim() === '') throw new Error('addWardleyPipelineComponent: the name must not be empty');
  if (children.some((n) => n.label === label)) throw new Error(`addWardleyPipelineComponent: the pipeline already has a component named "${label}"`);
  const data: WardleyNodeData = { visibility: parentPoint.visibility, evolution };
  const node: DiagramNode = {
    id: generateId('w'),
    label,
    shape: 'circle',
    role: 'pipeline-component',
    position: wardleyPoint(frame, data),
    wardley: data,
    containerId: pipelineId,
  };
  const next: DiagramModel = { ...model, nodes: [...model.nodes, node], containers };
  layOutPipelines(next, frame);
  return next;
}

/** Removes an element and its links. Removing a pipeline's parent removes the pipeline and its components;
 *  removing a pipeline's last component removes the pipeline. */
export function removeWardleyElement(model: DiagramModel, nodeId: string): DiagramModel {
  if (!model.nodes.some((n) => n.id === nodeId)) return model;
  const pipelines = new Set(model.containers.filter((c) => c.role === 'pipeline' && c.attachedNodeIds?.[0] === nodeId).map((c) => c.id));
  const gone = new Set(model.nodes.filter((n) => n.id === nodeId || (n.containerId !== undefined && pipelines.has(n.containerId))).map((n) => n.id));
  const nodes = model.nodes.filter((n) => !gone.has(n.id));
  const used = new Set(nodes.map((n) => n.containerId));
  const next: DiagramModel = {
    ...model,
    nodes,
    edges: model.edges.filter((e) => !gone.has(e.sourceId) && !gone.has(e.targetId)),
    containers: model.containers.filter((c) => !pipelines.has(c.id) && (c.role !== 'pipeline' || used.has(c.id))).map((c) => ({ ...c })),
  };
  layOutPipelines(next);
  return next;
}

/** Sets a link's flow arrowhead (`+>` forward, `+<` back, `+<>` both; null = a plain `->` link). A labelled flow
 *  arrow keeps its label. */
export function setWardleyLinkFlow(model: DiagramModel, edgeId: string, flow: WardleyFlow | null): DiagramModel {
  const edge = model.edges.find((e) => e.id === edgeId);
  if (!edge) throw new Error(`setWardleyLinkFlow: there is no link "${edgeId}"`);
  if (flow !== null && !WARDLEY_FLOWS.includes(flow)) throw new Error(`setWardleyLinkFlow: unknown flow "${String(flow)}"`);
  const data = { ...(edge.wardley ?? { arrow: '->' as const }) };
  delete data.fromPort;
  delete data.toPort;
  if (data.flowArrow) {
    if (flow) data.flowArrow = { ...data.flowArrow, flow };
    else {
      delete data.flowArrow;
      data.arrow = '->';
    }
  } else if (flow) {
    // Written `A +> B`, the port taking the arrow's place.
    delete data.arrow;
    data.fromPort = flow;
  } else if (!data.arrow) {
    data.arrow = '->';
  }
  return { ...model, edges: model.edges.map((e) => (e.id === edgeId ? { ...e, wardley: data } : e)) };
}
